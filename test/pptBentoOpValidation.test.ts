/**
 * Bento `Op` wire validation (XIN-1759 Part B / XIN-1764 Option 2): the relay now
 * accepts Bento's own op shape and REJECTS the legacy octo envelope
 * (`{kind,key,prop,delta}`), which is protocol-incompatible with the server-side
 * reducer. Envelope validation stays separate from the CRDT reducer's semantics.
 */
import { describe, it, expect } from 'vitest'
import { opsAreValid, isBentoOp, isValidActorId, MAX_OP_CLOCK } from '../src/ppt/relay/frames.js'
import { SNAPSHOT_REDUCER_ACTOR } from '../src/ppt/relay/snapshotter.js'

describe('opsAreValid / isBentoOp: Bento Op shape', () => {
  it('accepts every well-formed Bento op kind', () => {
    const ops = [
      { op: 'set', a: 'u1', s: 1, l: 1, k: 'title', v: 'x' },
      { op: 'set', a: 'u1', s: 2, l: 2, sl: 's1', el: 's1e1', k: 'color', v: 'red' },
      { op: 'ins', a: 'u1', s: 3, l: 3, kind: 'slide', id: 's2', ord: 'V', node: { id: 's2', elements: [{ id: 'e1' }] } },
      { op: 'ins', a: 'u1', s: 4, l: 4, kind: 'element', id: 's2e2', sl: 's2', ord: 'V', node: { id: 'e2' } },
      { op: 'del', a: 'u1', s: 5, l: 5, kind: 'slide', id: 's2', cas: ['s2e2'] },
      { op: 'del', a: 'u1', s: 6, l: 6, kind: 'element', id: 's1e1' },
      { op: 'ord', a: 'u1', s: 7, l: 7, kind: 'slide', id: 's1', ord: 'a' },
      { op: 'txt', a: 'u1', s: 8, l: 8, el: 's1e1', sd: [1, 'u1'], base: '<p>x</p>', ins: [{ at: '^', toks: ['t1'] }], del: ['t0'] },
    ]
    expect(opsAreValid(ops)).toBe(true)
    for (const op of ops) expect(isBentoOp(op)).toBe(true)
  })

  it('rejects the legacy octo op envelope {kind,key,prop,value}', () => {
    expect(opsAreValid([{ kind: 'set', key: 's1e1', prop: 'x', value: 1 }])).toBe(false)
    expect(isBentoOp({ kind: 'set', key: 's1e1', prop: 'x', value: 1 })).toBe(false)
  })

  it('requires the OpBase metadata (a / s / l)', () => {
    expect(isBentoOp({ op: 'set', k: 'x', v: 1 })).toBe(false) // no a/s/l
    expect(isBentoOp({ op: 'set', a: 'u1', s: 0, l: 1, k: 'x' })).toBe(false) // s must be >= 1
    expect(isBentoOp({ op: 'set', a: '', s: 1, l: 1, k: 'x' })).toBe(false) // empty actor
    expect(isBentoOp({ op: 'set', a: 'u1', s: 1.5, l: 1, k: 'x' })).toBe(false) // fractional s
  })

  it('enforces per-kind required fields', () => {
    expect(isBentoOp({ op: 'set', a: 'u1', s: 1, l: 1 })).toBe(false) // set needs k
    expect(isBentoOp({ op: 'ins', a: 'u1', s: 1, l: 1, kind: 'slide', id: 's1', ord: 'a' })).toBe(false) // ins needs node
    expect(isBentoOp({ op: 'ins', a: 'u1', s: 1, l: 1, kind: 'bogus', id: 's1', ord: 'a', node: {} })).toBe(false)
    expect(isBentoOp({ op: 'ord', a: 'u1', s: 1, l: 1, kind: 'slide', id: 's1' })).toBe(false) // ord needs ord key
    expect(isBentoOp({ op: 'txt', a: 'u1', s: 1, l: 1, el: 's1e1' })).toBe(false) // txt needs sd
    expect(isBentoOp({ op: 'txt', a: 'u1', s: 1, l: 1, el: 'x', sd: [1] })).toBe(false) // sd must be [l,a]
  })

  it('rejects non-arrays, non-objects, and unknown op discriminants', () => {
    expect(opsAreValid('nope')).toBe(false)
    expect(opsAreValid([null])).toBe(false)
    expect(opsAreValid([{ op: 'frobnicate', a: 'u1', s: 1, l: 1 }])).toBe(false)
  })
})

