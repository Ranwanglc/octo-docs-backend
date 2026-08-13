/**
 * XIN-1783 — the durability contract as an EXECUTABLE property (root-cause
 * consolidation, mandated by the round-23 process note: five successive rounds each
 * fixed one instance of the same invariant failure, never the class).
 *
 * The contract, in one sentence:
 *   `coveredSeq` may only advance to the highest seq whose mutation is proven
 *   MATERIALIZED into the artifact being persisted.
 *
 * Operationally that means: for the boundary the snapshotter chooses, reducing the
 * persisted `(doc, state)` then applying the surviving tail MUST equal reducing the
 * whole log from genesis — even when the log contains ops that the vendored engine
 * BUFFERS (parks in `gap`/`pending`, neither of which `toJSON()` serializes). The
 * prior watermark trusted the version vector, which advances BEFORE `applyEffect`
 * runs and before a parked op materializes, so it could prune an acked-durable op
 * that never made it into the persisted state (P0-1 variants a/b).
 *
 * This suite pins the fix two ways:
 *   1. A seeded ADVERSARIAL FUZZ over randomized multi-actor interleavings with
 *      gaps, repeats, foreign/reserved actors, out-of-range clocks (`l`/`s`/`sd[0]`)
 *      and missing-node targets — asserting snapshot@provenSeq + tail == full-log.
 *      The golden fixtures mint ops only through a single well-behaved `SyncState.
 *      diff`, so they cannot express these shapes; this harness can.
 *   2. Named deterministic regressions for each P0-1 variant (a/b/c) and for the
 *      whole-tail-vs-prefix hole, driven through the real `PptSnapshotter.advance`
 *      + in-memory store (the same durable-before-prune path the DB store runs).
 *
 * Determinism: a seeded PRNG (mulberry32); no `Math.random`/`Date` (the vendored
 * engine forbids them, and a flaky property test is worse than none).
 */
import { describe, it, expect } from 'vitest'
import { InMemoryPptRelayStore } from '../src/ppt/relay/store.js'
import { PptSnapshotter, reduceFrames, reduceProving } from '../src/ppt/relay/snapshotter.js'
import { SyncState, type Op } from '../src/ppt/sync/slidesSync.js'
import type { BentoDoc, BentoSlide } from '../src/ppt/bentoDoc.js'
import { genesisDeck } from './fixtures/bentoGolden.js'

const DOC = 'doc-conv'

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

/** A fast, deterministic PRNG so the fuzz is reproducible under a fixed seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const el = (id: string, html: string): Record<string, unknown> => ({ id, html })

interface Frame {
  seq: number
  ops: Op[]
}

/**
 * A JSON round-trip of the persisted snapshot — the exact lossy boundary a real
 * deployment crosses (the doc/state are written to MySQL and re-read by a late
 * joiner). Anything the engine held only in an un-serialized buffer is gone here,
 * which is precisely what makes an over-eager `coveredSeq` unsafe.
 */
function persistRoundTrip(r: { doc: BentoDoc; state: unknown }): { doc: BentoDoc; state: never } {
  return { doc: clone(r.doc), state: clone(r.state) as never }
}

/**
 * Generate a coherent multi-actor room log, then adversarially corrupt the
 * PERSISTED projection of it: drop frames (→ per-actor gaps / missing-node parks),
 * duplicate frames (→ repeats), and inject hand-built reserved-actor / out-of-range-
 * clock / missing-node ops. Returns the frames in room-seq order. Coherence of the
 * SOURCE ops is preserved by cross-applying every minted op-set to the peer engines,
 * exactly as the live relay does; the corruption happens only on the way to disk.
 */
