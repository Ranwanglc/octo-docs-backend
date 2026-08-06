import './helpers/pptRelayEnv.js'

import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * R4-B1 integration coverage for the PRODUCTION store `DbPptRelayStore` (§7.3).
 *
 * The relay's durability defects the GitHub reviewers found all lived in this
 * store, which no test exercised (the relay behavior tests use the in-memory
 * double). This file drives the REAL `DbPptRelayStore` + its repos against a
 * faithful in-memory fake of the four relay tables, mocked at the `db/pool`
 * seam exactly like the other transactional-repo tests (docSceneWrite,
 * shareWritePath). The fake models the parts of MySQL these paths rely on:
 *   · the `ppt_collab_seq` INSERT ... ON DUPLICATE KEY UPDATE counter is a single
 *     ATOMIC statement (so two concurrent first appends allocate DISTINCT seqs);
 *   · `(doc_id, seq)` PRIMARY KEY and `(doc_id, frame_id)` UNIQUE raise
 *     `ER_DUP_ENTRY`;
 *   · the `ppt_live_snapshot` upsert advances the version and guards covered-seq
 *     regression atomically;
 *   · the `ppt_collab_frame` dedup ledger is the APPEND-TIME dedup AUTHORITY:
 *     its `(doc_id, frame_id)` PRIMARY KEY raises `ER_DUP_ENTRY` on a resend, the
 *     non-locking read models a REPEATABLE-READ snapshot (a committed row can be
 *     hidden from it, reproducing the pre-commit-resend interleaving D1), and the
 *     `FOR UPDATE` read is a current read of the live committed map. The prune is a
 *     plain `DELETE` — no copy-into-ledger — so the ledger outlives the op row on
 *     its own (XIN-1655 C1 / XIN-1660 D1-D2).
 * Each `tx.query`/`query` handler runs synchronously, so two overlapping store
 * calls interleave only at `await` boundaries — enough to reproduce the
 * first-writer and first-snapshot races the fixes target.
 */

// ── In-memory fake of the four relay tables ─────────────────────────────────
interface OpRow { seq: number; frameId: string; frameJson: string; frameBytes: number }
interface SnapRow { version: number; covered: number; docJson: string; sha: string; bytes: number }

