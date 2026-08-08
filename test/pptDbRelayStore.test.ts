import './helpers/pptRelayEnv.js'

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createHash } from 'node:crypto'

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
interface FrameRow { seq: number; payloadHash: string | null }

function payloadHash(frameJson: string): string {
  return createHash('sha256').update(frameJson, 'utf8').digest('hex')
}

function makeDb() {
  const ops = new Map<string, Map<number, OpRow>>() // docId -> seq -> row
  const seqCounter = new Map<string, number>() // docId -> last_seq
  const snapshot = new Map<string, SnapRow>() // docId -> row
  const frames = new Map<string, Map<string, FrameRow>>() // docId -> frameId -> identity (dedup ledger, written at append)
  const snapLocks = new Map<string, Promise<void>>() // docId -> ppt_live_snapshot row-lock queue
  // frames committed but HIDDEN from the non-locking (snapshot) ledger read, to
  // reproduce D1: a resend whose tx opened before the original committed sees no
  // ledger row on the fast-path read, yet the PK insert + FOR UPDATE re-read still
  // catch the duplicate. Key: `${docId}:${frameId}`.
  const hiddenFromSnapshot = new Set<string>()
  // Injected transient lock failures (ER_LOCK_WAIT_TIMEOUT): when > 0, the next
  // non-locking `SELECT seq FROM ppt_collab_frame` (the FIRST statement in an
  // append transaction, before any mutation) throws a lock error and decrements,
  // modelling a lock-wait timeout the store must retry (XIN-1693 P1-5).
  let lockErrorsOnFrameRead = 0
  let lockErrorsOnOpPageRead = 0
  // Every SQL statement executed (via both `query` and `tx.query`), so a test can
  // assert on the exact statements a store method issues (e.g. prune is a DELETE,
  // never an INSERT … SELECT into the ledger).
  const sqlLog: string[] = []

  function dupError(): Error {
    const e = new Error('ER_DUP_ENTRY') as Error & { code: string }
    e.code = 'ER_DUP_ENTRY'
    return e
  }

  function lockError(): Error {
    const e = new Error('ER_LOCK_WAIT_TIMEOUT') as Error & { code: string }
    e.code = 'ER_LOCK_WAIT_TIMEOUT'
    return e
  }

  function route(sql: string, params: unknown[], ctx: { lastInsertId: number }): unknown[] {
    const p = params ?? []
    sqlLog.push(sql)
    if (sql.includes('SET TRANSACTION ISOLATION LEVEL') || sql.includes('START TRANSACTION WITH CONSISTENT SNAPSHOT')) {
      return []
    }
    // ── ppt_collab_frame: append-time dedup authority (survives op prune) ──
    if (sql.includes('ppt_collab_frame')) {
      if (sql.includes('SELECT seq') && sql.includes('FROM ppt_collab_frame')) {
        const [docId, frameId] = p as [string, string]
        const forUpdate = sql.includes('FOR UPDATE')
        // Non-locking read = REPEATABLE-READ snapshot: a hidden-but-committed row is
        // invisible. FOR UPDATE = current read of the live committed map.
        if (!forUpdate) {
          // Inject a transient lock timeout on the fast-path read (before any
          // mutation), so the whole append transaction retries cleanly (P1-5).
          if (lockErrorsOnFrameRead > 0) {
            lockErrorsOnFrameRead--
            throw lockError()
          }
          if (hiddenFromSnapshot.has(`${docId}:${frameId}`)) return []
        }
        const row = frames.get(docId)?.get(frameId)
        return row !== undefined ? [{ seq: row.seq, payload_hash: row.payloadHash }] : []
      }
      if (sql.includes('UPDATE ppt_collab_frame')) {
        if (sql.includes('SET payload_hash')) {
          // Backfill a NULL payload_hash after frame_json verification (P2-d):
          // `SET payload_hash = ? WHERE doc_id = ? AND frame_id = ? AND payload_hash IS NULL`.
          const [hash, docId, frameId] = p as [string, string, string]
          const ledger = frames.get(docId)
          const prev = ledger?.get(frameId)
          if (prev && prev.payloadHash === null) ledger!.set(frameId, { seq: prev.seq, payloadHash: hash })
          return []
        }
        // Repoint a ledger row (P1-1 b op-dup reconciliation): `SET seq = ? WHERE
        // doc_id = ? AND frame_id = ?`.
        const [seq, docId, frameId] = p as [number, string, string]
        const ledger = frames.get(docId)
        const prev = ledger?.get(frameId)
        ledger?.set(frameId, { seq, payloadHash: prev?.payloadHash ?? null })
        return []
      }
      if (sql.includes('INSERT INTO ppt_collab_frame')) {
        const [docId, frameId, seq, hash] = p as [string, string, number, string]
        let ledger = frames.get(docId)
        if (!ledger) { ledger = new Map(); frames.set(docId, ledger) }
        if (ledger.has(frameId)) throw dupError() // (doc_id, frame_id) PRIMARY KEY
        ledger.set(frameId, { seq, payloadHash: hash })
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
      // Return the full row (seq + frame_json) so both the seq-only lookup and
      // the frame_json lookup (NULL-hash verification, P2-d) route here.
      for (const row of room.values()) if (row.frameId === frameId) return [{ seq: row.seq, frame_id: row.frameId, frame_json: row.frameJson }]
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
      if (lockErrorsOnOpPageRead > 0) {
        lockErrorsOnOpPageRead--
        throw lockError()
      }
      const [docId, since] = p as [string, number]
      // XIN-1748 P1-2: the page size is now INLINED into the SQL (`LIMIT <n>`), not
      // bound via `?`, matching this repo's settled remedy for the mysql2
      // prepared-LIMIT bug. Parse it out of the statement text so the fake still
      // pages correctly — and so this fake would surface a `LIMIT ?` regression
      // (an un-inlined limit no longer reaches it as a param) rather than mask it.
      const limitMatch = /LIMIT\s+(\d+)\b/i.exec(sql)
      const limit = limitMatch ? Number(limitMatch[1]) : undefined
      const room = ops.get(docId)
      if (!room) return []
      return [...room.values()]
        .filter((r) => r.seq > since)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit ?? Number.POSITIVE_INFINITY)
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
    /** Inject N transient lock-wait timeouts on the append fast-path read (P1-5). */
    setLockErrorsOnFrameRead: (n: number) => {
      lockErrorsOnFrameRead = n
    },
    setLockErrorsOnOpPageRead: (n: number) => {
      lockErrorsOnOpPageRead = n
    },
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
  getPool: () => ({
    getConnection: async () => ({
      beginTransaction: async () => {},
      execute: async (sql: string, params: unknown[] = []) => [await db.query(sql, params ?? [])],
      // The consistent-snapshot replay path issues its transaction-control
      // statements (and, post-fix, its reads) via the TEXT protocol `conn.query`,
      // since `START TRANSACTION WITH CONSISTENT SNAPSHOT` is rejected on the
      // prepared `execute` path by real MySQL 8 (P1-4). Route it through the same
      // fake so both protocols resolve identically here.
      query: async (sql: string, params: unknown[] = []) => [await db.query(sql, params ?? [])],
      commit: async () => {},
      rollback: async () => {},
      release: () => {},
    }),
  }),
  query: (sql: string, params?: unknown[]) => db.query(sql, params ?? []),
  transaction: (fn: (tx: unknown) => Promise<unknown>) => db.transaction(fn),
}))

