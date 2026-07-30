/**
 * Forward-grant core (§2 max-merge, §6 epoch, §9.1/§9.3).
 *
 * Shared by two callers so the "only-up, never-down" semantics live in ONE place:
 *   - POST /:docId/forward-grant           (forward-to-chat authorization)
 *   - POST /:docId/access-requests/:id/approve (screen 4c approval)
 *
 * Semantics:
 *   1. Resolve the target's CURRENT role first.
 *   2. If the target is an owner or already an admin (resolveRole => 'admin'):
 *      skip the write entirely — never downgrade, never insert a misleading
 *      low-role row for an owner (who has no doc_member row). Return unchanged.
 *   3. Otherwise upsertGrantMax (GREATEST) applies the grant only-up.
 *   4. Bump the permission epoch ONLY on a genuine change (affectedRows>0), so
 *      the recipient's stale collab token / permission cache is invalidated
 *      (§4.5 bumpEpoch; recheck in beforeHandleMessage is the backstop).
 *
 * This never throws for the "already >= target" case — that is an idempotent
 * success (per-uid 200), matching the権限 matrix §7.
 */
import { docMemberRepo } from '../../db/repos/docMemberRepo.js'
import { resolveRole } from '../../permission/resolveRole.js'
import { bumpEpoch } from '../../permission/epoch.js'
import { roleFromNumber, roleRank, type Role } from '../../permission/role.js'

export interface GrantForwardParams {
  docId: string
  documentName: string
  uid: string
  roleNum: number // ordered doc-role code: 1=reader 2=commenter 3=writer (admin is not grantable via forward)
  grantedBy: string
}

export interface GrantForwardResult {
  /** The recipient's effective role after the (idempotent) grant. */
  finalRole: Role
  /** True only when a row was inserted or genuinely upgraded (epoch was bumped). */
  changed: boolean
}

export async function grantForwardAccess(params: GrantForwardParams): Promise<GrantForwardResult> {
  // Reject an illegal role number outright rather than silently coercing it —
  // the write path must never persist an out-of-enum role (fail closed).
  const requested = roleFromNumber(params.roleNum)
  if (!requested) throw new Error(`grantForwardAccess: invalid roleNum ${params.roleNum}`)

  const current = await resolveRole(params.uid, params.docId)
  // owner (=> admin) or existing admin: keep as-is, no write, no misleading audit row.
  if (current === 'admin') {
    return { finalRole: 'admin', changed: false }
  }

  const changed = await docMemberRepo.upsertGrantMax({
    docId: params.docId,
    uid: params.uid,
    roleNum: params.roleNum,
    grantedBy: params.grantedBy,
  })
  if (changed) {
    await bumpEpoch(params.docId, params.documentName, params.uid)
  }

  // Effective role = max(existing, granted). current is reader/commenter/writer/none
  // here; compare by rank on the ordered encoding, then map the winner back to a
  // role. GREATEST in the SQL already enforced the persisted max; this mirrors it
  // for the response without a second read.
  const finalRole: Role = roleRank(current) >= roleRank(requested) ? (current as Role) : requested
  return { finalRole, changed }
}