function makeDb() {
  const ops = new Map<string, Map<number, OpRow>>() // docId -> seq -> row
  const seqCounter = new Map<string, number>() // docId -> last_seq
  const snapshot = new Map<string, SnapRow>() // docId -> row
  const frames = new Map<string, Map<string, number>>() // docId -> frameId -> seq (dedup ledger, written at append)
  const snapLocks = new Map<string, Promise<void>>() // docId -> ppt_live_snapshot row-lock queue
  // frames committed but HIDDEN from the non-locking (snapshot) ledger read, to
  // reproduce D1: a resend whose tx opened before the original committed sees no
  // ledger row on the fast-path read, yet the PK insert + FOR UPDATE re-read still
  // catch the duplicate. Key: `${docId}:${frameId}`.
  const hiddenFromSnapshot = new Set<string>()
  // Every SQL statement executed (via both `query` and `tx.query`), so a test can
  // assert on the exact statements a store method issues (e.g. prune is a DELETE,
  // never an INSERT … SELECT into the ledger).
  const sqlLog: string[] = []

  function dupError(): Error {
    const e = new Error('ER_DUP_ENTRY') as Error & { code: string }
    e.code = 'ER_DUP_ENTRY'
    return e
  }

  function route(sql: string, params: unknown[], ctx: { lastInsertId: number }): unknown[] {
    const p = params ?? []
    sqlLog.push(sql)
    // ── ppt_collab_frame: append-time dedup authority (survives op prune) ──
    if (sql.includes('ppt_collab_frame')) {
      if (sql.includes('SELECT seq FROM ppt_collab_frame')) {
        const [docId, frameId] = p as [string, string]
        const forUpdate = sql.includes('FOR UPDATE')
        // Non-locking read = REPEATABLE-READ snapshot: a hidden-but-committed row is
        // invisible. FOR UPDATE = current read of the live committed map.
        if (!forUpdate && hiddenFromSnapshot.has(`${docId}:${frameId}`)) return []
        const seq = frames.get(docId)?.get(frameId)
        return seq !== undefined ? [{ seq }] : []
      }
      if (sql.includes('INSERT INTO ppt_collab_frame')) {
        const [docId, frameId, seq] = p as [string, string, number]
        let ledger = frames.get(docId)
        if (!ledger) { ledger = new Map(); frames.set(docId, ledger) }
        if (ledger.has(frameId)) throw dupError() // (doc_id, frame_id) PRIMARY KEY
        ledger.set(frameId, seq)
        return []
      }
    }
    // ── ppt_collab_seq: atomic counter allocate ──
    if (sql.includes('INSERT INTO ppt_collab_seq')) {
      const docId = p[0] as string
      const next = (seqCounter.get(docId) ?? 0) + 1
      seqCounter.set(docId, next)
      ctx.lastInsertId = next
      return []
    }
    if (sql.includes('SELECT LAST_INSERT_ID() AS seq')) {
      return [{ seq: ctx.lastInsertId }]
    }
    if (sql.includes('SELECT last_seq FROM ppt_collab_seq')) {
      const docId = p[0] as string
      return seqCounter.has(docId) ? [{ last_seq: seqCounter.get(docId) }] : []
    }
    // ── ppt_collab_op ──
    if (sql.includes('FROM ppt_collab_op WHERE doc_id = ? AND frame_id = ?')) {
      const [docId, frameId] = p as [string, string]
      const room = ops.get(docId)
      if (!room) return []
      for (const row of room.values()) if (row.frameId === frameId) return [{ seq: row.seq }]
      return []
    }
    if (sql.includes('INSERT INTO ppt_collab_op')) {
      const [docId, seq, frameId, frameJson, frameBytes] = p as [string, number, string, string, number]
      let room = ops.get(docId)
      if (!room) { room = new Map(); ops.set(docId, room) }
      if (room.has(seq)) throw dupError() // (doc_id, seq) PK
      for (const row of room.values()) if (row.frameId === frameId) throw dupError() // (doc_id, frame_id) UNIQUE
      room.set(seq, { seq, frameId, frameJson, frameBytes })
      return []
    }
    if (sql.includes('SELECT seq, frame_id, frame_json FROM ppt_collab_op')) {
      const [docId, since] = p as [string, number]
      const room = ops.get(docId)
      if (!room) return []
      return [...room.values()]
        .filter((r) => r.seq > since)
        .sort((a, b) => a.seq - b.seq)
        .map((r) => ({ seq: r.seq, frame_id: r.frameId, frame_json: r.frameJson }))
    }
    if (sql.includes('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM ppt_collab_op')) {
      const room = ops.get(p[0] as string)
      const max = room && room.size ? Math.max(...[...room.keys()]) : 0
      return [{ max_seq: max }]
    }
    if (sql.includes('SUM(frame_bytes)') && sql.includes('seq <= ?')) {
      const [docId, covered] = p as [string, number]
      const room = ops.get(docId)
      const freed = room ? [...room.values()].filter((r) => r.seq <= covered).reduce((s, r) => s + r.frameBytes, 0) : 0
      return [{ freed }]
    }
    if (sql.includes('SUM(frame_bytes)')) {
      const room = ops.get(p[0] as string)
      const total = room ? [...room.values()].reduce((s, r) => s + r.frameBytes, 0) : 0
      return [{ total }]
    }
    if (sql.includes('DELETE FROM ppt_collab_op')) {
      const [docId, covered] = p as [string, number]
      const room = ops.get(docId)
      if (room) for (const seq of [...room.keys()]) if (seq <= covered) room.delete(seq)
      return []
    }
    // ── ppt_live_snapshot: atomic advance with covered-guard ──
    if (sql.includes('INSERT INTO ppt_live_snapshot')) {
      const [docId, covered, docJson, sha, bytes] = p as [string, number, string, string, number]
      const cur = snapshot.get(docId)
      if (!cur) {
        snapshot.set(docId, { version: 1, covered, docJson, sha, bytes })
      } else if (covered >= cur.covered) {
        snapshot.set(docId, { version: cur.version + 1, covered, docJson, sha, bytes })
      } // else: covered regression -> keep row, no version bump (P0-3 guard)
      return []
    }
    if (sql.includes('FROM ppt_live_snapshot')) {
      const cur = snapshot.get(p[0] as string)
      if (!cur) return []
      return [{ snapshot_version: cur.version, covered_seq: cur.covered, doc_json: cur.docJson }]
    }
    throw new Error(`unrouted SQL in fake: ${sql}`)
  }

  return {
    ops,
    seqCounter,
    snapshot,
    frames,
    hiddenFromSnapshot,
    sqlLog,
    query: vi.fn(async (sql: string, params: unknown[] = []) => route(sql, params, { lastInsertId: 0 })),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const ctx = { lastInsertId: 0 }
      // Model the ppt_live_snapshot ROW LOCK: the atomic upsert holds the row's
      // exclusive lock until the tx ends, so a concurrent snapshot upsert on the
      // same doc blocks (and then reads/advances the committed version) rather
      // than racing the read-back. Acquired lazily on the upsert, released at end.
      const held = new Map<string, () => void>()
      const acquire = async (docId: string): Promise<void> => {
        if (held.has(docId)) return
        const prev = snapLocks.get(docId) ?? Promise.resolve()
        let release!: () => void
        const mine = new Promise<void>((r) => (release = r))
        snapLocks.set(docId, prev.then(() => mine))
        await prev
        held.set(docId, release)
      }
      const tx = {
        query: async (sql: string, params: unknown[] = []) => {
          if (sql.includes('INSERT INTO ppt_live_snapshot')) await acquire(params[0] as string)
          return route(sql, params, ctx)
        },
      }
      try {
        return await fn(tx)
      } finally {
        for (const release of held.values()) release()
      }
    }),
  }
}

