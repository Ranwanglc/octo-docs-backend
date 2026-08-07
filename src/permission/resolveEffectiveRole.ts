/**
 * The single membership-aware effective-role resolver (#64, design §5.1).
 *
 * Shared by every write-time role-resolution seam — the REST guard
 * (requireDocRole) and the three transactional write services (editDocBody /
 * editBoardScene / editDocSheet under their FOR UPDATE lock) — so no seam can
 * disagree about whether an `anyone_in_space` share member is a writer. Lives in
 * the permission layer (not api/guard) so the guard and the services depend on
 * it without a cross-layer import, and so a test that mocks api/guard does not
 * accidentally strip it from the services.
 *
 *   effectiveRole = max(directRole, share-derived)   // only ever raises access
 *
 * Membership is resolved LAZILY: only when the doc is `anyone_in_space` AND the
 * direct role is below what the share path can ever grant (`writer`). A
 * restricted doc (the default) and any caller already at writer/admin therefore
 * add ZERO new IO and stay byte-identical to the pre-feature result. A verified
 * bot's membership is implied by the cross-space gate (req.spaceId ===
 * meta.space_id, enforced before this runs); a human's is resolved via
 * isSpaceMember, which fails closed to `false` on any lookup error, so the share
 * path can only open access on a confirmed membership, never on a failure.
 */
import { effectiveRole, SHARE_SCOPE_ANYONE } from './shareScope.js'
import { roleAtLeast, type ResolvedRole } from './role.js'
import { getOctoIdentity } from '../auth/octoIdentity.js'

/**
 * The doc_meta fields the share path reads. A structural type so both the full
 * DocMeta row (REST guard) and the narrow FOR-UPDATE locked row read by the
 * transactional write services satisfy it.
 */
export interface ShareResolvable {
  space_id: string
  share_scope: number
  share_role: number
}

/** Caller-principal hint: a verified bot derives membership from its space. */
export interface ShareCaller {
  isBot?: boolean
  /**
   * The human caller's octo session token. Used to resolve their OWN space
   * membership via verify?include=context (isSpaceMember). Never read for a bot
   * (isBot short-circuits before any membership call), so the bot path — which
   * carries no session token — passes it as undefined.
   */
  token?: string
}

/**
 * The effective role PLUS the single space-membership decision it was resolved
 * with. The relay's ticket carries `space_member` so it can re-resolve the SAME
 * effective role later (folding in an `anyone_in_space` share grant) without the
 * caller's octo session token. Returning both from ONE call is what makes the
 * ticket internally self-consistent: the membership boolean that DECIDED the role
 * is the exact boolean signed into the claim, so a live downgrade recheck cannot
 * disagree with issuance (XIN-1739 spaceMember single resolution).
 */
export interface EffectiveRoleWithMembership {
  role: ResolvedRole
  /** The single membership decision used for BOTH the role and the token claim. */
  spaceMember: boolean
}

/**
 * Resolve the effective role AND the space-membership it depended on in ONE
 * operation, so the two can never diverge across separate lookups.
 *
 * Membership is load-bearing ONLY for an `anyone_in_space` deck where the direct
 * role is below what the share path can ever grant (`writer`). Otherwise the
 * share grant contributes nothing, so membership costs ZERO IO and is reported as
 * `false` (not load-bearing) — including for a direct writer/admin, who therefore
 * needs no membership call. When membership IS load-bearing it is resolved once;
 * a lookup failure fails CLOSED to `false`, and because that single `false` feeds
 * BOTH the effective role and the returned claim, role and claim fail closed
 * together (never `role: writer` with `space_member: false`).
 */
export async function resolveEffectiveRoleWithMembership(
  uid: string,
  direct: ResolvedRole,
  meta: ShareResolvable,
  caller: ShareCaller = {},
): Promise<EffectiveRoleWithMembership> {
  if (meta.share_scope !== SHARE_SCOPE_ANYONE || roleAtLeast(direct, 'writer')) {
    return { role: direct, spaceMember: false }
  }
  let member: boolean
  try {
    member = caller.isBot
      ? true
      : await getOctoIdentity().isSpaceMember(uid, meta.space_id, caller.token ?? '')
  } catch {
    // Fail-closed: a lookup error never widens access, and the SAME false drives
    // both the role and the claim so they stay consistent.
    member = false
  }
  return { role: effectiveRole(direct, member, meta.share_scope, meta.share_role), spaceMember: member }
}

export async function resolveEffectiveRole(
  uid: string,
  direct: ResolvedRole,
  meta: ShareResolvable,
  caller: ShareCaller = {},
): Promise<ResolvedRole> {
  return (await resolveEffectiveRoleWithMembership(uid, direct, meta, caller)).role
}
