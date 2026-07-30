/**
 * Role definitions and numeric <-> string mappings (§4.2).
 *
 * doc_member.role is stored as TINYINT with a naturally ORDERED encoding:
 *   1=reader 2=commenter 3=writer 4=admin
 * The ordering is load-bearing: roleRank() returns this exact code so
 * `roleAtLeast` (>=) and every GREATEST()/Math.max() max-merge path stay a plain
 * numeric comparison. `none` is not stored — it is the absence of any membership
 * row and a non-owner identity (§4.2 resolveRole returns none) and ranks 0.
 *
 * `writer` is the internal/back-compat name for the "can edit" tier; the HTML UI
 * renders it as “可编辑”. `commenter` sits strictly between reader and writer.
 */

export type Role = 'reader' | 'commenter' | 'writer' | 'admin'
export type ResolvedRole = Role | 'none'

export const ROLE_READER = 1
export const ROLE_COMMENTER = 2
export const ROLE_WRITER = 3
export const ROLE_ADMIN = 4

const NUM_TO_ROLE: Record<number, Role> = {
  [ROLE_READER]: 'reader',
  [ROLE_COMMENTER]: 'commenter',
  [ROLE_WRITER]: 'writer',
  [ROLE_ADMIN]: 'admin',
}

const ROLE_TO_NUM: Record<Role, number> = {
  reader: ROLE_READER,
  commenter: ROLE_COMMENTER,
  writer: ROLE_WRITER,
  admin: ROLE_ADMIN,
}

export function roleFromNumber(n: number): Role | undefined {
  return NUM_TO_ROLE[n]
}

export function roleToNumber(role: Role): number {
  return ROLE_TO_NUM[role]
}

/** Numeric rank for comparison; `none` is 0 (§4.6 accept branches compare curRole vs invite.role). */
export function roleRank(role: ResolvedRole): number {
  return role === 'none' ? 0 : ROLE_TO_NUM[role]
}

/** True if `a` is at least as privileged as `b` (a >= b). */
export function roleAtLeast(a: ResolvedRole, b: ResolvedRole): boolean {
  return roleRank(a) >= roleRank(b)
}

/**
 * Grantable-role predicates. Central so no route re-implements its own
 * `v === 'x' || v === 'y'` allow-list and drifts from the model. All FOUR roles
 * are directly assignable as a doc_member (PUT /members, invites); admin is NOT
 * grantable via the forward or access-request escalation paths (those top out at
 * writer). Unknown values fail closed (false / null).
 */

/** Any of the four doc_member roles (PUT /members, invite grant). */
export function isMemberRole(v: unknown): v is Role {
  return v === 'reader' || v === 'commenter' || v === 'writer' || v === 'admin'
}

/** reader|commenter|writer — the roles forward-grant may bestow (never admin). */
export function isForwardGrantRole(v: unknown): v is 'reader' | 'commenter' | 'writer' {
  return v === 'reader' || v === 'commenter' || v === 'writer'
}

/** reader|commenter|writer — the roles an access request may ask for (never admin). */
export function isAccessRequestRole(v: unknown): v is 'reader' | 'commenter' | 'writer' {
  return v === 'reader' || v === 'commenter' || v === 'writer'
}
