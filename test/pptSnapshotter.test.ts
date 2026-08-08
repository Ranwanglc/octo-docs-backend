/**
 * Server-side snapshotter (XIN-1759 Part B / XIN-1758 / XIN-1764 Option 2):
 * deterministic Bento reduction, the convergence invariant, prune-only-after-durable,
 * room-byte reclaim, and version alignment (Jeff #1). Uses the SHARED golden
 * fixtures (Jeff #2) and the in-memory store, which enforces the same
 * atomic-snapshot-then-prune + monotonic-seq invariants as the DB store.
 */
import { describe, it, expect } from 'vitest'
import { InMemoryPptRelayStore } from '../src/ppt/relay/store.js'
import { PptSnapshotter, reduceFrames, assertSyncVersionAligned, SNAPSHOT_REDUCER_ACTOR } from '../src/ppt/relay/snapshotter.js'
import { SYNC_V } from '../src/ppt/sync/slidesSync.js'
import { BENTO_SYNC_V, type BentoDoc } from '../src/ppt/bentoDoc.js'
import { buildGoldenFixtures, genesisDeck, type GoldenFrame } from './fixtures/bentoGolden.js'

const DOC = 'doc-snap'

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