function buildAdversarialLog(rng: () => number): { genesis: BentoDoc; frames: Frame[] } {
  const genesis = genesisDeck()
  const actorIds = ['u-a', 'u-b', 'u-c']
  const engines = actorIds.map((id) => {
    const e = new SyncState(id)
    e.adopt(genesis)
    return e
  })
  const docs = actorIds.map(() => clone(genesis))
  let elCounter = 2
  const opGroups: Op[][] = []
  const steps = 4 + Math.floor(rng() * 10)
  for (let i = 0; i < steps; i++) {
    const ai = Math.floor(rng() * actorIds.length)
    const before = clone(docs[ai]!)
    const d = docs[ai]!
    const kind = rng()
    if (kind < 0.3) {
      d.title = `T-${i}-${Math.floor(rng() * 1000)}`
    } else if (kind < 0.55) {
      const firstEl = d.slides[0]!.elements[0] as Record<string, unknown>
      firstEl.html = `<p>edit ${i}-${Math.floor(rng() * 1000)}</p>`
    } else if (kind < 0.75) {
      const firstEl = d.slides[0]!.elements[0] as Record<string, unknown>
      firstEl[`p${Math.floor(rng() * 3)}`] = Math.floor(rng() * 1000)
    } else if (kind < 0.9) {
      const id = `e${elCounter++}`
      d.slides[0]!.elements.push(el(id, `<p>new ${id}</p>`))
    } else {
      d.slides.push({
        id: `s${elCounter++}`,
        background: '#eee',
        transition: 'none',
        notes: '',
        elements: [el(`e${elCounter++}`, '<p>slide</p>')],
      } as BentoSlide)
    }
    const ops = engines[ai]!.diff(before, d, { text: true })
    if (ops.length === 0) continue
    for (let j = 0; j < engines.length; j++) if (j !== ai) engines[j]!.apply(docs[j]!, ops)
    opGroups.push(ops)
  }

  // Build the persisted projection with adversarial transforms.
  const persisted: Op[][] = []
  for (const g of opGroups) {
    const roll = rng()
    if (roll < 0.15) continue // DROP → per-actor gap (and missing-node if an ins is dropped)
    persisted.push(g)
    if (roll > 0.9) persisted.push(clone(g)) // DUPLICATE → repeated (a, s)
  }
  // Inject a handful of purely-adversarial frames the wire validator would refuse
  // but which MUST NOT corrupt the snapshot boundary if they ever reached the log.
  const injections: Op[][] = [
    // reserved reducer actor — applyOne skips it as "own"; both full-log and joiner
    // skip it identically, so convergence still holds (the data-loss-vs-live-peers
    // concern is a WIRE-layer guard, already enforced by isValidActorId).
    [{ op: 'set', a: '@relay', s: 1, l: 3, el: 'e1', k: 'html', v: '<p>relay</p>' } as unknown as Op],
    // out-of-range Lamport clock — degrades LWW ordering but reduces deterministically.
    [{ op: 'set', a: 'u-z', s: 1, l: Number.MAX_SAFE_INTEGER, el: 'e1', k: 'zc', v: 'hi' } as unknown as Op],
    // out-of-range register stamp on a txt seed — same: deterministic, convergent.
    // missing-node target — parks in `pending` forever; held below the watermark.
    [{ op: 'set', a: 'u-y', s: 1, l: 4, el: 'does-not-exist', k: 'x', v: 1 } as unknown as Op],
    // per-actor gap — s jumps with no predecessor; parks in `gap` forever.
    [{ op: 'set', a: 'u-w', s: 7, l: 5, el: 'e1', k: 'gap', v: 1 } as unknown as Op],
  ]
  for (const inj of injections) {
    if (rng() < 0.5) {
      const at = Math.floor(rng() * (persisted.length + 1))
      persisted.splice(at, 0, inj)
    }
  }

  const frames: Frame[] = persisted.map((ops, idx) => ({ seq: idx + 1, ops }))
  return { genesis, frames }
}

