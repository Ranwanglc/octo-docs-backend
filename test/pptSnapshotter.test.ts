/**
 * Server-side snapshotter (XIN-1759 Part B / XIN-1758 / XIN-1764 Option 2):
 * deterministic Bento reduction, the convergence invariant, prune-only-after-durable,
 * room-byte reclaim, and version alignment (Jeff #1). Uses the SHARED golden
 * fixtures (Jeff #2) and the in-memory store, which enforces the same
 * atomic-snapshot-then-prune + monotonic-seq invariants as the DB store.
 */
import { describe, it, expect, vi } from 'vitest'
import { InMemoryPptRelayStore } from '../src/ppt/relay/store.js'
import { PptSnapshotter, reduceFrames, assertSyncVersionAligned, SNAPSHOT_REDUCER_ACTOR } from '../src/ppt/relay/snapshotter.js'
import { SYNC_V, SyncState } from '../src/ppt/sync/slidesSync.js'
import { BENTO_SYNC_V, type BentoDoc } from '../src/ppt/bentoDoc.js'
import { buildGoldenFixtures, genesisDeck, type GoldenFrame } from './fixtures/bentoGolden.js'

const DOC = 'doc-snap'

/** Deep structural clone (docs/ops are plain JSON by contract). */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

/** Read an arbitrary string prop off the first element (for the gap-scenario asserts). */
function firstElProp(doc: unknown, key: string): unknown {
  return (doc as { slides: Array<{ elements: Array<Record<string, unknown>> }> }).slides[0]!.elements[0]![key]
}

/** Persist the fixture's genesis as the base doc via a baseDocProvider seam. */
function baseDocProviderFor(doc: BentoDoc) {
  return async () => doc
}

/** Append a golden frame to the store as a persisted ops frame `{t:'ops',...,ops}`. */
async function seedFrames(store: InMemoryPptRelayStore, frames: GoldenFrame[]): Promise<void> {
  for (const f of frames) {
    await store.appendOp(DOC, f.frameId, { t: 'ops', pv: 2, k: f.q, frameId: f.frameId, epoch: 0, ops: f.ops })
  }
}

describe('PptSnapshotter: version alignment (Jeff #1)', () => {
  it('vendored engine SYNC_V matches backend BENTO_SYNC_V', () => {
    expect(SYNC_V).toBe(BENTO_SYNC_V)
    expect(() => assertSyncVersionAligned()).not.toThrow()
  })
})

describe('PptSnapshotter: deterministic reduction + convergence invariant', () => {
  for (const fx of buildGoldenFixtures()) {
    it(`[${fx.name}] full-log reduction is deterministic and reproducible`, () => {
      const a = reduceFrames(fx.genesis, null, fx.frames.map((f) => ({ seq: f.q, ops: f.ops })))
      const b = reduceFrames(fx.genesis, null, fx.frames.map((f) => ({ seq: f.q, ops: f.ops })))
      expect(a).toEqual(b)
      expect(a).toEqual(fx.expected)
    })

    it(`[${fx.name}] snapshot@N + tail == full-log reduction (convergence invariant)`, () => {
      const N = fx.snapshotAt
      const head = fx.frames.filter((f) => f.q <= N)
      const tail = fx.frames.filter((f) => f.q > N)
      const snap = reduceFrames(fx.genesis, null, head.map((f) => ({ seq: f.q, ops: f.ops })))
      const viaTail = reduceFrames(snap.doc, snap.state, tail.map((f) => ({ seq: f.q, ops: f.ops })))
      expect(viaTail).toEqual(fx.expected)
    })
  }
})

