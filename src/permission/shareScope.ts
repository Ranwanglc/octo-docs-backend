/**
 * Space-scoped document share permissions (#64) — the ONE new permission rule.
 *
 * Today the doc backend has a single permission source: resolveRole = owner =>
 * admin, else the doc_member row, else none (§4.2). Feature #64 adds a SECOND,
 * supplementary source: a per-document share scope (restricted | anyone_in_space)
 * with a share role (read | edit) that grants any Space member an effective role
 * even with no doc_member row.
 *
 * The two sources are merged by `effectiveRole` = max(directRole, shareDerived):
 * the share path only ever RAISES access, never lowers it, so a doc_member/owner
 * is never downgraded by a share setting, and a `restricted` doc is byte-identical
 * to today (shareDerived = 'none'). See the design doc §5.1.
 */
import { roleRank, type ResolvedRole } from './role.js'

/** doc_meta.share_scope values. */
export const SHARE_SCOPE_RESTRICTED = 0
export const SHARE_SCOPE_ANYONE = 1

/**
 * doc_meta.share_role values. This is an INDEPENDENT 2-value enum (read/edit),
 * NOT the doc_member role space — it is deliberately NOT recoded by the four-role
 * migration. EDIT is DERIVED to the doc role `writer` (roleRank('writer')=3) at
 * comparison time (see effectiveRole below); the stored 1/2 never changes.
 */
export const SHARE_ROLE_READ = 1
export const SHARE_ROLE_EDIT = 2

export type ShareScopeName = 'restricted' | 'anyone_in_space'
export type ShareRoleName = 'read' | 'edit'

/** restricted unless the stored value is exactly ANYONE (fail-safe coercion). */
export function shareScopeName(scopeNum: number): ShareScopeName {
  return scopeNum === SHARE_SCOPE_ANYONE ? 'anyone_in_space' : 'restricted'
}

/** read unless the stored value is exactly EDIT (fail-safe coercion). */
export function shareRoleName(roleNum: number): ShareRoleName {
  return roleNum === SHARE_ROLE_EDIT ? 'edit' : 'read'
}

/** Map the "restricted"|"anyone_in_space" wire enum to its stored TINYINT, or null. */
export function parseShareScope(v: unknown): number | null {
  if (v === 'restricted') return SHARE_SCOPE_RESTRICTED
  if (v === 'anyone_in_space') return SHARE_SCOPE_ANYONE
  return null
}

/** Map the "read"|"edit" wire enum to its stored TINYINT, or null. */
export function parseShareRole(v: unknown): number | null {
  if (v === 'read') return SHARE_ROLE_READ
  if (v === 'edit') return SHARE_ROLE_EDIT
  return null
}

/**
 * The single effective-role rule reused by all three enforcement seams
 * (collab-token issuance, the REST guard, the live-socket write recheck).
 *
 *   base         = directRole (owner/admin/doc_member/none — resolveRole today)
 *   shareDerived = writer/reader when the doc is anyone_in_space AND the
 *                  requester is a member of the doc's space; otherwise 'none'
 *   effective    = max(base, shareDerived)          // only ever UP, never down
 *
 * Fail-safe coercion (design §5.1 / §2): any share_scope value other than
 * ANYONE is treated as restricted, and any share_role other than EDIT collapses
 * to reader — so an unexpected stored value fails to the most-restrictive
 * interpretation and never opens access. A `restricted` doc therefore yields
 * shareDerived='none', making the result identical to today's resolveRole.
 */
export function effectiveRole(
  directRole: ResolvedRole,
  isSpaceMember: boolean,
  shareScope: number,
  shareRole: number,
): ResolvedRole {
  let shareDerived: ResolvedRole = 'none'
  if (shareScope === SHARE_SCOPE_ANYONE && isSpaceMember) {
    // any non-EDIT role => reader (fail-safe); EDIT => writer.
    shareDerived = shareRole === SHARE_ROLE_EDIT ? 'writer' : 'reader'
  }
  return roleRank(directRole) >= roleRank(shareDerived) ? directRole : shareDerived
}
