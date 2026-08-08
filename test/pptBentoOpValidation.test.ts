/**
 * Bento `Op` wire validation (XIN-1759 Part B / XIN-1764 Option 2): the relay now
 * accepts Bento's own op shape and REJECTS the legacy octo envelope
 * (`{kind,key,prop,delta}`), which is protocol-incompatible with the server-side
 * reducer. Envelope validation stays separate from the CRDT reducer's semantics.
 */
import { describe, it, expect } from 'vitest'
import { opsAreValid, isBentoOp } from '../src/ppt/relay/frames.js'

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