describe('PptSnapshotter.advance: durable-before-prune + room-byte reclaim', () => {
  it('reduces the op tail, persists (doc,state,coveredSeq), then prunes and reclaims bytes', async () => {
    const store = new InMemoryPptRelayStore()
    const fx = buildGoldenFixtures()[1]! // insert-slide-and-elements
    await seedFrames(store, fx.frames)
    const bytesBefore = await store.roomBytes(DOC)
    expect(bytesBefore).toBeGreaterThan(0)
    expect(await store.currentSeq(DOC)).toBe(fx.frames.length)

    const snapshotter = new PptSnapshotter(store)
    const res = await snapshotter.advance(DOC, baseDocProviderFor(fx.genesis))
    expect(res).not.toBeNull()
    expect(res!.coveredSeq).toBe(fx.frames.length)

    // Snapshot is durable with BOTH doc and state at the covered seq.
    const snap = await store.getSnapshot(DOC)
    expect(snap).not.toBeNull()
    expect(snap!.coveredSeq).toBe(fx.frames.length)
    expect(snap!.state).not.toBeNull()
    // The persisted doc equals the full-log reduction (convergence).
    expect(snap!.doc).toEqual(fx.expected.doc)
    expect(snap!.state).toEqual(fx.expected.state)

    // Ops through coveredSeq are pruned and the room budget reclaimed.
    expect(await store.opsSince(DOC, 0)).toHaveLength(0)
    expect(await store.roomBytes(DOC)).toBe(0)
    expect(res!.freedBytes).toBe(bytesBefore)
  })

  it('a late joiner replaying snapshot+tail matches the full-log reduction', async () => {
    const store = new InMemoryPptRelayStore()
    const fx = buildGoldenFixtures()[3]! // text-rga-edits
    // Persist only the first N frames, snapshot, then append the tail.
    const N = fx.snapshotAt
    await seedFrames(store, fx.frames.filter((f) => f.q <= N))
    const snapshotter = new PptSnapshotter(store)
    await snapshotter.advance(DOC, baseDocProviderFor(fx.genesis))
    // Tail arrives AFTER the snapshot; its seqs continue past coveredSeq.
    for (const f of fx.frames.filter((f) => f.q > N)) {
      await store.appendOp(DOC, f.frameId, { t: 'ops', pv: 2, k: f.q, frameId: f.frameId, epoch: 0, ops: f.ops })
    }
    const snap = await store.getSnapshot(DOC)
    const tail = (await store.opsSince(DOC, snap!.coveredSeq)).map((o) => ({ seq: o.seq, ops: (o.frame as { ops: never[] }).ops }))
    const joiner = reduceFrames(snap!.doc, snap!.state, tail)
    expect(joiner).toEqual(fx.expected)
  })

  it('is a no-op when there is nothing above the current coverage', async () => {
    const store = new InMemoryPptRelayStore()
    const fx = buildGoldenFixtures()[0]!
    await seedFrames(store, fx.frames)
    const snapshotter = new PptSnapshotter(store)
    expect(await snapshotter.advance(DOC, baseDocProviderFor(fx.genesis))).not.toBeNull()
    // Second run: coverage already at high-water → nothing to do.
    expect(await snapshotter.advance(DOC, baseDocProviderFor(fx.genesis))).toBeNull()
  })

  it('returns null (no snapshot) when no base doc is available and none exists yet', async () => {
    const store = new InMemoryPptRelayStore()
    const fx = buildGoldenFixtures()[0]!
    await seedFrames(store, fx.frames)
    const snapshotter = new PptSnapshotter(store)
    expect(await snapshotter.advance(DOC, undefined)).toBeNull()
    // The op log is untouched (no prune without a durable snapshot).
    expect(await store.opsSince(DOC, 0)).toHaveLength(fx.frames.length)
  })

  it('never prunes when saveSnapshot fails (durable-before-prune)', async () => {
    const fx = buildGoldenFixtures()[0]!
    class FailingSave extends InMemoryPptRelayStore {
      pruned = false
      async saveSnapshot(): ReturnType<InMemoryPptRelayStore['saveSnapshot']> {
        throw new Error('save down')
      }
      async pruneOpsThrough(docId: string, coveredSeq: number): Promise<number> {
        this.pruned = true
        return super.pruneOpsThrough(docId, coveredSeq)
      }
    }
    const store = new FailingSave()
    await seedFrames(store, fx.frames)
    const snapshotter = new PptSnapshotter(store)
    await expect(snapshotter.advance(DOC, baseDocProviderFor(fx.genesis))).rejects.toThrow('save down')
    expect(store.pruned).toBe(false)
    expect(await store.opsSince(DOC, 0)).toHaveLength(fx.frames.length)
  })

  // XIN-1770 regression: a LEGACY doc-only snapshot (`state === null`, written
  // before Part B added the state column) must NEVER be compacted + pruned by the
  // snapshotter. reduceFrames would re-`adopt` the materialized doc as a genesis,
  // minting fresh Bento RGA/text generations the tail's `txt` op no longer
  // addresses — silently dropping the edit and producing a doc that diverges from
  // the full-log reduction (`<p>hello brave new world</p>` instead of
  // `<p>hello new world</p>`), then pruning the tail op that proves it wrong.
  // On the buggy head (5072810b) `advance` returns a non-null result and prunes;
  // the fix refuses (returns null) and leaves the boundary + tail intact.
  it('refuses to advance/prune a legacy doc-only snapshot (state===null) and never loses the txt tail', async () => {
    const store = new InMemoryPptRelayStore()
    const fx = buildGoldenFixtures()[3]! // text-rga-edits: hello world -> ... -> hello new world
    const N = fx.snapshotAt // 2
    const head = fx.frames.filter((f) => f.q <= N)
    const tailFrames = fx.frames.filter((f) => f.q > N)
    expect(tailFrames.length).toBeGreaterThan(0)

    // Materialize the head-only reduction, then persist it as a LEGACY row: doc
    // present, state deliberately NULL — exactly the shape the upgrade migration
    // leaves a pre-Part-B row in. Seeding the head first advances the store's room
    // seq to N so the tail lands at seq > coveredSeq (the head ops are then pruned,
    // mirroring a boundary whose covered ops were GC'd pre-migration).
    await seedFrames(store, head)
    const headReduction = reduceFrames(fx.genesis, null, head.map((f) => ({ seq: f.q, ops: f.ops })))
    const htmlOf = (doc: unknown): string =>
      ((doc as { slides: Array<{ elements: Array<{ html?: string }> }> }).slides[0].elements[0].html ?? '')
    expect(htmlOf(headReduction.doc)).toBe('<p>hello brave new world</p>')
    await store.saveSnapshot({ docId: DOC, coveredSeq: N, doc: headReduction.doc, state: null })
    await store.pruneOpsThrough(DOC, N)

    // The head ops were pruned; only the tail remains durable, at seq > N.
    await seedFrames(store, tailFrames)
    const tailSeqBefore = (await store.opsSince(DOC, N)).map((o) => o.seq)
    expect(tailSeqBefore.length).toBe(tailFrames.length)

    const snapBefore = await store.getSnapshot(DOC)
    const snapshotter = new PptSnapshotter(store)
    const res = await snapshotter.advance(DOC, baseDocProviderFor(fx.genesis))

    // (a) The snapshotter REFUSES to advance the un-reconstructable boundary.
    expect(res).toBeNull()

    // The legacy snapshot is untouched — no corrupt doc, no version bump, still
    // doc-only. Critically it was NOT rewritten to the divergent
    // `<p>hello brave new world</p>` a fresh-adopt reduction would have produced.
    const snapAfter = await store.getSnapshot(DOC)
    expect(snapAfter!.snapshotVersion).toBe(snapBefore!.snapshotVersion)
    expect(snapAfter!.coveredSeq).toBe(N)
    expect(snapAfter!.state).toBeNull()
    expect(snapAfter!.doc).toEqual(snapBefore!.doc)

    // The txt tail op is NEVER pruned — the boundary the snapshot could not
    // faithfully reduce keeps its ops so a doc-only replay stays correct.
    const tailSeqAfter = (await store.opsSince(DOC, N)).map((o) => o.seq)
    expect(tailSeqAfter).toEqual(tailSeqBefore)
  })
})

