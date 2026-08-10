/**
 * XIN-1835 — the STRUCTURAL stopping rule: the `isBentoOp` accept-set is CLOSED
 * under `SyncEngine.apply`. Round after round, the same class of defect recurred —
 * the wire validator accepted an op the reducer could not apply (a slide `ins`
 * without its child array bricked the room; a reserved key inside an `ins.node`
 * payload "applied" yet was absent from `toJSON()`). This gate converts "we fixed
 * the shapes we found" into a property: for EVERY op the validator accepts,
 *
 *   1. `SyncEngine.apply` does NOT throw, AND
 *   2. the applied effect is present in `toJSON()` — i.e. the durability probe the
 *      snapshotter declares load-bearing (`snapshotter.ts:238-250`,
 *      buffer-empty ⟺ effect-in-`toJSON`) holds: snapshot@provenSeq + tail == the
 *      full-log reduction, and no op ever writes its effect onto a prototype
 *      instead of an own key (the P1-2 __proto__-payload hole).
 *
 * The generator emits BOTH well-formed ops (via the real `SyncState.diff`) and the
 * exact adversarial shapes prior rounds crashed on, then FILTERS every candidate
 * through `isBentoOp`. Only survivors are applied. So the gate is anchored to the
 * validator: on the pre-fix validator the brick/absent shapes were accepted, so
 * they entered the applied set and this gate FAILED; the tightened validator
 * excludes them, so it PASSES — the test body is identical across both.
 *
 * Determinism: a seeded PRNG (mulberry32); no `Math.random`/`Date` (the vendored
 * engine forbids them). Reuses the reduction harness (`reduceFrames`/
 * `reduceProving`) — a bounded add, not new infra.
 */
import { describe, it, expect } from 'vitest'
import { isBentoOp } from '../src/ppt/relay/frames.js'
import { reduceFrames, reduceProving } from '../src/ppt/relay/snapshotter.js'
import { SyncState, type Op } from '../src/ppt/sync/slidesSync.js'
import type { BentoDoc, BentoSlide } from '../src/ppt/bentoDoc.js'
import { genesisDeck } from './fixtures/bentoGolden.js'

const SEP = String.fromCharCode(0x1f)
const elKey = (sl: string, el: string): string => sl + SEP + el

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

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
 * A node in the materialized `doc` must be a PLAIN object (Object.prototype) or an
 * intentional null-prototype map (`doc.assets` / `doc.blobs`, minted via nullMap);
 * an array must have Array.prototype. A `__proto__`-payload op writes its value as
 * the node's PROTOTYPE (neither of those), which is exactly how the effect leaves
 * `toJSON()` — so any other prototype is proof the P1-2 hole is open (XIN-1835).
 */
function assertNoPrototypePollution(v: unknown, path: string, seed: number): void {
  if (Array.isArray(v)) {
    expect(Object.getPrototypeOf(v), `${path}: array prototype polluted (seed=${seed})`).toBe(Array.prototype)
    v.forEach((item, i) => assertNoPrototypePollution(item, `${path}[${i}]`, seed))
    return
  }
  if (v !== null && typeof v === 'object') {
    const proto = Object.getPrototypeOf(v)
    expect(
      proto === Object.prototype || proto === null,
      `${path}: object prototype polluted (seed=${seed})`,
    ).toBe(true)
    for (const k of Object.keys(v)) assertNoPrototypePollution((v as Record<string, unknown>)[k], `${path}.${k}`, seed)
  }
}

/**
 * Emit a candidate op stream: coherent ops minted by the real engine `diff`,
 * interleaved with the adversarial shapes prior rounds crashed on. EVERY candidate
 * is filtered through `isBentoOp`; only survivors are returned as frames. The
 * adversarial candidates are the point — pre-fix they survived the filter and broke
 * apply; post-fix the filter drops them and the survivors all apply cleanly.
 */
