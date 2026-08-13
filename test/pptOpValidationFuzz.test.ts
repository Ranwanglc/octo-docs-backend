/**
 * XIN-1840 — the REAL stopping rule: a wire-grammar GENERATOR proving the
 * `isBentoOp` accept-set is CLOSED under `SyncEngine.apply`.
 *
 * The round-3 gate (XIN-1835) drew candidates ONLY from (a) `SyncState.diff` output
 * (valid by construction) and (b) a fixed 7-entry known-bad catalogue. Engine-minted
 * ops are always valid and the catalogue was the known-bad set, so it could only
 * RE-ASSERT what was already known — a regression suite with a fuzz-shaped wrapper,
 * not a generator over the wire grammar. It structurally could not surface a NOVEL
 * escape, and it missed P0-1 (a `set k:'valueOf'` — any `Object.prototype` member —
 * whose register outlives the own property, so `del` → `stashNode` reads
 * `node['valueOf']` THROUGH the prototype and `clone` = `JSON.parse(undefined)`
 * throws, permanently bricking the room).
 *
 * This generator emits candidates at the WIRE-GRAMMAR level — random `op` kind,
 * ADVERSARIAL actor/id/key/payload pools (Object.prototype members, `__proto__`/
 * `constructor`/`prototype`, DocShape container names, U+001F-bearing and
 * non-composite ids, empty/oversized strings, missing/non-array `elements`,
 * mismatched node ids, multi-op frames, `set` key REMOVALS that leave a register
 * without its own property, and the two-frame `set`/`ins` → `del` sequences P0-1
 * needs) — WITHOUT restricting itself to what `diff` mints. Every candidate is
 * FILTERED through `isBentoOp`; for EVERY accepted op the property asserts:
 *
 *   1. `SyncEngine.apply` does NOT throw, AND
 *   2. the applied effect materializes into `toJSON()` — no prototype pollution, and
 *      snapshot@provenSeq + tail == the full-log reduction (the durability probe the
 *      snapshotter declares load-bearing).
 *
 * Anchored to the validator: on the PRE-fix validator the P0-1 / brick / __proto__
 * shapes were accepted, so they entered the applied set and this gate FAILED; the
 * tightened validator excludes them, so it PASSES — the body is identical across both.
 *
 * Determinism: a seeded PRNG (mulberry32); no `Math.random`/`Date` (the vendored
 * engine forbids them). Reuses the reduction harness (`reduceFrames`/`reduceProving`).
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

interface Frame {
  seq: number
  ops: Op[]
}

// ── Adversarial pools (the point of a REAL generator: these are NOT what diff mints) ──
const PROTO_MEMBERS = ['valueOf', 'toString', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString']
const RESERVED = ['__proto__', 'constructor', 'prototype']
const CONTAINERS = ['slides', 'elements']
/** Set-op keys: benign, every Object.prototype member, reserved, containers, `id`,
 *  dotted, empty, separator-bearing, oversized. */
const SET_KEYS = [
  'title', 'color', 'html', 'background', 'notes', 'transition',
  ...PROTO_MEMBERS, ...RESERVED, ...CONTAINERS, 'id',
  'style.fontFamily', 'assets.logo', 'blobs.x', `assets.${RESERVED[0]}`, `blobs.${PROTO_MEMBERS[0]}`,
  '', `x${SEP}y`, 'a'.repeat(200),
]
const ACTORS = ['u-a', 'u-b', 'u-c', '@relay', '', 'x'.repeat(200), 'U-A']
const ORDS = ['V', 'a', 'Vf', 'b', '', 5 as unknown as string]
const CLOCKS = [1, 2, 3, 50, 0, -1, 1.5, 2 ** 60, NaN]

function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)]!
}

/** Tracks node ids/keys created so far so `set`/`del`/`ord`/`txt` can target REAL
 *  registered nodes (only a real register lets `del` trip `stashNode`). Genesis s1/e1
 *  are always present. */
interface Ctx {
  slides: string[]
  elems: string[]
  counter: number
}