// XIN-1772 P0-2: op metadata is validated at the trust boundary, not by convention.
// On the buggy head (71661ef) `op.a` was any non-empty string and `op.l`/`op.s` were
// bounded only by Number.isSafeInteger, so a client could mint the reserved reducer
// actor, poison the Lamport clock, or manufacture an unfillable per-actor gap.
describe('isBentoOp: op metadata trust-boundary validation (XIN-1772 P0-2)', () => {
  it('rejects the reserved snapshot-reducer actor namespace (a:"@relay")', () => {
    // The reducer actor is `@relay`; the vendored engine SKIPS an op whose actor
    // equals its own, so a client-minted `@relay` op is applied by live peers but
    // silently dropped by the snapshotter, then pruned — an acked-durable write lost.
    expect(SNAPSHOT_REDUCER_ACTOR).toBe('@relay')
    expect(isBentoOp({ op: 'set', a: '@relay', s: 1, l: 1, k: 'x', v: 1 })).toBe(false)
    expect(opsAreValid([{ op: 'set', a: '@relay', s: 1, l: 1, k: 'x', v: 1 }])).toBe(false)
    // The whole `@`-prefixed namespace is reserved, not just the exact string.
    expect(isBentoOp({ op: 'set', a: '@anything', s: 1, l: 1, k: 'x', v: 1 })).toBe(false)
    expect(isValidActorId('@relay')).toBe(false)
  })

  it('charset-restricts the actor id to [a-z0-9-]', () => {
    expect(isValidActorId('u-author')).toBe(true)
    expect(isValidActorId('u1')).toBe(true)
    // Anything outside the client-id charset is refused on the wire.
    expect(isValidActorId('UPPER')).toBe(false)
    expect(isValidActorId('has space')).toBe(false)
    expect(isValidActorId('has_underscore')).toBe(false)
    expect(isValidActorId('emoji😀')).toBe(false)
    expect(isValidActorId('')).toBe(false)
    expect(isValidActorId('a'.repeat(65))).toBe(false)
  })

  it('bounds the Lamport clock (op.l) far below MAX_SAFE_INTEGER', () => {
    // A single op with l = MAX_SAFE_INTEGER would pin the room's Lamport clock so
    // `stamp()`'s ++ can no longer advance it, degrading LWW to actor-id tiebreaks.
    expect(isBentoOp({ op: 'set', a: 'u1', s: 1, l: Number.MAX_SAFE_INTEGER, k: 'x', v: 1 })).toBe(false)
    expect(isBentoOp({ op: 'set', a: 'u1', s: 1, l: MAX_OP_CLOCK + 1, k: 'x', v: 1 })).toBe(false)
    // The bound itself is still a legal value; a real session never approaches it.
    expect(isBentoOp({ op: 'set', a: 'u1', s: 1, l: MAX_OP_CLOCK, k: 'x', v: 1 })).toBe(true)
  })

  it('bounds the per-actor sequence (op.s) the same way (no crafted unfillable gap)', () => {
    expect(isBentoOp({ op: 'set', a: 'u1', s: Number.MAX_SAFE_INTEGER, l: 1, k: 'x', v: 1 })).toBe(false)
    expect(isBentoOp({ op: 'set', a: 'u1', s: MAX_OP_CLOCK + 1, l: 1, k: 'x', v: 1 })).toBe(false)
  })
})