describe('reduceFrames: reserved reducer actor', () => {
  it('applies ops from every client actor (never skips them as "own")', () => {
    // If the reducer actor collided with a client actor, applyOne would drop that
    // client's ops. The reserved @relay actor guarantees all client ops apply.
    const genesis = genesisDeck()
    const fx = buildGoldenFixtures()[0]!
    const out = reduceFrames(genesis, null, fx.frames.map((f) => ({ seq: f.q, ops: f.ops })))
    expect(SNAPSHOT_REDUCER_ACTOR.startsWith('@')).toBe(true)
    // The title set op (from u-author) took effect — proving the op was applied.
    expect((out.doc as unknown as { title: string }).title).toBe('Renamed deck')
  })
})

// XIN-1772 P0-1: a persisted tail with a per-actor `s` GAP — actor u-b's s=2 op
// commits while its s=1 op was refused/never persisted (the relay validates each
// frame's `s` only as a bounded positive int, so a higher-`s` frame can land before a
// lower one). The vendored engine BUFFERS an op whose `s > seen+1` and never applies
// it, and `toJSON` serializes NEITHER `gap` NOR `pending`. On the buggy head
// (71661ef) the snapshotter folds the tail up to the room high-water (a state WITHOUT
// the buffered mutation), saves, and prunes the op row — so the acked-durable s=2
// write is destroyed from BOTH the persisted state AND the op log. Multi-actor by
// construction (u-a applies while u-b is gapped): the single-actor golden fixtures
// cannot express this, which is why the golden-based review missed it.
describe('PptSnapshotter.advance: per-actor s gap is never both dropped-from-state and pruned (XIN-1772 P0-1)', () => {
  function mintGapScenario() {
    const genesis = genesisDeck()
    // u-a: one normal, applyable op (a title set).
    const A = new SyncState('u-a')
    A.adopt(genesis)
    const a0 = clone(genesis)
    const a1 = clone(a0)
    ;(a1 as unknown as { title: string }).title = 'Renamed by A'
    const aOps = A.diff(a0, a1, { text: true })
    // u-b: s=1 (a `stroke` set) then s=2 (a DIFFERENT observable `fill` set). Only s=2
    // is persisted below → a per-actor gap at the snapshot boundary.
    const B = new SyncState('u-b')
    B.adopt(genesis)
    const b0 = clone(genesis)
    const b1 = clone(b0)
    ;(b1.slides[0]!.elements[0] as Record<string, unknown>).stroke = 'thin'
    const bOps1 = B.diff(b0, b1, { text: true })
    const b2 = clone(b1)
    ;(b2.slides[0]!.elements[0] as Record<string, unknown>).fill = 'BLUE-S2'
    const bOps2 = B.diff(b1, b2, { text: true })
    expect(aOps.length).toBeGreaterThan(0)
    expect(bOps1.length).toBeGreaterThan(0)
    expect(bOps2.length).toBeGreaterThan(0)
    return { genesis, aOps, bOps1, bOps2 }
  }

  it('never prunes a buffered per-actor-gap op nor claims to cover it in state', async () => {
    const { genesis, aOps, bOps2 } = mintGapScenario()
    const store = new InMemoryPptRelayStore()
    // Persist u-a s=1 (applies) at seq 1, and u-b s=2 (a gap) at seq 2. u-b's s=1 is
    // NEVER persisted, so the reducer buffers the s=2 op unapplied.
    await store.appendOp(DOC, 'a-1', { t: 'ops', pv: 2, k: 1, frameId: 'a-1', epoch: 0, ops: aOps })
    await store.appendOp(DOC, 'b-2', { t: 'ops', pv: 2, k: 2, frameId: 'b-2', epoch: 0, ops: bOps2 })
    expect((await store.opsSince(DOC, 0)).map((o) => o.seq)).toEqual([1, 2])

    const res = await new PptSnapshotter(store).advance(DOC, baseDocProviderFor(genesis))

    // The buffered gap op's row (seq 2) is NEVER pruned — it is the only durable proof
    // of the s=2 write, kept for a later fill.
    expect((await store.opsSince(DOC, 0)).map((o) => o.seq)).toContain(2)
    // And no snapshot claims to cover seq >= 2 while omitting the mutation from state.
    const snap = await store.getSnapshot(DOC)
    const coversGap = (snap?.coveredSeq ?? 0) >= 2
    const stateHasMutation = snap ? firstElProp(snap.doc, 'fill') === 'BLUE-S2' : false
    expect(coversGap && !stateHasMutation).toBe(false)
    // The applied prefix (u-a's title, seq 1) may still be compacted forward.
    if (res && snap) {
      expect(snap.coveredSeq).toBeLessThan(2)
      expect((snap.doc as unknown as { title: string }).title).toBe('Renamed by A')
    }
  })

  it('applies the gap op once its missing lower-s op is later persisted (recoverable, no loss)', async () => {
    const { genesis, aOps, bOps1, bOps2 } = mintGapScenario()
    const store = new InMemoryPptRelayStore()
    await store.appendOp(DOC, 'a-1', { t: 'ops', pv: 2, k: 1, frameId: 'a-1', epoch: 0, ops: aOps })
    await store.appendOp(DOC, 'b-2', { t: 'ops', pv: 2, k: 2, frameId: 'b-2', epoch: 0, ops: bOps2 })
    const snapshotter = new PptSnapshotter(store)
    await snapshotter.advance(DOC, baseDocProviderFor(genesis))
    // The missing u-b s=1 finally lands (seq 3) — the gap can now fill.
    await store.appendOp(DOC, 'b-1', { t: 'ops', pv: 2, k: 3, frameId: 'b-1', epoch: 0, ops: bOps1 })
    const res = await snapshotter.advance(DOC, baseDocProviderFor(genesis))

    expect(res).not.toBeNull()
    const snap = await store.getSnapshot(DOC)
    // Both u-b writes are now materialized in the persisted state — nothing was lost.
    expect(firstElProp(snap!.doc, 'fill')).toBe('BLUE-S2')
    expect(firstElProp(snap!.doc, 'stroke')).toBe('thin')
    expect(snap!.coveredSeq).toBe(3)
  })
})

