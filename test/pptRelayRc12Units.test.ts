import './helpers/pptRelayEnv.js'

import { describe, it, expect } from 'vitest'
import { Semaphore } from '../src/ppt/relay/pptRelay.js'
import { canonicalPayloadHash, canonicalStringify } from '../src/ppt/relay/store.js'

/**
 * RC round-12 unit coverage for the two smallest, most self-contained fixes:
 *   · P1-D — the replay semaphore must never admit more than `max` holders.
 *   · P1-A — the frame payload hash must cover the semantic `ops` ONLY, with
 *     stable key order, not the whole wire envelope.
 */

describe('Semaphore (XIN-1736 P1-D): never admits more than max holders', () => {
  it('does NOT admit max+1 when a fresh acquire races the hand-off to a woken waiter', async () => {
    const sem = new Semaphore(1)
    const rel1 = await sem.acquire() // active = 1 (the only slot)
    const waiterB = sem.acquire() // parks: no free slot
    // Release the held slot. The permit is handed DIRECTLY to waiter B; `active`
    // must stay 1. The pre-fix code dropped `active` to 0 here and let B's woken
    // continuation re-increment it, so a fresh acquire slipping in between (below)
    // grabbed a "free" slot and B then pushed the count to 2 (max+1 barge).
    rel1()
    const waiterC = sem.acquire() // fresh acquire racing the hand-off
    // Flush all microtasks so a woken waiter's continuation (if any) has run.
    await new Promise((r) => setTimeout(r, 0))
    expect(sem.held).toBe(1) // pre-fix: 2
    // Cleanup: B holds the permit; releasing it hands off to C, which then holds.
    const relB = await waiterB
    relB()
    const relC = await waiterC
    relC()
    expect(sem.held).toBe(0)
  })

  it('peak concurrency never exceeds max under heavy contention', async () => {
    const MAX = 3
    const sem = new Semaphore(MAX)
    let concurrent = 0
    let peak = 0
    const worker = async (): Promise<void> => {
      const release = await sem.acquire()
      concurrent++
      peak = Math.max(peak, concurrent)
      // Yield across several microtasks so overlapping holders would surface.
      await Promise.resolve()
      await Promise.resolve()
      concurrent--
      release()
    }
    await Promise.all(Array.from({ length: 50 }, worker))
    expect(peak).toBeLessThanOrEqual(MAX)
    expect(sem.held).toBe(0)
  })

  it('a timed-out waiter is removed and does not leak the permit it never took', async () => {
    const sem = new Semaphore(1)
    const rel1 = await sem.acquire()
    // B waits with a short deadline and times out before any slot frees.
    await expect(sem.acquire(10)).rejects.toMatchObject({ retryable: true })
    // Releasing the held slot must make it available again — the timed-out
    // waiter must not have consumed (and leaked) the handed-off permit.
    rel1()
    const rel2 = await sem.acquire(50) // succeeds promptly
    expect(sem.held).toBe(1)
    rel2()
  })
})

describe('canonicalPayloadHash (XIN-1736 P1-A): hashes canonical ops, not the envelope', () => {
  const base = { t: 'ops', pv: 2, k: 1, frameId: 'f1', epoch: 0, ops: [{ kind: 'set', key: 's1e1', prop: 'x', value: 1 }] }

  it('is stable across a different epoch, k, and reordered object keys (same ops => same hash)', () => {
    const resendAfterEpochBump = { pv: 2, t: 'ops', k: 9, frameId: 'f1', epoch: 7, ops: [{ value: 1, prop: 'x', key: 's1e1', kind: 'set' }] }
    expect(canonicalPayloadHash(resendAfterEpochBump)).toBe(canonicalPayloadHash(base))
  })

  it('differs when the ops themselves differ', () => {
    const differentOps = { ...base, ops: [{ kind: 'set', key: 's1e1', prop: 'x', value: 2 }] }
    expect(canonicalPayloadHash(differentOps)).not.toBe(canonicalPayloadHash(base))
  })

  it('canonicalStringify sorts object keys at every depth but preserves array order', () => {
    expect(canonicalStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
    expect(canonicalStringify([{ b: 1, a: 2 }, { a: 3 }])).toBe('[{"a":2,"b":1},{"a":3}]')
  })
})