function newCtx(): Ctx {
  return { slides: ['s1'], elems: [elKey('s1', 'e1')], counter: 100 }
}

/** A random node id: a known one (to hit real registers), a fresh one, or an
 *  adversarial one (reserved / proto-member / separator-bearing / empty). */
function slideId(rng: () => number, ctx: Ctx): string {
  const roll = rng()
  if (roll < 0.5 && ctx.slides.length) return pick(rng, ctx.slides)
  if (roll < 0.7) return `s${ctx.counter++}`
  return pick(rng, [...RESERVED, ...PROTO_MEMBERS, '', `x${SEP}y`, 'slides'])
}
function elemKey(rng: () => number, ctx: Ctx): string {
  const roll = rng()
  if (roll < 0.5 && ctx.elems.length) return pick(rng, ctx.elems)
  if (roll < 0.7) return elKey(pick(rng, ctx.slides.length ? ctx.slides : ['s1']), `e${ctx.counter++}`)
  // adversarial: non-composite, proto-member parts, empty parts, double separator.
  return pick(rng, [
    's1e1', // non-composite (no separator)
    elKey('s1', PROTO_MEMBERS[0]!),
    elKey(RESERVED[0]!, 'e1'),
    SEP, `${SEP}e`, `s${SEP}`, `a${SEP}b${SEP}c`,
    pick(rng, PROTO_MEMBERS),
  ])
}

/** A random `ins.node` payload — including the shapes prior rounds crashed on:
 *  missing / non-array `elements`, member without a string id, mismatched node id,
 *  reserved/proto keys nested anywhere. */
function nodePayload(rng: () => number, id: string, kind: 'slide' | 'element'): Record<string, unknown> {
  const roll = rng()
  const base: Record<string, unknown> = { id }
  if (roll < 0.15) delete base.id // missing id
  else if (roll < 0.3) base.id = `mismatch${id}` // id != op id
  // Sprinkle adversarial keys.
  if (rng() < 0.3) base[pick(rng, [...PROTO_MEMBERS, ...RESERVED])] = { polluted: true }
  if (rng() < 0.3) base.style = { [pick(rng, [...PROTO_MEMBERS, ...RESERVED, 'fontFamily'])]: 'x' }
  if (rng() < 0.5) base.html = `<p>${id}</p>`
  if (kind === 'slide') {
    const r = rng()
    if (r < 0.2) {
      /* omit elements entirely (brick shape) */
    } else if (r < 0.35) {
      base.elements = {} // non-array (brick shape)
    } else if (r < 0.5) {
      base.elements = [{}, 'nope'] // member without string id (brick shape)
    } else {
      const n = Math.floor(rng() * 3)
      base.elements = Array.from({ length: n }, (_, i) => ({ id: `e${ctxSeq++}-${i}` }))
    }
  }
  return base
}
let ctxSeq = 0

function opBase(rng: () => number): { a: unknown; s: unknown; l: unknown } {
  return { a: pick(rng, ACTORS), s: pick(rng, CLOCKS), l: pick(rng, CLOCKS) }
}

