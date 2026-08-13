import './helpers/pptRelayEnv.js'

import { describe, it, expect, beforeEach } from 'vitest'

/**
 * XIN-1739 spaceMember single resolution.
 *
 * The PPT collab-token used to resolve `spaceMember` TWICE for a share-derived
 * caller — once inside `resolveEffectiveRole` (to compute the role) and again in
 * the token handler (to sign the claim). The two lookups can disagree on a cache
 * miss / transient failure, minting `role: writer` with `space_member: false` (or
 * the reverse) — an internally-inconsistent ticket that a later live downgrade
 * recheck then mis-resolves, wrongly revoking a legitimate share writer.
 *
 * `resolveEffectiveRoleWithMembership` resolves membership ONCE and returns both
 * the effective role and the exact boolean it used, so the role decision and the
 * signed claim can never diverge. These tests pin that single-resolution contract
 * against a stubbable `isSpaceMember`.
 */
import { setOctoIdentity } from '../src/auth/octoIdentity.js'
import { resolveEffectiveRoleWithMembership } from '../src/permission/resolveEffectiveRole.js'
import { SHARE_SCOPE_ANYONE, SHARE_ROLE_EDIT, SHARE_ROLE_READ } from '../src/permission/shareScope.js'

const SPACE = 's1'

/** Inject an identity whose isSpaceMember runs `fn` (counting hits). */
let membershipHits = 0
function withMembership(fn: () => Promise<boolean> | boolean): void {
  membershipHits = 0
  setOctoIdentity({
    isSpaceMember: async () => {
      membershipHits++
      return fn()
    },
  } as never)
}

const anyoneEdit = { space_id: SPACE, share_scope: SHARE_SCOPE_ANYONE, share_role: SHARE_ROLE_EDIT }
const anyoneRead = { space_id: SPACE, share_scope: SHARE_SCOPE_ANYONE, share_role: SHARE_ROLE_READ }
const restricted = { space_id: SPACE, share_scope: 0, share_role: SHARE_ROLE_READ }

beforeEach(() => {
  membershipHits = 0
})

describe('resolveEffectiveRoleWithMembership — single space-membership resolution (XIN-1739)', () => {
  it('a confirmed member of an anyone_in_space/edit deck resolves writer AND space_member:true together', async () => {
    withMembership(() => true)
    const out = await resolveEffectiveRoleWithMembership('u_m', 'none', anyoneEdit, { token: 't' })
    expect(out).toEqual({ role: 'writer', spaceMember: true })
    expect(membershipHits).toBe(1) // resolved exactly once, not twice
  })

  it('a non-member of an anyone_in_space/edit deck resolves none AND space_member:false together', async () => {
    withMembership(() => false)
    const out = await resolveEffectiveRoleWithMembership('u_x', 'none', anyoneEdit, { token: 't' })
    expect(out).toEqual({ role: 'none', spaceMember: false })
    expect(membershipHits).toBe(1)
  })

  it('a membership lookup failure fails role AND claim closed together (never writer + space_member:false)', async () => {
    // The single false the failed lookup produces drives BOTH the role and the
    // claim, so they can never disagree — the exact inconsistency the two-lookup
    // path could mint.
    withMembership(() => {
      throw new Error('octo-server down')
    })
    const out = await resolveEffectiveRoleWithMembership('u_m', 'none', anyoneEdit, { token: 't' })
    expect(out).toEqual({ role: 'none', spaceMember: false })
  })

  it('a share/read deck grants at most reader; the same membership boolean is returned', async () => {
    withMembership(() => true)
    const out = await resolveEffectiveRoleWithMembership('u_m', 'none', anyoneRead, { token: 't' })
    expect(out).toEqual({ role: 'reader', spaceMember: true })
  })

  it('a DIRECT writer/admin needs no membership IO and reports space_member:false (not load-bearing)', async () => {
    withMembership(() => {
      throw new Error('isSpaceMember must not be called when the share grant is not load-bearing')
    })
    const writer = await resolveEffectiveRoleWithMembership('u_w', 'writer', anyoneEdit, { token: 't' })
    expect(writer).toEqual({ role: 'writer', spaceMember: false })
    const admin = await resolveEffectiveRoleWithMembership('u_a', 'admin', anyoneEdit, { token: 't' })
    expect(admin).toEqual({ role: 'admin', spaceMember: false })
    expect(membershipHits).toBe(0)
  })

  it('a restricted deck resolves the direct role with zero membership IO and space_member:false', async () => {
    withMembership(() => {
      throw new Error('isSpaceMember must not be called for a restricted deck')
    })
    const out = await resolveEffectiveRoleWithMembership('u_r', 'reader', restricted, { token: 't' })
    expect(out).toEqual({ role: 'reader', spaceMember: false })
    expect(membershipHits).toBe(0)
  })

  it('a verified bot derives membership from its space without a token lookup', async () => {
    withMembership(() => {
      throw new Error('isSpaceMember must not be called for a verified bot')
    })
    const out = await resolveEffectiveRoleWithMembership('bot_1', 'none', anyoneEdit, { isBot: true })
    expect(out).toEqual({ role: 'writer', spaceMember: true })
    expect(membershipHits).toBe(0)
  })
})