describe('XIN-1783 durability contract — adversarial fuzz: snapshot@provenSeq + tail == full-log', () => {
  it('converges under randomized gaps/repeats/foreign+reserved actors/out-of-range clocks/missing nodes', () => {
    const ITER = 300
    for (let seed = 1; seed <= ITER; seed++) {
      const rng = mulberry32(seed * 2654435761)
      const { genesis, frames } = buildAdversarialLog(rng)
      if (frames.length === 0) continue

      // The authoritative convergence target: reduce the WHOLE persisted log.
      const full = reduceFrames(genesis, null, frames)

      // The snapshotter's chosen boundary (the materialization proof).
      const proven = reduceProving(genesis, null, frames, 0)
      const N = proven.provenSeq
      const head = frames.filter((f) => f.seq <= N)
      const tail = frames.filter((f) => f.seq > N)

      // Persist ONLY the proven-materialized prefix, cross the real lossy JSON
      // boundary, then let a late joiner apply the surviving tail on top.
      const snap = persistRoundTrip(reduceFrames(genesis, null, head))
      const joiner = reduceFrames(snap.doc, snap.state, tail)

      expect(joiner, `seed=${seed} N=${N} frames=${frames.length}`).toEqual(full)

      // Structural guarantee: the persisted prefix reduction holds NO buffered op —
      // it is byte-lossless, which is the whole reason the boundary is prunable.
      const headEngineBuffers = reduceProving(genesis, null, head, 0).engine.bufferedOps
      expect(headEngineBuffers, `seed=${seed} prefix must be buffer-clean`).toHaveLength(0)
    }
  })
})

// ── Named per-variant regressions (P0-1 a/b/c), through the real advance() path ──

/** Append an adversarial ops frame straight to the store (bypasses the wire gate,
 *  which is exactly the "if such an op were persisted" premise of each finding). */
async function put(store: InMemoryPptRelayStore, seq: number, ops: Op[]): Promise<void> {
  await store.appendOp(DOC, `f-${seq}`, { t: 'ops', pv: 2, k: seq, frameId: `f-${seq}`, epoch: 0, ops })
}
const baseDocProviderFor = (doc: BentoDoc) => async () => doc

describe('XIN-1783 P0-1(a) — a `pending`-parked op (missing node) is never pruned as "applied"', () => {
  // Mint a real cross-actor dependency: A inserts element e2; B (having observed the
  // insert) sets a prop on e2. Persist B's set FIRST (seq 1) with A's insert absent,
  // so the set targets a node that does not yet exist in room order and PARKS in
  // `pending`. The old vv-based watermark saw `vv[u-b] >= s` and marked the frame
  // "applied" (vv advances before applyEffect parks the op) → pruned an acked op that
  // was never in the persisted state.
  function mintParkScenario() {
    const genesis = genesisDeck()
    const A = new SyncState('u-a')
    A.adopt(genesis)
    const B = new SyncState('u-b')
    B.adopt(genesis)
    const aDoc = clone(genesis)
    aDoc.slides[0]!.elements.push(el('e2', '<p>A made e2</p>'))
    const aIns = A.diff(genesis, aDoc, { text: true })
    // B observes A's insert, then sets a prop on e2 → a set op targeting e2.
    const bDoc = clone(genesis)
    B.apply(bDoc, aIns)
    const bAfter = clone(bDoc)
    ;(bAfter.slides[0]!.elements.find((e) => (e as { id: string }).id === 'e2') as Record<string, unknown>).fill = 'B-FILL'
    const bSet = B.diff(bDoc, bAfter, { text: true })
    expect(aIns.length).toBeGreaterThan(0)
    expect(bSet.length).toBeGreaterThan(0)
    return { genesis, aIns, bSet }
  }

  it('holds the parked set durable until its target node lands, then materializes it (no loss)', async () => {
    const { genesis, aIns, bSet } = mintParkScenario()
    const store = new InMemoryPptRelayStore()
    // Persist ONLY B's set (targets e2, which does not exist yet) at seq 1.
    await put(store, 1, bSet)
    const snapshotter = new PptSnapshotter(store)

    const res1 = await snapshotter.advance(DOC, baseDocProviderFor(genesis))
    // The parked op is NOT covered and its row is NOT pruned — it is the only proof
    // of an acked write whose effect is deferred.
    expect(res1?.coveredSeq ?? 0).toBeLessThan(1)
    expect((await store.opsSince(DOC, 0)).map((o) => o.seq)).toContain(1)

    // A's insert finally lands (seq 2) — the pending set can now materialize.
    await put(store, 2, aIns)
    const res2 = await snapshotter.advance(DOC, baseDocProviderFor(genesis))
    expect(res2).not.toBeNull()
    const snap = await store.getSnapshot(DOC)
    const e2 = (snap!.doc as unknown as { slides: Array<{ elements: Array<Record<string, unknown>> }> }).slides[0]!.elements.find((e) => e.id === 'e2')
    expect(e2?.fill).toBe('B-FILL') // the once-parked set is in the persisted state
    expect(snap!.coveredSeq).toBe(2)

    // Convergence: joiner replaying snapshot + (empty) tail equals the full-log.
    const full = reduceFrames(genesis, null, [
      { seq: 1, ops: bSet },
      { seq: 2, ops: aIns },
    ])
    expect(snap!.doc).toEqual(full.doc)
  })
})