let db: ReturnType<typeof makeDb>
vi.mock('../src/db/pool.js', () => ({
  query: (sql: string, params?: unknown[]) => db.query(sql, params ?? []),
  transaction: (fn: (tx: unknown) => Promise<unknown>) => db.transaction(fn),
}))

import { DbPptRelayStore } from '../src/ppt/relay/dbStore.js'
import type { BentoDoc } from '../src/ppt/bentoDoc.js'

function deck(title = 'S'): BentoDoc {
  return {
    format: 'bento/slides',
    version: 1,
    docId: 'bento_x',
    title,
    size: { width: 1280, height: 720 },
    theme: { background: '#fff', color: '#111', accent: '#3366ff', fontFamily: 'Inter' },
    slides: [{ id: 's1', background: '#fff', transition: 'none', elements: [], notes: '' }],
    modified: '2026-01-01T00:00:00.000Z',
  }
}

const D = 'd1'
beforeEach(() => {
  db = makeDb()
})

describe('DbPptRelayStore — append monotonicity & first-writer race (B1 / P0-2)', () => {
  it('two concurrent first writers persist at DISTINCT seqs, neither refused', async () => {
    const store = new DbPptRelayStore()
    const [a, b] = await Promise.all([
      store.appendOp(D, 'f1', { t: 'ops', ops: [{ kind: 'set' }] }),
      store.appendOp(D, 'f2', { t: 'ops', ops: [{ kind: 'set' }] }),
    ])
    expect(a.duplicate).toBe(false)
    expect(b.duplicate).toBe(false)
    expect(new Set([a.seq, b.seq])).toEqual(new Set([1, 2])) // distinct, no PK collision
    expect(await store.currentSeq(D)).toBe(2)
  })

  it('a resent frameId re-acks its original seq without a second row', async () => {
    const store = new DbPptRelayStore()
    const first = await store.appendOp(D, 'dup', { v: 1 })
    const again = await store.appendOp(D, 'dup', { v: 1 })
    expect(again.duplicate).toBe(true)
    expect(again.seq).toBe(first.seq)
    expect(db.ops.get(D)!.size).toBe(1)
  })

  it('concurrent resend of the SAME frameId: one persists, the other re-acks (no permanent storage-failed)', async () => {
    const store = new DbPptRelayStore()
    const [a, b] = await Promise.all([
      store.appendOp(D, 'same', { v: 1 }),
      store.appendOp(D, 'same', { v: 1 }),
    ])
    expect(a.seq).toBe(b.seq) // both resolve to the one persisted seq
    expect(a.duplicate !== b.duplicate).toBe(true) // exactly one is the winner
    expect(db.ops.get(D)!.size).toBe(1) // only one row for the frameId
  })

  it('sequence does NOT regress after a full-coverage snapshot prunes every op (P0-2)', async () => {
    const store = new DbPptRelayStore()
    await store.appendOp(D, 'f1', { n: 1 })
    await store.appendOp(D, 'f2', { n: 2 })
    await store.appendOp(D, 'f3', { n: 3 })
    await store.saveSnapshot({ docId: D, coveredSeq: 3, doc: deck() })
    await store.pruneOpsThrough(D, 3) // op table now empty
    expect(db.ops.get(D)!.size).toBe(0)
    // A MAX(seq)+1 scheme would hand out 1 again here; the durable counter does not.
    const next = await store.appendOp(D, 'f4', { n: 4 })
    expect(next.seq).toBe(4)
    expect(await store.currentSeq(D)).toBe(4)
  })

  it('opsSince returns only the tail after the cursor, ascending', async () => {
    const store = new DbPptRelayStore()
    for (const f of ['f1', 'f2', 'f3']) await store.appendOp(D, f, { f })
    expect((await store.opsSince(D, 1)).map((o) => o.seq)).toEqual([2, 3])
  })

  it('dedup survives prune via the ppt_collab_frame ledger: resend a pruned frameId -> re-acked at its ORIGINAL seq, not re-minted (C1)', async () => {
    const store = new DbPptRelayStore()
    const first = await store.appendOp(D, 'frame-1', { n: 1 })
    await store.appendOp(D, 'frame-2', { n: 2 })
    expect(first.seq).toBe(1)
    expect(db.frames.get(D)!.get('frame-1')).toBe(1) // ledger written at APPEND time
    // Snapshot covers + prunes seq 1: its ppt_collab_op row is physically deleted
    // by a plain DELETE — the ledger mapping is NOT copied, it was already there.
    await store.saveSnapshot({ docId: D, coveredSeq: 1, doc: deck() })
    await store.pruneOpsThrough(D, 1)
    expect([...(db.ops.get(D) ?? new Map()).keys()]).toEqual([2]) // seq 1 gone from op table
    expect(db.frames.get(D)!.get('frame-1')).toBe(1) // ledger mapping outlives the op row

    // A re-send of the pruned frame must NOT mint a fresh seq (which would
    // rebroadcast a duplicate of an op the snapshot already subsumes).
    const resend = await store.appendOp(D, 'frame-1', { n: 1 })
    expect(resend.duplicate).toBe(true)
    expect(resend.seq).toBe(1) // original seq, from the ledger
    expect(await store.currentSeq(D)).toBe(2) // counter did NOT advance
    expect((db.ops.get(D) ?? new Map()).has(1)).toBe(false) // no resurrected op row
  })

  it('D1: a resend whose fast-path ledger read misses the pre-commit snapshot still re-acks the ORIGINAL seq (append-time PK authority), never re-mints/rebroadcasts', async () => {
    const store = new DbPptRelayStore()
    // Original append commits frame-1 at seq 1 (ledger frame-1 -> 1, op row 1).
    const first = await store.appendOp(D, 'frame-1', { n: 1 })
    expect(first.seq).toBe(1)
    expect(first.duplicate).toBe(false)

    // Model the D1 interleaving: the resend's transaction opened BEFORE the
    // original committed, so under REPEATABLE READ its NON-locking ledger read
    // sees no frame-1 row (hidden from the snapshot). The old code deduped only via
    // such snapshot reads -> it minted a fresh seq and rebroadcast a duplicate. Now
    // the ledger PK insert raises ER_DUP_ENTRY and the FOR UPDATE re-read (a current
    // read, NOT hidden) returns the committed seq.
    db.hiddenFromSnapshot.add(`${D}:frame-1`)
    const resend = await store.appendOp(D, 'frame-1', { n: 1 })
    expect(resend.duplicate).toBe(true) // NOT a fresh, rebroadcastable op
    expect(resend.seq).toBe(1) // re-acked at the original seq
    expect(db.ops.get(D)!.size).toBe(1) // no second op row minted
  })

  it('D2: prune is a plain DELETE (no INSERT … SELECT into the ledger), so it does not lock the gap above coveredSeq that a concurrent append needs', async () => {
    const store = new DbPptRelayStore()
    for (const f of ['f1', 'f2', 'f3']) await store.appendOp(D, f, { f })
    await store.saveSnapshot({ docId: D, coveredSeq: 2, doc: deck() })

    // The prune executes only a freed-bytes SUM and a DELETE — never the old
    // `INSERT IGNORE … SELECT ppt_collab_op` whose shared next-key locks over the
    // gap above coveredSeq blocked a concurrent append there (ER_LOCK_WAIT_TIMEOUT).
    db.sqlLog.length = 0
    const [freed, appended] = await Promise.all([
      store.pruneOpsThrough(D, 2),
      store.appendOp(D, 'f4', { f: 'f4' }), // append ABOVE the pruned range, concurrently
    ])
    expect(db.sqlLog.some((s) => s.includes('DELETE FROM ppt_collab_op'))).toBe(true)
    expect(db.sqlLog.some((s) => s.includes('INSERT IGNORE INTO ppt_collab_frame'))).toBe(false)
    expect(db.sqlLog.some((s) => s.includes('INSERT INTO ppt_collab_frame') && s.includes('SELECT'))).toBe(false)

    // Both complete: covered ops (<=2) pruned, the concurrent higher append survives.
    expect(freed).toBeGreaterThan(0)
    expect(appended.duplicate).toBe(false)
    expect(appended.seq).toBe(4)
    expect([...db.ops.get(D)!.keys()].sort((a, b) => a - b)).toEqual([3, 4])
  })

  it('frameSeq reads the ledger for the relay pre-gate dedup lookup (D3)', async () => {
    const store = new DbPptRelayStore()
    await store.appendOp(D, 'frame-1', { n: 1 })
    expect(await store.frameSeq(D, 'frame-1')).toBe(1)
    expect(await store.frameSeq(D, 'never-seen')).toBeNull()
    // Survives prune: the mapping outlives the op row.
    await store.saveSnapshot({ docId: D, coveredSeq: 1, doc: deck() })
    await store.pruneOpsThrough(D, 1)
    expect(await store.frameSeq(D, 'frame-1')).toBe(1)
  })
})

