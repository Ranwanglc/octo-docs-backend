import './helpers/pptRelayEnv.js'

import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * R4-B1 integration coverage for the PRODUCTION store `DbPptRelayStore` (§7.3).
 *
 * The relay's durability defects the GitHub reviewers found all lived in this
 * store, which no test exercised (the relay behavior tests use the in-memory
 * double). This file drives the REAL `DbPptRelayStore` + its repos against a
 * faithful in-memory fake of the three relay tables, mocked at the `db/pool`
 * seam exactly like the other transactional-repo tests (docSceneWrite,
 * shareWritePath). The fake models the parts of MySQL these paths rely on:
 *   · the `ppt_collab_seq` INSERT ... ON DUPLICATE KEY UPDATE counter is a single
 *     ATOMIC statement (so two concurrent first appends allocate DISTINCT seqs);
 *   · `(doc_id, seq)` PRIMARY KEY and `(doc_id, frame_id)` UNIQUE raise
 *     `ER_DUP_ENTRY`;
 *   · the `ppt_live_snapshot` upsert advances the version and guards covered-seq
 *     regression atomically.
 * Each `tx.query`/`query` handler runs synchronously, so two overlapping store
 * calls interleave only at `await` boundaries — enough to reproduce the
 * first-writer and first-snapshot races the fixes target.
 */

// ── In-memory fake of the three relay tables ────────────────────────────────
interface OpRow { seq: number; frameId: string; frameJson: string; frameBytes: number }
interface SnapRow { version: number; covered: number; docJson: string; sha: string; bytes: number }

function makeDb() {
  const ops = new Map<string, Map<number, OpRow>>() // docId -> seq -> row
  const seqCounter = new Map<string, number>() // docId -> last_seq
  const snapshot = new Map<string, SnapRow>() // docId -> row
  const snapLocks = new Map<string, Promise<void>>() // docId -> ppt_live_snapshot row-lock queue

  function dupError(): Error {
    const e = new Error('ER_DUP_ENTRY') as Error & { code: string }
    e.code = 'ER_DUP_ENTRY'
    return e
  }

  function route(sql: string, params: unknown[], ctx: { lastInsertId: number }): unknown[] {
    const p = params ?? []
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