function buildAcceptedLog(rng: () => number): { genesis: BentoDoc; frames: Frame[] } {
  const genesis = genesisDeck()
  const author = new SyncState('u-a')
  author.adopt(genesis)
  let prev = clone(genesis)
  let counter = 2

  const candidates: Op[][] = []
  const steps = 5 + Math.floor(rng() * 8)
  for (let i = 0; i < steps; i++) {
    const roll = rng()
    if (roll < 0.5) {
      // A coherent, well-formed op-set via the real differ.
      const next = clone(prev)
      const kind = rng()
      if (kind < 0.3) {
        next.title = `T-${i}`
      } else if (kind < 0.55) {
        ;(next.slides[0]!.elements[0] as Record<string, unknown>).html = `<p>edit ${i}</p>`
      } else if (kind < 0.8) {
        const id = `e${counter++}`
        next.slides[0]!.elements.push(el(id, `<p>${id}</p>`))
      } else {
        next.slides.push({
          id: `s${counter++}`,
          background: '#eee',
          transition: 'none',
          notes: '',
          elements: [el(`e${counter++}`, '<p>s</p>')],
        } as BentoSlide)
      }
      const ops = author.diff(prev, next, { text: true })
      prev = next
      if (ops.length > 0) candidates.push(ops)
    } else {
      // An adversarial candidate — one of the exact shapes prior rounds crashed on.
      candidates.push([pickAdversarial(rng, counter++)])
    }
  }

  // Filter through the validator: this is the ACCEPT-SET under test.
  const frames: Frame[] = []
  let seq = 0
  for (const group of candidates) {
    const accepted = group.filter((op) => isBentoOp(op))
    if (accepted.length === 0) continue
    frames.push({ seq: ++seq, ops: accepted })
  }
  return { genesis, frames }
}

/** The catalogue of shapes the validator must exclude (pre-fix it did not). */
function pickAdversarial(rng: () => number, n: number): Op {
  const shapes: Op[] = [
    // P0-1: slide ins with no child (`elements`) array → reducer `C(S, node)` TypeError.
    { op: 'ins', a: 'u-a', s: 1, l: 1, kind: 'slide', id: `s${n}`, ord: 'V', node: { id: `s${n}` } } as unknown as Op,
    // P0-1: non-array `elements`.
    { op: 'ins', a: 'u-a', s: 1, l: 1, kind: 'slide', id: `s${n}`, ord: 'V', node: { id: `s${n}`, elements: {} } } as unknown as Op,
    // P0-1: slide member without a string id.
    { op: 'ins', a: 'u-a', s: 1, l: 1, kind: 'slide', id: `s${n}`, ord: 'V', node: { id: `s${n}`, elements: [{}] } } as unknown as Op,
    // P0-1: set overwriting the `slides` container array.
    { op: 'set', a: 'u-a', s: 1, l: 1, k: 'slides', v: 'boom' } as unknown as Op,
    // P0-1: set overwriting a slide's `elements` container array.
    { op: 'set', a: 'u-a', s: 1, l: 1, sl: 's1', k: 'elements', v: 0 } as unknown as Op,
    // P1-2: reserved key inside the ins.node payload → assignNode writes the prototype.
    { op: 'ins', a: 'u-a', s: 1, l: 1, kind: 'element', id: elKey('s1', `e${n}`), sl: 's1', ord: 'V', node: { id: `e${n}`, ['__proto__']: { polluted: true } } } as unknown as Op,
    // P0-1: element op id not the composite elKey(sl, node.id).
    { op: 'ins', a: 'u-a', s: 1, l: 1, kind: 'element', id: `s1e${n}`, sl: 's1', ord: 'V', node: { id: `e${n}` } } as unknown as Op,
  ]
  return shapes[Math.floor(rng() * shapes.length)]!
}