import { DbPptRelayStore } from '../src/ppt/relay/dbStore.js'
import { canonicalPayloadHash } from '../src/ppt/relay/store.js'
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

  it('a resent frameId with a different payload is refused instead of re-acked', async () => {
    const store = new DbPptRelayStore()
    await store.appendOp(D, 'dup-payload', { v: 1 })
    expect(db.frames.get(D)?.get('dup-payload')?.payloadHash).toBe(payloadHash('{"v":1}'))
    await expect(store.appendOp(D, 'dup-payload', { v: 2 })).rejects.toMatchObject({
      duplicatePayloadMismatch: true,
    })
    expect(db.ops.get(D)!.size).toBe(1)
    expect(await store.currentSeq(D)).toBe(1)
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
    expect(db.frames.get(D)!.get('frame-1')?.seq).toBe(1) // ledger written at APPEND time
    // Snapshot covers + prunes seq 1: its ppt_collab_op row is physically deleted
    // by a plain DELETE — the ledger mapping is NOT copied, it was already there.
    await store.saveSnapshot({ docId: D, coveredSeq: 1, doc: deck() })
    await store.pruneOpsThrough(D, 1)
    expect([...(db.ops.get(D) ?? new Map()).keys()]).toEqual([2]) // seq 1 gone from op table
    expect(db.frames.get(D)!.get('frame-1')?.seq).toBe(1) // ledger mapping outlives the op row

    // A re-send of the pruned frame must NOT mint a fresh seq (which would
    // rebroadcast a duplicate of an op the snapshot already subsumes).
    const resend = await store.appendOp(D, 'frame-1', { n: 1 })
    expect(resend.duplicate).toBe(true)
    expect(resend.seq).toBe(1) // original seq, from the ledger
    expect(await store.currentSeq(D)).toBe(2) // counter did NOT advance
    expect((db.ops.get(D) ?? new Map()).has(1)).toBe(false) // no resurrected op row
  })

  it('legacy pruned frame identities with NULL payload_hash fail closed instead of wildcard re-acking', async () => {
    const store = new DbPptRelayStore()
    db.frames.set(D, new Map([['legacy-pruned', { seq: 1, payloadHash: null }]]))
    db.seqCounter.set(D, 1)

    await expect(store.appendOp(D, 'legacy-pruned', { n: 2 })).rejects.toMatchObject({
      duplicatePayloadMismatch: true,
    })
    expect(db.ops.get(D)?.size ?? 0).toBe(0)
    expect(await store.currentSeq(D)).toBe(1)
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

describe('DbPptRelayStore — ledger-less resend & transient lock retry (XIN-1693 P1-1 / P1-5)', () => {
  it('P1-1 (b): a resend of a pre-upgrade op row that has NO dedup-ledger row re-acks its original seq, not storage-failed', async () => {
    // Model an already-migrated DB: an op row written by the PREVIOUS deploy exists
    // in ppt_collab_op (with the (doc_id, frame_id) UNIQUE) but the append-time
    // dedup ledger has NO row for it, and the counter is at that seq.
    db.ops.set(D, new Map([[1, { seq: 1, frameId: 'pre', frameJson: '{"v":1}', frameBytes: 8 }]]))
    db.seqCounter.set(D, 1)
    expect(db.frames.get(D)?.get('pre')).toBeUndefined() // no ledger row

    const store = new DbPptRelayStore()
    // Before the fix the op insert (outside the catch) hit the op-table UNIQUE and
    // rolled back -> permanent storage-failed. Now it re-acks the op's original seq.
    const res = await store.appendOp(D, 'pre', { v: 1 })
    expect(res).toMatchObject({ seq: 1, duplicate: true })
    // The ledger row is reconciled to the op's original seq for future resends.
    expect(db.frames.get(D)?.get('pre')?.seq).toBe(1)
  })

  it('P1-1 (b) mismatch: a resend of a pre-upgrade op row with DIFFERENT ops is REFUSED, not blindly re-acked (XIN-1739)', async () => {
    // Same pre-upgrade shape (op row, no ledger), but the resend carries DIFFERENT
    // ops for the same frameId. Before the fix the op-table duplicate fallback
    // re-acked after reading only the seq (`getSeqByFrameIdForUpdateTx`), so a
    // reused frameId with a different payload was blindly acked as a duplicate —
    // silent divergence. The fix reads the stored FRAME and refuses on a canonical
    // payload-hash mismatch. (The transaction ROLLBACK that undoes the ledger row
    // and counter advance is a real-MySQL property covered by the XIN-1740
    // integration suite; the fake does not model rollback.)
    db.ops.set(D, new Map([[1, { seq: 1, frameId: 'pre', frameJson: '{"v":1}', frameBytes: 8 }]]))
    db.seqCounter.set(D, 1)
    expect(db.frames.get(D)?.get('pre')).toBeUndefined() // no ledger row

    const store = new DbPptRelayStore()
    await expect(store.appendOp(D, 'pre', { v: 2 })).rejects.toMatchObject({ duplicatePayloadMismatch: true })
  })

  it('P1-5: a transient lock-wait timeout is retried and the append then succeeds', async () => {
    db.setLockErrorsOnFrameRead(2) // fail twice; the 3rd (final) attempt succeeds
    const store = new DbPptRelayStore()
    const res = await store.appendOp(D, 'f1', { v: 1 })
    expect(res).toMatchObject({ seq: 1, duplicate: false })
    expect(await store.currentSeq(D)).toBe(1) // clean allocate, no burned seq
  })

  it('P1-5: a lock failure that outlives the retries surfaces as a RETRYABLE storage error, not permanent', async () => {
    db.setLockErrorsOnFrameRead(99) // never recovers within the attempt budget
    const store = new DbPptRelayStore()
    await expect(store.appendOp(D, 'f1', { v: 1 })).rejects.toMatchObject({ retryable: true })
  })

  it('P1-4/P1-B: openReplay streams pages from ONE transaction without materializing the tail', async () => {
    const store = new DbPptRelayStore()
    await store.appendOp(D, 'f1', { n: 1 })
    await store.appendOp(D, 'f2', { n: 2 })
    await store.appendOp(D, 'f3', { n: 3 })
    await store.saveSnapshot({ docId: D, coveredSeq: 1, doc: deck() })
    await store.pruneOpsThrough(D, 1)
    db.transaction.mockClear()
    const cursor = await store.openReplay(D, 0, { pageRows: 1, pageBytes: 1_000_000 })
    expect(db.sqlLog.some((s) => s.includes('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'))).toBe(true)
    expect(db.sqlLog.some((s) => s.includes('START TRANSACTION WITH CONSISTENT SNAPSHOT'))).toBe(true)
    expect(cursor.highWater).toBe(3) // durable counter, not MAX(seq) over the pruned table
    expect(cursor.snapshot?.coveredSeq).toBe(1)
    expect((await cursor.nextPage()).map((o) => o.seq)).toEqual([2])
    expect((await cursor.nextPage()).map((o) => o.seq)).toEqual([3])
    expect(await cursor.nextPage()).toEqual([])
    await cursor.close()
    // openReplay holds its own repeatable-read transaction/cursor; legacy
    // readReplay remains for old tests but the relay no longer uses it.
    expect(db.transaction).toHaveBeenCalledTimes(0)

    const view = await store.readReplay(D, 0, 1000)
    expect(view.ops.map((o) => o.seq)).toEqual([2, 3])
  })

  it('P1-D: transient replay page read failures are retried inside nextPage', async () => {
    const store = new DbPptRelayStore()
    await store.appendOp(D, 'f1', { n: 1 })
    db.setLockErrorsOnOpPageRead(2)
    const cursor = await store.openReplay(D, 0, { pageRows: 10, pageBytes: 1_000_000 })
    expect((await cursor.nextPage()).map((o) => o.seq)).toEqual([1])
    await cursor.close()
  })

  it('P1-D: replay page read retry exhaustion is classified retryable', async () => {
    const store = new DbPptRelayStore()
    await store.appendOp(D, 'f1', { n: 1 })
    db.setLockErrorsOnOpPageRead(99)
    const cursor = await store.openReplay(D, 0, { pageRows: 10, pageBytes: 1_000_000 })
    await expect(cursor.nextPage()).rejects.toMatchObject({ retryable: true })
    await cursor.close()
  })
})

describe('DbPptRelayStore — RC round-12 (XIN-1736)', () => {
  const opsFrame = (value: unknown, extra: Record<string, unknown> = {}): unknown => ({
    t: 'ops',
    pv: 2,
    k: 1,
    frameId: 'x',
    epoch: 0,
    ops: [{ kind: 'set', key: 's1e1', prop: 'x', value }],
    ...extra,
  })

  it('P1-A: a resend of the SAME edit after an epoch bump (new epoch/k, reordered keys) re-acks, not refused', async () => {
    const store = new DbPptRelayStore()
    const first = await store.appendOp(D, 'e1', opsFrame(1, { epoch: 0, k: 1 }))
    expect(first.duplicate).toBe(false)
    // Same ops, different transport envelope (the exact resend the pre-fix
    // whole-envelope hash permanently refused as `protocol-version`).
    const resend = { pv: 2, t: 'ops', frameId: 'e1', k: 9, epoch: 5, ops: [{ value: 1, prop: 'x', key: 's1e1', kind: 'set' }] }
    const again = await store.appendOp(D, 'e1', resend)
    expect(again).toMatchObject({ seq: first.seq, duplicate: true })
    expect(db.ops.get(D)!.size).toBe(1)
  })

  it('P1-A: a resend with the SAME frameId but DIFFERENT ops is still refused', async () => {
    const store = new DbPptRelayStore()
    await store.appendOp(D, 'e2', opsFrame(1))
    await expect(store.appendOp(D, 'e2', opsFrame(2))).rejects.toMatchObject({ duplicatePayloadMismatch: true })
  })

  it('P2-d: a NULL-hash ledger row whose op row still exists is verified against frame_json (re-ack + backfill)', async () => {
    const store = new DbPptRelayStore()
    const frame = opsFrame(1)
    db.ops.set(D, new Map([[1, { seq: 1, frameId: 'legacy', frameJson: JSON.stringify(frame), frameBytes: 40 }]]))
    db.seqCounter.set(D, 1)
    db.frames.set(D, new Map([['legacy', { seq: 1, payloadHash: null }]]))
    const res = await store.appendOp(D, 'legacy', frame)
    expect(res).toMatchObject({ seq: 1, duplicate: true })
    // Backfilled so the next resend re-acks on the fast hash path.
    expect(db.frames.get(D)!.get('legacy')!.payloadHash).toBe(canonicalPayloadHash(frame))
  })

  it('P2-d: a NULL-hash ledger row whose op row exists but ops DIFFER is refused (not blindly re-acked)', async () => {
    const store = new DbPptRelayStore()
    db.ops.set(D, new Map([[1, { seq: 1, frameId: 'legacy2', frameJson: JSON.stringify(opsFrame(1)), frameBytes: 40 }]]))
    db.seqCounter.set(D, 1)
    db.frames.set(D, new Map([['legacy2', { seq: 1, payloadHash: null }]]))
    await expect(store.appendOp(D, 'legacy2', opsFrame(2))).rejects.toMatchObject({ duplicatePayloadMismatch: true })
  })

  it('XIN-1750: resolveNullHashReack recomputes the canonical-ops hash from frame_json for the pre-gate re-ack (no mutation gate, no in-memory fake)', async () => {
    const store = new DbPptRelayStore()
    const frame = opsFrame(1)
    // Migrated state: op row present, ledger row nulled by the canonical-ops hash migration.
    db.ops.set(D, new Map([[1, { seq: 1, frameId: 'legacy3', frameJson: JSON.stringify(frame), frameBytes: 40 }]]))
    db.seqCounter.set(D, 1)
    db.frames.set(D, new Map([['legacy3', { seq: 1, payloadHash: null }]]))
    // A NULL-hash row is resolved by recomputing the hash from the stored frame_json
    // — the seq + hash the relay's pre-gate re-ack payload-verifies WITHOUT the gate.
    expect(await store.resolveNullHashReack(D, 'legacy3')).toEqual({ seq: 1, payloadHash: canonicalPayloadHash(frame) })
    // A non-null-hash row is NOT resolved here (it takes the fast frameIdentity path).
    db.frames.set(D, new Map([['legacy3', { seq: 1, payloadHash: canonicalPayloadHash(frame) }]]))
    expect(await store.resolveNullHashReack(D, 'legacy3')).toBeNull()
    // A NULL-hash row whose op row was pruned (no frame_json) fails closed -> null,
    // so the relay caller falls through to the mutation gate + appendOp.
    db.frames.set(D, new Map([['gone', { seq: 2, payloadHash: null }]]))
    expect(await store.resolveNullHashReack(D, 'gone')).toBeNull()
    // An unseen frame -> null.
    expect(await store.resolveNullHashReack(D, 'never')).toBeNull()
  })

  it('P1-G: a byte-bounded replay advances the cursor past EVERY fetched row (no re-fetch of dropped rows)', async () => {
    const store = new DbPptRelayStore()
    for (const n of [1, 2, 3, 4]) await store.appendOp(D, `g${n}`, opsFrame('y'.repeat(60), { frameId: `g${n}` }))
    // Large row cap, tiny byte cap: the pre-fix code fetched all rows, emitted one
    // (byte-bounded), advanced the cursor only past it, and re-SELECTed the rest
    // every page. The fix fetches once and emits byte-by-byte from the buffer.
    const cursor = await store.openReplay(D, 0, { pageRows: 100, pageBytes: 1 })
    db.sqlLog.length = 0
    const seqs: number[] = []
    for (;;) {
      const page = await cursor.nextPage()
      if (page.length === 0) break
      seqs.push(...page.map((o) => o.seq))
    }
    await cursor.close()
    expect(seqs).toEqual([1, 2, 3, 4]) // each op delivered exactly once, in order
    const opPageSelects = db.sqlLog.filter((s) => s.includes('SELECT seq, frame_id, frame_json FROM ppt_collab_op')).length
    expect(opPageSelects).toBeLessThanOrEqual(2) // one batch + one EOF probe; pre-fix re-fetched per row
  })

  it('P1-H: the head read and each op page run in SEPARATE short transactions (no tx held across pages)', async () => {
    const store = new DbPptRelayStore()
    for (const n of [1, 2, 3]) await store.appendOp(D, `h${n}`, opsFrame(n, { frameId: `h${n}` }))
    db.sqlLog.length = 0
    const cursor = await store.openReplay(D, 0, { pageRows: 1, pageBytes: 1_000_000 })
    await cursor.nextPage()
    await cursor.nextPage()
    await cursor.nextPage()
    await cursor.close()
    const starts = db.sqlLog.filter((s) => s.includes('START TRANSACTION WITH CONSISTENT SNAPSHOT')).length
    expect(starts).toBeGreaterThan(1) // pre-fix: exactly one long-held transaction
  })

  it('P1-B: a concurrent snapshot+prune advancing coverage past the cursor makes the next page retryable (no silent skip)', async () => {
    const store = new DbPptRelayStore()
    for (const n of [1, 2, 3, 4, 5]) await store.appendOp(D, `b${n}`, opsFrame(n, { frameId: `b${n}` }))
    const cursor = await store.openReplay(D, 0, { pageRows: 2, pageBytes: 1_000_000 })
    expect((await cursor.nextPage()).map((o) => o.seq)).toEqual([1, 2])
    // A snapshot commits covering seq 4 and prunes 1..4 while we page.
    await store.saveSnapshot({ docId: D, coveredSeq: 4, doc: deck() })
    await store.pruneOpsThrough(D, 4)
    // The next page's fresh snapshot read sees coverage advanced past the cursor
    // (2), so it refuses retryably instead of skipping the now-pruned 3 and 4.
    await expect(cursor.nextPage()).rejects.toMatchObject({ retryable: true })
    await cursor.close()
  })
})
