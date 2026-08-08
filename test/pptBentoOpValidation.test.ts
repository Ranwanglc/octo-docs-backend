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
      { op: 'ins', a: 'u1', s: 3, l: 3, kind: 'slide', id: 's2', ord: 'V', node: { id: 's2' } },
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