// XIN-1821 P0-4: node ids and `set` keys are used as OBJECT KEYS by the vendored engine
// (pending/pos/births/tombs/txt/stash + the real doc node via `set d[op.k]`). A wire-legal
// id/key naming a reserved prototype member (`__proto__`/`constructor`/`prototype`) crashed
// the reducer (`for (const p of pending['__proto__'])` iterated Object.prototype) — which
// permanently disabled the room's snapshotter/GC — or mutated a prototype instead of an own
// slot. The wire validator now rejects them (the engine ALSO uses null-proto maps as the
// defense-in-depth twin).
describe('isBentoOp: reserved prototype keys rejected at the wire (XIN-1821 P0-4)', () => {
  const reserved = ['__proto__', 'constructor', 'prototype']

  it('rejects a reserved node id on ins / del / ord', () => {
    for (const id of reserved) {
      expect(isBentoOp({ op: 'ins', a: 'u1', s: 1, l: 1, kind: 'slide', id, ord: 'V', node: { id } })).toBe(false)
      expect(isBentoOp({ op: 'del', a: 'u1', s: 1, l: 1, kind: 'slide', id })).toBe(false)
      expect(isBentoOp({ op: 'ord', a: 'u1', s: 1, l: 1, kind: 'slide', id, ord: 'a' })).toBe(false)
    }
  })

  it('rejects a reserved el node key on txt / set, and reserved sl / el on set', () => {
    for (const key of reserved) {
      expect(isBentoOp({ op: 'txt', a: 'u1', s: 1, l: 1, el: key, sd: [1, 'u1'] })).toBe(false)
      expect(isBentoOp({ op: 'set', a: 'u1', s: 1, l: 1, el: key, k: 'color', v: 'red' })).toBe(false)
      expect(isBentoOp({ op: 'set', a: 'u1', s: 1, l: 1, sl: key, k: 'color', v: 'red' })).toBe(false)
    }
  })

  it('rejects a reserved set key `k`, including inside an assets./blobs. path', () => {
    for (const key of reserved) {
      expect(isBentoOp({ op: 'set', a: 'u1', s: 1, l: 1, k: key, v: 1 })).toBe(false)
      // `assets.__proto__` splits to the sub-map key `__proto__` (crdt.ts applySet).
      expect(isBentoOp({ op: 'set', a: 'u1', s: 1, l: 1, k: `assets.${key}`, v: 1 })).toBe(false)
      expect(isBentoOp({ op: 'set', a: 'u1', s: 1, l: 1, k: `blobs.${key}`, v: 1 })).toBe(false)
    }
  })

  it('still accepts ordinary dotted / composite keys and ids', () => {
    // Only the exact reserved segments are rejected — real keys are unaffected.
    expect(isBentoOp({ op: 'set', a: 'u1', s: 1, l: 1, k: 'style.fontFamily', v: 'x' })).toBe(true)
    expect(isBentoOp({ op: 'set', a: 'u1', s: 1, l: 1, k: 'assets.logo', v: 'x' })).toBe(true)
    // A slide ins now requires a well-formed `node` with a matching id + child array
    // (XIN-1835 P0-1) — a full-shape node is accepted (see the tightened-ins block).
    expect(
      isBentoOp({ op: 'ins', a: 'u1', s: 1, l: 1, kind: 'slide', id: 's1', ord: 'V', node: { id: 's1', elements: [] } }),
    ).toBe(true)
  })
})