// XIN-1772 P1-1: `state === null` is not the only un-reducible boundary. A persisted
// state at a DIFFERENT SYNC_V restores as an EMPTY engine (crdt.ts fromJSON returns a
// bare engine on version mismatch), so reducing the tail against it silently produces
// the same fresh-adopt divergence as the doc-only case, then prunes the tail that
// proves it wrong. The fix refuses to advance such a boundary, exactly like a legacy
// doc-only row.
describe('PptSnapshotter.advance: refuses a version-drifted persisted state (XIN-1772 P1-1)', () => {
  it('treats a snapshot state at v !== SYNC_V like a legacy boundary (no advance, no tail prune)', async () => {
    const store = new InMemoryPptRelayStore()
    const fx = buildGoldenFixtures()[3]! // text-rga-edits
    const N = fx.snapshotAt
    const head = fx.frames.filter((f) => f.q <= N)
    const tailFrames = fx.frames.filter((f) => f.q > N)
    expect(tailFrames.length).toBeGreaterThan(0)
    await seedFrames(store, head)
    const headReduction = reduceFrames(fx.genesis, null, head.map((f) => ({ seq: f.q, ops: f.ops })))
    // A state row written by a DIFFERENT engine build: version does not match SYNC_V.
    const drifted = { ...headReduction.state, v: SYNC_V + 1 }
    await store.saveSnapshot({ docId: DOC, coveredSeq: N, doc: headReduction.doc, state: drifted })
    await store.pruneOpsThrough(DOC, N)
    await seedFrames(store, tailFrames)
    const tailBefore = (await store.opsSince(DOC, N)).map((o) => o.seq)
    const snapBefore = await store.getSnapshot(DOC)

    const res = await new PptSnapshotter(store).advance(DOC, baseDocProviderFor(fx.genesis))

    expect(res).toBeNull()
    const snapAfter = await store.getSnapshot(DOC)
    expect(snapAfter!.snapshotVersion).toBe(snapBefore!.snapshotVersion)
    expect(snapAfter!.coveredSeq).toBe(N)
    expect((snapAfter!.state as { v: number }).v).toBe(SYNC_V + 1) // untouched, not compacted
    expect((await store.opsSince(DOC, N)).map((o) => o.seq)).toEqual(tailBefore) // tail intact
  })
})

