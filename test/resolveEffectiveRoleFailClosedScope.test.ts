import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * XIN-1825 P1-3 — the membership-lookup fail-closed swallow is SCOPED to the PPT
 * relay ticket path.
 *
 * `resolveEffectiveRoleWithMembership` (the relay ticket caller) must fail CLOSED
 * to non-member on an identity-service throw — it has to produce a concrete,
 * signable boolean and a live downgrade recheck must match issuance. The legacy
 * `resolveEffectiveRole` (the REST guard + the three transactional write
 * services) must NOT swallow: an unexpected throw PROPAGATES, byte-identical to
 * merge-base, so an identity outage surfaces as a 5xx rather than silently
 * degrading an `anyone_in_space` share writer to 403. This pins that split so a
 * future refactor cannot re-collapse the legacy paths onto the relay's swallow.
 */
import { setOctoIdentity } from '../src/auth/octoIdentity.js'
import {
  resolveEffectiveRole,
  resolveEffectiveRoleWithMembership,
} from '../src/permission/resolveEffectiveRole.js'
import { SHARE_SCOPE_ANYONE, SHARE_ROLE_EDIT } from '../src/permission/shareScope.js'

const anyoneEdit = { space_id: 's1', share_scope: SHARE_SCOPE_ANYONE, share_role: SHARE_ROLE_EDIT }

function withThrowingMembership(): void {
  setOctoIdentity({
    isSpaceMember: async () => {
      throw new Error('identity service unavailable')
    },
  } as never)
}

describe('resolveEffectiveRole fail-closed scope (XIN-1825 P1-3)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('the relay ticket path fails CLOSED to non-member and LOGS on an isSpaceMember throw', async () => {
    withThrowingMembership()
    const out = await resolveEffectiveRoleWithMembership('u_m', 'none', anyoneEdit, { token: 't' })
    expect(out).toEqual({ role: 'none', spaceMember: false })
    // The swallow is no longer silent — the failure is surfaced to operators.
    expect(warnSpy).toHaveBeenCalled()
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('isSpaceMember lookup failed')
  })

  it('the legacy write-path resolver PROPAGATES an isSpaceMember throw (no silent 403 degrade)', async () => {
    withThrowingMembership()
    await expect(resolveEffectiveRole('u_m', 'none', anyoneEdit, { token: 't' })).rejects.toThrow(
      /identity service unavailable/,
    )
  })

  it('the legacy resolver never even consults membership when the share grant is not load-bearing', async () => {
    withThrowingMembership()
    // A direct writer already satisfies the share ceiling, so membership (which
    // would throw) is never called — proves the propagation path is lazy, not a
    // regression that adds IO.
    await expect(resolveEffectiveRole('u_w', 'writer', anyoneEdit, { token: 't' })).resolves.toBe('writer')
  })
})
