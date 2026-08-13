import './helpers/pptRelayEnv.js'

import { describe, it, expect } from 'vitest'
import { InMemoryPptRelayStore } from '../src/ppt/relay/store.js'
import { config } from '../src/config/env.js'
import type { BentoDoc } from '../src/ppt/bentoDoc.js'

/**
 * R4-B1 unit coverage for the relay's durable-store ordering invariants (§7.3):
 * monotonic per-room sequence, `(docId, frameId)` dedup, and atomic-snapshot-
 * then-prune. These underpin PPT-WS-005 (ack/broadcast ordering), PPT-COLLAB-003
 * (snapshot/GC), and PPT-COLLAB-004 (replay ordering).
 */
function deck(): BentoDoc {
  return {
    format: 'bento/slides',
    version: 1,
    docId: 'bento_x',
    title: 'S',
    size: { width: 1280, height: 720 },
    theme: { background: '#fff', color: '#111', accent: '#3366ff', fontFamily: 'Inter' },
    slides: [{ id: 's1', background: '#fff', transition: 'none', elements: [], notes: '' }],
    modified: '2026-01-01T00:00:00.000Z',
  }
}

describe('InMemoryPptRelayStore invariants (§7.3)', () => {
  it('assigns strictly monotonic per-room sequences', async () => {
    const s = new InMemoryPptRelayStore()
    const a = await s.appendOp('d1', 'f1', { t: 'ops', a: 1 })
    const b = await s.appendOp('d1', 'f2', { t: 'ops', a: 2 })
    const c = await s.appendOp('d1', 'f3', { t: 'ops', a: 3 })
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3])
    expect(a.duplicate || b.duplicate || c.duplicate).toBe(false)
    expect(await s.currentSeq('d1')).toBe(3)
  })

  it('sequences are independent per room', async () => {
    const s = new InMemoryPptRelayStore()
    await s.appendOp('d1', 'f1', {})
    const d2 = await s.appendOp('d2', 'f1', {})
    expect(d2.seq).toBe(1)
    expect(await s.currentSeq('d1')).toBe(1)
    expect(await s.currentSeq('d2')).toBe(1)
  })

  it('dedups on (docId, frameId): a resent frame re-uses its original seq, no new row', async () => {
    const s = new InMemoryPptRelayStore()
    const first = await s.appendOp('d1', 'dup', { v: 1 })
    const again = await s.appendOp('d1', 'dup', { v: 1 })
    expect(again.seq).toBe(first.seq)
    expect(again.duplicate).toBe(true)
    expect(await s.currentSeq('d1')).toBe(1) // no second row
  })

  it('opsSince returns only ops after the cursor, ascending', async () => {
    const s = new InMemoryPptRelayStore()
    for (const f of ['f1', 'f2', 'f3']) await s.appendOp('d1', f, { f })
    const tail = await s.opsSince('d1', 1)
    expect(tail.map((o) => o.seq)).toEqual([2, 3])
  })

  it('saveSnapshot advances the version atomically; prune drops only covered ops', async () => {
    const s = new InMemoryPptRelayStore()
    for (const f of ['f1', 'f2', 'f3']) await s.appendOp('d1', f, { f })
    const r1 = await s.saveSnapshot({ docId: 'd1', coveredSeq: 2, doc: deck() })
    expect(r1.snapshotVersion).toBe(1)
    await s.pruneOpsThrough('d1', 2)
    // covered ops (<=2) gone; op 3 survives; currentSeq unchanged.
    expect((await s.opsSince('d1', 0)).map((o) => o.seq)).toEqual([3])
    expect(await s.currentSeq('d1')).toBe(3)

    const snap = await s.getSnapshot('d1')
    expect(snap?.snapshotVersion).toBe(1)
    expect(snap?.coveredSeq).toBe(2)

    const r2 = await s.saveSnapshot({ docId: 'd1', coveredSeq: 3, doc: deck() })
    expect(r2.snapshotVersion).toBe(2)
  })

  it('dedup survives prune: a frame re-sent after its op row is pruned re-acks its original seq, not a fresh one (XIN-1655 C1)', async () => {
    const s = new InMemoryPptRelayStore()
    const first = await s.appendOp('d1', 'frame-1', { v: 1 })
    await s.appendOp('d1', 'frame-2', { v: 2 })
    expect(first.seq).toBe(1)
    // A snapshot covers + prunes seq 1 (its op row is now gone).
    await s.saveSnapshot({ docId: 'd1', coveredSeq: 1, doc: deck() })
    await s.pruneOpsThrough('d1', 1)
    expect((await s.opsSince('d1', 0)).map((o) => o.seq)).toEqual([2]) // seq 1 pruned

    // Re-sending the pruned frameId must re-ack its ORIGINAL seq as a duplicate,
    // never mint a new seq (which would rebroadcast a duplicate of a snapshotted op).
    const resend = await s.appendOp('d1', 'frame-1', { v: 1 })
    expect(resend.duplicate).toBe(true)
    expect(resend.seq).toBe(1)
    expect(await s.currentSeq('d1')).toBe(2) // no new seq minted
  })

  it('ledger retention prune (P1-4 / XIN-1825 P2-2, in-memory parity): a resend OLDER than the retention window is re-minted + rebroadcast, a recent one still re-acks', async () => {
    // The DB store retention-prunes its dedup ledger; the in-memory store must
    // mirror it or the relay-level tests (which run against THIS store) never
    // execute the post-retention resend branch. Drive it with a tiny window.
    const original = config.ppt.relay.ledgerRetentionFrames
    ;(config.ppt.relay as { ledgerRetentionFrames: number }).ledgerRetentionFrames = 2
    try {
      const s = new InMemoryPptRelayStore()
      for (const f of ['f1', 'f2', 'f3', 'f4', 'f5']) await s.appendOp('d1', f, { f })
      // Snapshot covers all 5; the prune reclaims ledger mappings with
      // seq <= coveredSeq - 2 = 3 (f1/f2/f3) and keeps f4/f5 (the recent frames an
      // idempotent resend could still target).
      await s.saveSnapshot({ docId: 'd1', coveredSeq: 5, doc: deck() })
      await s.pruneOpsThrough('d1', 5)

      // f4 is within the window -> still re-acked at its ORIGINAL seq (duplicate).
      const recent = await s.appendOp('d1', 'f4', { f: 'f4' })
      expect(recent.duplicate).toBe(true)
      expect(recent.seq).toBe(4)
      expect(await s.currentSeq('d1')).toBe(5) // no seq minted for a live re-ack

      // f1 fell out of the window -> its mapping was reclaimed, so the resend is a
      // FRESH seq + rebroadcast, NOT a re-ack. (The reducer drops it downstream as a
      // duplicate `op.s <= vv[a]`; here we pin the store's post-retention behavior.)
      const stale = await s.appendOp('d1', 'f1', { f: 'f1' })
      expect(stale.duplicate).toBe(false)
      expect(stale.seq).toBe(6)
      expect(await s.currentSeq('d1')).toBe(6)
    } finally {
      ;(config.ppt.relay as { ledgerRetentionFrames: number }).ledgerRetentionFrames = original
    }
  })
})
