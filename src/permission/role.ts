/**
 * Role definitions and numeric <-> string mappings (§4.2).
 *
 * doc_member.role is stored as TINYINT: 1=reader 2=writer 3=admin 4=commenter.
 * `none` is not stored — it is the absence of any membership row and a
 * non-owner identity (§4.2 resolveRole returns none).
 *
 * IMPORTANT — stored value != rank ordinal. `commenter` is a privilege level
 * BETWEEN reader and writer, but it was added AFTER reader/writer/admin were
 * already persisted, so it takes the next free stored value (4) rather than
 * being wedged between 1 and 2. Renumbering the existing rows would be a risky
 * data migration and would ripple across doc_invite / forwardGrant constants.
 * We therefore DECOUPLE comparison rank from the stored number: roleRank()
 * returns an ordinal (reader=10, commenter=20, writer=30, admin=40) that places
 * commenter between reader and writer, while storage keeps 1/2/3/4. roleAtLeast
 * compares ordinals, so it stays monotonic and correct.
 */

export type Role = 'reader' | 'commenter' | 'writer' | 'admin'
export type ResolvedRole = Role | 'none'

export const ROLE_READER = 1
export const ROLE_WRITER = 2
export const ROLE_ADMIN = 3
export const ROLE_COMMENTER = 4

const NUM_TO_ROLE: Record<number, Role> = {
  [ROLE_READER]: 'reader',
  [ROLE_WRITER]: 'writer',
  [ROLE_ADMIN]: 'admin',
  [ROLE_COMMENTER]: 'commenter',
}

const ROLE_TO_NUM: Record<Role, number> = {
  reader: ROLE_READER,
  writer: ROLE_WRITER,
  admin: ROLE_ADMIN,
  commenter: ROLE_COMMENTER,
}

/**
 * Comparison rank ordinal — INTENTIONALLY distinct from the stored value above.
 * commenter (20) sits between reader (10) and writer (30) so roleAtLeast places
 * it correctly, even though its stored TINYINT is 4. See the file header.
 */
const ROLE_RANK: Record<ResolvedRole, number> = {
  none: 0,
  reader: 10,
  commenter: 20,
  writer: 30,
  admin: 40,
}

export function roleFromNumber(n: number): Role | undefined {
  return NUM_TO_ROLE[n]
}

export function roleToNumber(role: Role): number {
  return ROLE_TO_NUM[role]
}

/** Rank ordinal for comparison; `none` is 0 (§4.6 accept branches compare curRole vs invite.role). */
export function roleRank(role: ResolvedRole): number {
  return ROLE_RANK[role]
}

/** True if `a` is at least as privileged as `b` (a >= b). */
export function roleAtLeast(a: ResolvedRole, b: ResolvedRole): boolean {
  return roleRank(a) >= roleRank(b)
}

export function isMemberRole(value: unknown): value is Role {
  return value === 'reader' || value === 'commenter' || value === 'writer' || value === 'admin'
}

export function isForwardGrantRole(value: unknown): value is 'reader' | 'writer' {
  return value === 'reader' || value === 'writer'
}

export function isAccessRequestRole(value: unknown): value is Exclude<Role, 'admin'> {
  return value === 'reader' || value === 'commenter' || value === 'writer'
}