// XIN-1772 P1-2: `advance()` is the only reclaim path and had two permanent-null
// modes that could brick a room read-only at its byte cap. Both now re-attempt an
// idempotent prune of the already-covered prefix.
describe('PptSnapshotter.advance: idempotent prune re-attempt (XIN-1772 P1-2)', () => {
  it('mode 1: re-prunes a covered prefix left behind by a save-committed/prune-failed split', async () => {
    const store = new InMemoryPptRelayStore()
    const fx = buildGoldenFixtures()[0]!
    await seedFrames(store, fx.frames)
    const N = fx.frames.length
    const reduction = reduceFrames(fx.genesis, null, fx.frames.map((f) => ({ seq: f.q, ops: f.ops })))
    // The snapshot save committed at coveredSeq=N, but its SEPARATE prune transaction
    // failed / the process died before it ran — ops <= N are still on disk and highWater
    // has not moved, so the raw `highWater <= coveredSeq` short-circuit would skip the
    // prune forever (room fills → read-only deadlock).
    await store.saveSnapshot({ docId: DOC, coveredSeq: N, doc: reduction.doc, state: reduction.state })
    expect((await store.opsSince(DOC, 0)).length).toBe(N)
    expect(await store.currentSeq(DOC)).toBe(N)

    const res = await new PptSnapshotter(store).advance(DOC, baseDocProviderFor(fx.genesis))

    expect(res).not.toBeNull()
    expect(res!.freedBytes).toBeGreaterThan(0)
    expect(await store.opsSince(DOC, 0)).toHaveLength(0)
  })

  it('mode 2: reclaims the covered prefix of a legacy doc-only row instead of bricking it', async () => {
    const store = new InMemoryPptRelayStore()
    const fx = buildGoldenFixtures()[1]! // insert-slide-and-elements
    await seedFrames(store, fx.frames)
    const N = fx.snapshotAt
    const headReduction = reduceFrames(fx.genesis, null, fx.frames.filter((f) => f.q <= N).map((f) => ({ seq: f.q, ops: f.ops })))
    // Legacy doc-only snapshot (state null) at coveredSeq=N whose covered ops (<=N) were
    // NOT pruned. They are subsumed by the durable doc, so they are safe to reclaim even
    // though the tail above N cannot be folded in without a real state.
    await store.saveSnapshot({ docId: DOC, coveredSeq: N, doc: headReduction.doc, state: null })
    const tailBefore = (await store.opsSince(DOC, N)).map((o) => o.seq)
    expect(tailBefore.length).toBeGreaterThan(0)

    await new PptSnapshotter(store).advance(DOC, baseDocProviderFor(fx.genesis))

    // Covered prefix (<=N) reclaimed; the un-reducible tail above N is untouched.
    expect((await store.opsSince(DOC, 0)).every((o) => o.seq > N)).toBe(true)
    expect((await store.opsSince(DOC, N)).map((o) => o.seq)).toEqual(tailBefore)
    expect((await store.getSnapshot(DOC))!.state).toBeNull() // still doc-only, not corrupted
  })
})