// XIN-1835 P0-1 / P1-2: `isBentoOp`'s `ins` case is tightened so the validator accept-set
// is CLOSED under `SyncEngine.apply`. On the buggy head an `ins.node` was checked only as
// a non-null object, so a slide node with no child (`elements`) array crashed the reducer's
// per-member iteration (`C(S, node).forEach`) — a permanent room brick — and a `__proto__`
// key inside the node payload was copied onto the real doc node by `assignNode` (applied
// but absent from `toJSON()`). A `set` naming a container key (`slides`/`elements`) could
// overwrite the very array `P()`/`C()` call array methods on.
describe('isBentoOp: tightened ins.node + container-key guard (XIN-1835 P0-1/P1-2)', () => {
  const SEP = ''
  const elKey = (sl: string, el: string): string => sl + SEP + el

  it('rejects a slide ins whose node lacks the elements child array (the brick shape)', () => {
    // The exact shapes the old fixtures pinned as valid — now refused on the wire.
    expect(isBentoOp({ op: 'ins', a: 'u1', s: 1, l: 1, kind: 'slide', id: 's2', ord: 'V', node: { id: 's2' } })).toBe(false)
    expect(isBentoOp({ op: 'ins', a: 'u1', s: 1, l: 1, kind: 'slide', id: 's1', ord: 'V', node: {} })).toBe(false)
    // A non-array `elements` is refused too (it would still crash `C(S, node)`).
    expect(
      isBentoOp({ op: 'ins', a: 'u1', s: 1, l: 1, kind: 'slide', id: 's1', ord: 'V', node: { id: 's1', elements: {} } }),
    ).toBe(false)
  })

  it('requires a slide node id equal to the op id', () => {
    expect(
      isBentoOp({ op: 'ins', a: 'u1', s: 1, l: 1, kind: 'slide', id: 's1', ord: 'V', node: { id: 'other', elements: [] } }),
    ).toBe(false)
    expect(
      isBentoOp({ op: 'ins', a: 'u1', s: 1, l: 1, kind: 'slide', id: 's1', ord: 'V', node: { id: 's1', elements: [] } }),
    ).toBe(true)
  })

  it('requires every slide-node member to be an object with a string id', () => {
    expect(
      isBentoOp({ op: 'ins', a: 'u1', s: 1, l: 1, kind: 'slide', id: 's1', ord: 'V', node: { id: 's1', elements: [{}] } }),
    ).toBe(false)
    expect(
      isBentoOp({ op: 'ins', a: 'u1', s: 1, l: 1, kind: 'slide', id: 's1', ord: 'V', node: { id: 's1', elements: ['nope'] } }),
    ).toBe(false)
    expect(
      isBentoOp({ op: 'ins', a: 'u1', s: 1, l: 1, kind: 'slide', id: 's1', ord: 'V', node: { id: 's1', elements: [{ id: 'e1' }, { id: 'e2' }] } }),
    ).toBe(true)
  })

  it('requires an element ins to carry sl and a composite op id = elKey(sl, node.id)', () => {
    // Missing parent slide id.
    expect(isBentoOp({ op: 'ins', a: 'u1', s: 1, l: 1, kind: 'element', id: elKey('s1', 'e1'), ord: 'V', node: { id: 'e1' } })).toBe(false)
    // op id is NOT the composite elKey(sl, node.id) — diverges from every peer's diff.
    expect(isBentoOp({ op: 'ins', a: 'u1', s: 1, l: 1, kind: 'element', id: 's1e1', sl: 's1', ord: 'V', node: { id: 'e1' } })).toBe(false)
    // node without a string id.
    expect(isBentoOp({ op: 'ins', a: 'u1', s: 1, l: 1, kind: 'element', id: elKey('s1', 'e1'), sl: 's1', ord: 'V', node: {} })).toBe(false)
    // Well-formed composite element ins.
    expect(isBentoOp({ op: 'ins', a: 'u1', s: 1, l: 1, kind: 'element', id: elKey('s1', 'e1'), sl: 's1', ord: 'V', node: { id: 'e1' } })).toBe(true)
  })

  it('rejects a reserved prototype key ANYWHERE inside an ins.node payload (P1-2)', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      // top-level payload key
      expect(
        isBentoOp({ op: 'ins', a: 'u1', s: 1, l: 1, kind: 'element', id: elKey('s1', 'e1'), sl: 's1', ord: 'V', node: { id: 'e1', [key]: 1 } }),
      ).toBe(false)
      // nested inside a member of a slide node
      expect(
        isBentoOp({
          op: 'ins', a: 'u1', s: 1, l: 1, kind: 'slide', id: 's1', ord: 'V',
          node: { id: 's1', elements: [{ id: 'e1', style: { [key]: 'x' } }] },
        }),
      ).toBe(false)
    }
    // JSON.parse materializes "__proto__" as an OWN key — the scan must catch it.
    const parsed = JSON.parse('{"id":"e1","__proto__":{"x":1}}')
    expect(isBentoOp({ op: 'ins', a: 'u1', s: 1, l: 1, kind: 'element', id: elKey('s1', 'e1'), sl: 's1', ord: 'V', node: parsed })).toBe(false)
  })

  it('rejects a set whose key overwrites a DocShape container (slides/elements)', () => {
    // `d['slides'] = v` / `slide['elements'] = v` would replace the array P()/C() operate on.
    expect(isBentoOp({ op: 'set', a: 'u1', s: 1, l: 1, k: 'slides', v: [] })).toBe(false)
    expect(isBentoOp({ op: 'set', a: 'u1', s: 1, l: 1, sl: 's1', k: 'elements', v: [] })).toBe(false)
    // A dotted key that merely STARTS with a container name writes a plain own key.
    expect(isBentoOp({ op: 'set', a: 'u1', s: 1, l: 1, k: 'slides.count', v: 1 })).toBe(true)
  })
})