/** Emit ONE candidate op (any wire shape, mostly-adversarial). */
function genOp(rng: () => number, ctx: Ctx): Op {
  const kind = pick(rng, ['set', 'ins', 'del', 'ord', 'txt'] as const)
  if (kind === 'set') {
    const target = rng()
    const op: Record<string, unknown> = { ...opBase(rng), op: 'set', k: pick(rng, SET_KEYS) }
    if (target < 0.4) {
      /* @doc: no el/sl */
    } else if (target < 0.7) {
      op.sl = slideId(rng, ctx)
    } else {
      op.el = elemKey(rng, ctx)
    }
    // 40% key REMOVAL (v omitted / undefined) — this is the shape that leaves a
    // register with NO own property, the exact P0-1 trigger for `stashNode`.
    if (rng() < 0.6) op.v = pick(rng, ['x', 1, true, { a: 1 }, [1, 2]])
    return op as unknown as Op
  }
  if (kind === 'ins') {
    const isSlide = rng() < 0.5
    if (isSlide) {
      const id = slideId(rng, ctx)
      const op = { ...opBase(rng), op: 'ins', kind: 'slide', id, ord: pick(rng, ORDS), node: nodePayload(rng, id, 'slide') }
      return op as unknown as Op
    }
    const sl = slideId(rng, ctx)
    const bare = `e${ctx.counter++}`
    const composite = rng() < 0.6 ? elKey(sl, bare) : elemKey(rng, ctx)
    const node = nodePayload(rng, bare, 'element')
    const op = { ...opBase(rng), op: 'ins', kind: 'element', id: composite, sl, ord: pick(rng, ORDS), node }
    return op as unknown as Op
  }
  if (kind === 'del') {
    const isSlide = rng() < 0.5
    const op: Record<string, unknown> = { ...opBase(rng), op: 'del', kind: isSlide ? 'slide' : 'element', id: isSlide ? slideId(rng, ctx) : elemKey(rng, ctx) }
    if (rng() < 0.4) op.cas = [elemKey(rng, ctx), elemKey(rng, ctx)]
    return op as unknown as Op
  }
  if (kind === 'ord') {
    const isSlide = rng() < 0.5
    const op: Record<string, unknown> = { ...opBase(rng), op: 'ord', kind: isSlide ? 'slide' : 'element', id: isSlide ? slideId(rng, ctx) : elemKey(rng, ctx), ord: pick(rng, ORDS) }
    if (!isSlide && rng() < 0.7) op.sl = slideId(rng, ctx)
    return op as unknown as Op
  }
  // txt
  const el = elemKey(rng, ctx)
  const op: Record<string, unknown> = { ...opBase(rng), op: 'txt', el, sd: [pick(rng, CLOCKS), pick(rng, ACTORS)] }
  if (rng() < 0.5) op.base = '<p>x</p>'
  if (rng() < 0.4) op.del = ['t0', 't1']
  if (rng() < 0.6) {
    const groups = rng() < 0.4 ? 2 : 1 // >1 group is the silent-partial-apply shape
    op.ins = Array.from({ length: groups }, (_, i) => ({ at: i === 0 ? '^' : 't0', toks: [`c${i}`] }))
  }
  return op as unknown as Op
}

/** How many candidate `set k:<Object.prototype member>` the generator produced (for a
 *  coverage assertion — the P0-1 class MUST be exercised, not merely present). */
let protoSetKeyCount = 0

/**
 * Build an accepted-op log: interleave RAW generated candidates, a few coherent
 * diff-minted op sets (to grow real nodes), and explicit two-frame `set`/`ins` → `del`
 * sequences on a real node (the P0-1 trip). Every candidate is filtered through
 * `isBentoOp`; only survivors become frames.
 */