describe('PptSnapshotter.advance: ghost-target GC-freeze aging (XIN-1792 P1-3)', () => {
  // A wire-legal `set` against an element no `ins` ever creates parks in the engine's
  // `pending` buffer forever, so `reduceProving` never advances the covered watermark
  // past it — `coveredSeq` pins, nothing prunes, and the room bricks read-only at the
  // byte cap. The snapshotter must give such a permanently-buffered op a BOUNDED life.
  const ghostFrames = [
    // seq 1: set on 'ghost-el', which no ins creates → parks in pending forever.
    { seq: 1, ops: [{ op: 'set', a: 'u1', s: 1, l: 5, el: 'ghost-el', k: 'x', v: 1 }] },
    // seq 2: a doc-level set that materializes cleanly.
    { seq: 2, ops: [{ op: 'set', a: 'u1', s: 2, l: 6, k: 'title', v: 'hi' }] },
  ]
  async function seedGhost(store: InMemoryPptRelayStore): Promise<void> {
    for (const f of ghostFrames) {
      await store.appendOp(DOC, `f${f.seq}`, { t: 'ops', pv: 2, k: f.seq, frameId: `f${f.seq}`, epoch: 0, ops: f.ops })
    }
  }

  it('does NOT age within the lag window — GC stays frozen so a genuine out-of-order op can still fill', async () => {
    const store = new InMemoryPptRelayStore()
    await seedGhost(store)
    // A generous lag cap (default 4096) with only 2 seqs of tail: the buffered op is
    // still within the window where its `ins` could legitimately arrive, so nothing
    // is aged and nothing is pruned.
    const res = await new PptSnapshotter(store).advance(DOC, baseDocProviderFor(genesisDeck()))
    expect(res).toBeNull()
    expect((await store.opsSince(DOC, 0)).length).toBe(2) // tail intact, not pruned
    expect(await store.getSnapshot(DOC)).toBeNull() // no snapshot advanced
  })

  it('ages out a permanently-buffered op past the lag cap so GC unfreezes (bounded + audited)', async () => {
    const store = new InMemoryPptRelayStore()
    await seedGhost(store)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // A tiny lag cap forces the aging path: the ghost `set` has been un-materialized
      // across the whole tail, so it is aged out — the whole-tail materialized state is
      // persisted (WITHOUT the buffered op) and the op log is pruned.
      const snapshotter = new PptSnapshotter(store, /* maxBufferedOpLag */ 2)
      const res = await snapshotter.advance(DOC, baseDocProviderFor(genesisDeck()))
      expect(res).not.toBeNull()
      expect(res!.coveredSeq).toBe(2)
      expect(res!.freedBytes).toBeGreaterThan(0)
      // GC unfroze: the op log is pruned and a real (doc,state) snapshot now covers seq 2.
      expect(await store.opsSince(DOC, 0)).toEqual([])
      const snap = await store.getSnapshot(DOC)
      expect(snap!.coveredSeq).toBe(2)
      expect(snap!.state).not.toBeNull()
      // The materialized doc reflects the CLEAN op (title) but not the ghost-target op.
      expect((snap!.doc as unknown as { title?: unknown }).title).toBe('hi')
      // The drop is audited.
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