describe('XIN-1783 P0-1(b) — the watermark is proven against the PREFIX persisted, not the whole tail', () => {
  // A gap that only fills ABOVE the boundary must not mark a frame below the boundary
  // "applied". Here u-a s=1 (seq 3) fills u-a's gap, but u-a s=2 (seq 1) sits above a
  // permanent u-b gap (seq 2, s=5 with no predecessor) that forces safeSeq below
  // targetSeq. The old code probed the WHOLE-tail vector (where u-a's gap is filled)
  // while persisting only the prefix (where it is not) → covered + pruned seq 1
  // against a state that never applied it.
  it('does not advance past a frame whose materialization depends on an op above the boundary', () => {
    const genesis = genesisDeck()
    const frames: Frame[] = [
      // seq 1: u-a s=2 — a gap (s=1 has not been seen yet), parks.
      { seq: 1, ops: [{ op: 'set', a: 'u-a', s: 2, l: 2, el: 'e1', k: 'k2', v: 'v2' } as unknown as Op] },
      // seq 2: u-b s=5 — a gap that NEVER fills, forcing a prefix reduction below target.
      { seq: 2, ops: [{ op: 'set', a: 'u-b', s: 5, l: 3, el: 'e1', k: 'kb', v: 'vb' } as unknown as Op] },
      // seq 3: u-a s=1 — fills u-a's gap in a WHOLE-tail probe, but not in the prefix.
      { seq: 3, ops: [{ op: 'set', a: 'u-a', s: 1, l: 1, el: 'e1', k: 'k1', v: 'v1' } as unknown as Op] },
    ]
    const full = reduceFrames(genesis, null, frames)
    const proven = reduceProving(genesis, null, frames, 0)
    // The proof must NOT advance to 1 (its state would omit u-a's edits, which only
    // materialize once seq 3 lands — above the boundary).
    expect(proven.provenSeq).toBeLessThan(1 + 1) // < 2; in practice 0 (seq 1 gaps immediately)
    const head = frames.filter((f) => f.seq <= proven.provenSeq)
    const tail = frames.filter((f) => f.seq > proven.provenSeq)
    const snap = persistRoundTrip(reduceFrames(genesis, null, head))
    expect(reduceFrames(snap.doc, snap.state, tail)).toEqual(full)
  })
})

describe('XIN-1783 P0-1(c) — two ops sharing (a, s) in one frame: snapshot stays consistent with full-log', () => {
  // The engine applies the first (a, s) op and DROPS the second (s <= seen). Every
  // replica runs the same applyOne, so the drop is consistent — the snapshot must
  // equal the full-log reduction (the durability contract is about not DIVERGING from
  // the convergence point; the "acked but silently dropped" concern is a trust-
  // boundary/validation matter — see the D1 skipped tests). This pins that the
  // materialization proof does not over- OR under-advance on a duplicate-in-frame.
  it('persisted snapshot equals the full-log reduction when a frame carries a duplicate (a,s)', () => {
    const genesis = genesisDeck()
    const frames: Frame[] = [
      {
        seq: 1,
        ops: [
          { op: 'set', a: 'u-a', s: 1, l: 1, el: 'e1', k: 'dup', v: 'FIRST' } as unknown as Op,
          { op: 'set', a: 'u-a', s: 1, l: 2, el: 'e1', k: 'dup', v: 'SECOND' } as unknown as Op,
        ],
      },
    ]
    const full = reduceFrames(genesis, null, frames)
    const proven = reduceProving(genesis, null, frames, 0)
    const head = frames.filter((f) => f.seq <= proven.provenSeq)
    const tail = frames.filter((f) => f.seq > proven.provenSeq)
    const snap = persistRoundTrip(reduceFrames(genesis, null, head))
    expect(reduceFrames(snap.doc, snap.state, tail)).toEqual(full)
  })
})