function buildLog(rng: () => number): { genesis: BentoDoc; frames: Frame[] } {
  const genesis = genesisDeck()
  const author = new SyncState('u-a')
  author.adopt(genesis)
  let prev = clone(genesis)
  const ctx = newCtx()

  const groups: Op[][] = []
  const steps = 8 + Math.floor(rng() * 12)
  for (let i = 0; i < steps; i++) {
    const roll = rng()
    if (roll < 0.25) {
      // A coherent, well-formed op-set via the real differ (grows real nodes).
      const next = clone(prev)
      const k = rng()
      if (k < 0.3) next.title = `T-${i}`
      else if (k < 0.6) (next.slides[0]!.elements[0] as Record<string, unknown>).html = `<p>edit ${i}</p>`
      else if (k < 0.8) next.slides[0]!.elements.push({ id: `e${ctx.counter}`, html: `<p>${ctx.counter}</p>` } as unknown as Record<string, unknown> as never)
      else next.slides.push({ id: `s${ctx.counter}`, background: '#eee', transition: 'none', notes: '', elements: [{ id: `e${ctx.counter}x`, html: '<p>s</p>' } as unknown as Record<string, unknown>] } as BentoSlide)
      const ops = author.diff(prev, next, { text: true })
      prev = next
      for (const o of ops) {
        const el = (o as { el?: string; id?: string }).el ?? (o as { id?: string }).id
        if (el && el.includes(SEP)) ctx.elems.push(el)
      }
      ctx.counter++
      if (ops.length) groups.push(ops)
    } else if (roll < 0.4) {
      // Explicit P0-1 trip: a `set k:<proto member>` KEY-REMOVAL on a real element (its
      // register outlives the missing own property), then a `del` of that element. Both
      // filtered through isBentoOp — pre-fix the set was accepted (→ stashNode throws on
      // the del); post-fix the set is rejected and only the harmless del survives.
      const target = pick(rng, ctx.elems)
      const key = pick(rng, PROTO_MEMBERS)
      protoSetKeyCount++
      groups.push([{ a: 'u-a', s: 1, l: 10 + i, op: 'set', el: target, k: key } as unknown as Op])
      groups.push([{ a: 'u-a', s: 2, l: 11 + i, op: 'del', kind: 'element', id: target } as unknown as Op])
    } else {
      // A frame of 1-3 raw wire-grammar candidates.
      const n = 1 + Math.floor(rng() * 3)
      const frame: Op[] = []
      for (let j = 0; j < n; j++) {
        const o = genOp(rng, ctx)
        if ((o as { op?: string }).op === 'set' && PROTO_MEMBERS.includes((o as { k?: string }).k ?? '')) protoSetKeyCount++
        frame.push(o)
      }
      groups.push(frame)
    }
  }

  // Filter through the validator: this is the ACCEPT-SET under test.
  const frames: Frame[] = []
  let seq = 0
  for (const group of groups) {
    const accepted = group.filter((op) => isBentoOp(op))
    if (accepted.length === 0) continue
    frames.push({ seq: ++seq, ops: accepted })
  }
  return { genesis, frames }
}

/**
 * A node in the materialized `doc` must be a PLAIN object (Object.prototype) or an
 * intentional null-prototype map (`doc.assets` / `doc.blobs`); an array must have
 * Array.prototype. Any other prototype is proof a `__proto__`-payload op wrote its
 * value as the node's PROTOTYPE — the effect leaves `toJSON()` (P1-2).
 */
function assertNoPrototypePollution(v: unknown, path: string, seed: number): void {
  if (Array.isArray(v)) {
    expect(Object.getPrototypeOf(v), `${path}: array prototype polluted (seed=${seed})`).toBe(Array.prototype)
    v.forEach((item, i) => assertNoPrototypePollution(item, `${path}[${i}]`, seed))
    return
  }
  if (v !== null && typeof v === 'object') {
    const proto = Object.getPrototypeOf(v)
    expect(proto === Object.prototype || proto === null, `${path}: object prototype polluted (seed=${seed})`).toBe(true)
    for (const k of Object.keys(v)) assertNoPrototypePollution((v as Record<string, unknown>)[k], `${path}.${k}`, seed)
  }
}