describe('DbPptRelayStore — snapshot version atomicity (B2 / P0-3)', () => {
  it('two concurrent first snapshots ack DISTINCT versions (no same-version overwrite)', async () => {
    const store = new DbPptRelayStore()
    await store.appendOp(D, 'f1', { n: 1 })
    const [r1, r2] = await Promise.all([
      store.saveSnapshot({ docId: D, coveredSeq: 1, doc: deck('A') }),
      store.saveSnapshot({ docId: D, coveredSeq: 1, doc: deck('B') }),
    ])
    expect(new Set([r1.snapshotVersion, r2.snapshotVersion])).toEqual(new Set([1, 2]))
    expect(db.snapshot.get(D)!.version).toBe(2)
  })

  it('a snapshot that covers LESS than the current one neither rewinds coverage nor bumps the version (P0-3)', async () => {
    const store = new DbPptRelayStore()
    for (const f of ['f1', 'f2', 'f3']) await store.appendOp(D, f, { f })
    const hi = await store.saveSnapshot({ docId: D, coveredSeq: 3, doc: deck('hi') })
    expect(hi.snapshotVersion).toBe(1)
    const lo = await store.saveSnapshot({ docId: D, coveredSeq: 1, doc: deck('lo') })
    expect(lo.snapshotVersion).toBe(1) // no advance for a regressing covered
    const snap = await store.getSnapshot(D)
    expect(snap!.coveredSeq).toBe(3) // coverage did not rewind
    expect(snap!.snapshotVersion).toBe(1)
  })

  it('prune-after-durable reclaims bytes and getSnapshot reflects the latest save', async () => {
    const store = new DbPptRelayStore()
    const a = await store.appendOp(D, 'f1', { n: 1 })
    const b = await store.appendOp(D, 'f2', { n: 2 })
    const total = a.frameBytes + b.frameBytes
    expect(await store.roomBytes(D)).toBe(total)
    await store.saveSnapshot({ docId: D, coveredSeq: 1, doc: deck() })
    const freed = await store.pruneOpsThrough(D, 1)
    expect(freed).toBe(a.frameBytes)
    expect(await store.roomBytes(D)).toBe(b.frameBytes)
    const snap = await store.getSnapshot(D)
    expect(snap!.coveredSeq).toBe(1)
    expect((await store.opsSince(D, 0)).map((o) => o.seq)).toEqual([2])
  })
})