describe('XIN-1835 — validator/reducer accept-set is closed under apply (fuzz)', () => {
  it('every accepted op applies without throwing, materializes into toJSON, and never pollutes a prototype', () => {
    const ITER = 300
    for (let seed = 1; seed <= ITER; seed++) {
      const rng = mulberry32(seed * 2654435761)
      const { genesis, frames } = buildAcceptedLog(rng)
      if (frames.length === 0) continue

      // (1) No accepted op throws when applied through the engine, one frame at a time.
      const engine = new SyncState('u-reduce')
      engine.adopt(genesis)
      const doc = clone(genesis)
      for (const f of frames) {
        expect(() => engine.apply(doc, f.ops), `seed=${seed} seq=${f.seq}`).not.toThrow()
      }

      // (2a) Effect-in-toJSON, structural half: no accepted op wrote its effect onto a
      // prototype instead of an own key (the P1-2 __proto__-payload hole).
      const full = reduceFrames(genesis, null, frames)
      assertNoPrototypePollution(full.doc, 'doc', seed)

      // (2b) Effect-in-toJSON, durability half: the proven prefix persisted across the
      // real lossy JSON boundary, plus the surviving tail, equals the full-log reduction.
      const proven = reduceProving(genesis, null, frames, 0)
      expect(proven.quarantined, `seed=${seed}: an accepted op still threw (quarantined)`).toBeUndefined()
      const N = proven.provenSeq
      const head = frames.filter((f) => f.seq <= N)
      const tail = frames.filter((f) => f.seq > N)
      const snap = reduceFrames(genesis, null, head)
      const joiner = reduceFrames(clone(snap.doc), clone(snap.state) as never, tail)
      expect(joiner, `seed=${seed} N=${N} frames=${frames.length}`).toEqual(full)
    }
  })
})

describe('XIN-1835 — the accept-set EXCLUDES every shape that breaks apply (pre-fix P0-1/P1-2)', () => {
  // Each shape is proven UNSAFE (applying it raw throws, or pollutes a prototype),
  // and then proven EXCLUDED by `isBentoOp`. On the pre-fix validator these were
  // accepted, so the fuzz gate above would have applied them and failed.
  it('P0-1: a slide ins without its child array throws in the reducer and is rejected', () => {
    const brick = { op: 'ins', a: 'u-a', s: 1, l: 1, kind: 'slide', id: 's2', ord: 'V', node: { id: 's2' } } as unknown as Op
    // The reducer actor MUST differ from the op actor, else applyOne skips it as "own".
    const engine = new SyncState('u-reduce')
    const doc = genesisDeck()
    engine.adopt(doc)
    expect(() => engine.apply(doc, [brick])).toThrow()
    expect(isBentoOp(brick)).toBe(false)
  })

  it('P0-1: a set overwriting the slides container bricks a later structural op and is rejected', () => {
    const overwrite = { op: 'set', a: 'u-a', s: 1, l: 1, k: 'slides', v: 'boom' } as unknown as Op
    const insSlide = { op: 'ins', a: 'u-a', s: 2, l: 2, kind: 'slide', id: 's2', ord: 'V', node: { id: 's2', elements: [] } } as unknown as Op
    const engine = new SyncState('u-reduce')
    const doc = genesisDeck()
    engine.adopt(doc)
    // Overwriting `slides` with a non-array, then any structural op that calls P().find/push, throws.
    expect(() => {
      engine.apply(doc, [overwrite])
      engine.apply(doc, [insSlide])
    }).toThrow()
    expect(isBentoOp(overwrite)).toBe(false)
  })

  it('P1-2: a __proto__ inside an ins.node payload pollutes the doc-node prototype and is rejected', () => {
    const poison = {
      op: 'ins', a: 'u-a', s: 1, l: 1, kind: 'element', id: elKey('s1', 'e9'), sl: 's1', ord: 'V',
      node: JSON.parse('{"id":"e9","__proto__":{"polluted":true}}'),
    } as unknown as Op
    const engine = new SyncState('u-reduce')
    const doc = genesisDeck()
    engine.adopt(doc)
    engine.apply(doc, [poison])
    // Whether or not it threw, the element (if materialized) must not carry a polluted
    // prototype — but the wire validator refuses the shape outright, so it never applies.
    expect(isBentoOp(poison)).toBe(false)
  })
})