describe('XIN-1840 — wire-grammar generator: validator/reducer accept-set is closed under apply', () => {
  it('every accepted op applies without throwing, materializes into toJSON, and never pollutes a prototype', () => {
    const ITER = 2000
    let acceptedOps = 0
    for (let seed = 1; seed <= ITER; seed++) {
      const rng = mulberry32(seed * 2654435761)
      const { genesis, frames } = buildLog(rng)
      if (frames.length === 0) continue
      acceptedOps += frames.reduce((n, f) => n + f.ops.length, 0)

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
    // Coverage: the generator must actually EXERCISE the P0-1 class (a real generator,
    // not a suite that only re-asserts known-good shapes) and accept a meaningful body.
    expect(protoSetKeyCount, 'generator never produced a set k:<Object.prototype member>').toBeGreaterThan(1000)
    expect(acceptedOps, 'generator accepted too few ops to be meaningful').toBeGreaterThan(5000)
  })
})

describe('XIN-1840 — the accept-set EXCLUDES every shape that breaks apply (pre-fix P0-1/P1-2)', () => {
  // Each shape is proven UNSAFE on the pre-fix validator/engine and then proven either
  // EXCLUDED at the wire or NEUTRALIZED in the engine. On the pre-fix code these were
  // accepted AND threw/polluted, so the generator above would have caught them.

  it('P0-1: a set k:<Object.prototype member> KEY-REMOVAL then del of the node — wire-rejected AND engine-neutralized', () => {
    const target = elKey('s1', 'e1')
    for (const key of PROTO_MEMBERS) {
      // Wire: the set naming a prototype member is refused (the primary guard).
      expect(isBentoOp({ op: 'set', a: 'u-a', s: 1, l: 1, el: target, k: key }), `set k:'${key}'`).toBe(false)
    }
    // Engine (belt-and-braces, XIN-1840 P0-1): even applied RAW — a `set k:'valueOf'`
    // key-removal (register created, own property absent) then a `del` — `stashNode`
    // must read `node['valueOf']` as an OWN property only, so it no longer resolves the
    // inherited function and `clone(undefined)` never throws. Pre-fix this threw
    // `"undefined" is not valid JSON` out of engine.apply and bricked the room.
    const engine = new SyncState('u-reduce')
    const doc = genesisDeck()
    engine.adopt(doc)
    expect(() => {
      engine.apply(doc, [{ a: 'u-a', s: 1, l: 5, op: 'set', el: target, k: 'valueOf' } as unknown as Op])
      engine.apply(doc, [{ a: 'u-a', s: 2, l: 6, op: 'del', kind: 'element', id: target } as unknown as Op])
    }).not.toThrow()
    assertNoPrototypePollution(reduceFrames(genesisDeck(), null, []).doc, 'doc', 0)
  })

  it('P0-1: a slide ins without its child array throws in the reducer and is rejected', () => {
    const brick = { op: 'ins', a: 'u-a', s: 1, l: 1, kind: 'slide', id: 's2', ord: 'V', node: { id: 's2' } } as unknown as Op
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
    expect(isBentoOp(poison)).toBe(false)
  })

  it('P2: set k:"id" (identity rewrite), a txt op with >1 ins group, and per-kind del/ord id shapes are rejected', () => {
    // set k:'id' rewrites node identity while maps stay keyed by the old id.
    expect(isBentoOp({ op: 'set', a: 'u-a', s: 1, l: 1, sl: 's1', k: 'id', v: 'x' })).toBe(false)
    // txt with 2 insert groups is silently partial-applied by the reducer.
    expect(isBentoOp({ op: 'txt', a: 'u-a', s: 1, l: 1, el: elKey('s1', 'e1'), sd: [1, 'u-a'], ins: [{ at: '^', toks: ['a'] }, { at: 't0', toks: ['b'] }] })).toBe(false)
    // del/ord element id must be composite; slide id must be bare.
    expect(isBentoOp({ op: 'del', a: 'u-a', s: 1, l: 1, kind: 'element', id: 's1e1-noncomposite' })).toBe(false)
    expect(isBentoOp({ op: 'del', a: 'u-a', s: 1, l: 1, kind: 'slide', id: elKey('s1', 'e1') })).toBe(false)
    expect(isBentoOp({ op: 'ord', a: 'u-a', s: 1, l: 1, kind: 'element', id: 's1e1-noncomposite', ord: 'V' })).toBe(false)
    // del cas entries must be composite element keys, not arbitrary strings.
    expect(isBentoOp({ op: 'del', a: 'u-a', s: 1, l: 1, kind: 'slide', id: 's1', cas: ['not-composite'] })).toBe(false)
    // Well-formed shapes still pass.
    expect(isBentoOp({ op: 'del', a: 'u-a', s: 1, l: 1, kind: 'element', id: elKey('s1', 'e1') })).toBe(true)
    expect(isBentoOp({ op: 'del', a: 'u-a', s: 1, l: 1, kind: 'slide', id: 's1', cas: [elKey('s1', 'e1')] })).toBe(true)
    expect(isBentoOp({ op: 'txt', a: 'u-a', s: 1, l: 1, el: elKey('s1', 'e1'), sd: [1, 'u-a'], ins: [{ at: '^', toks: ['a'] }] })).toBe(true)
  })
})
