/**
 * Enveloped doc-load + role-resolution guard for PPT READ routes (R3-B1).
 *
 * The legacy `requireDocRole` guard (src/api/guard.ts) writes BARE-JSON errors
 * (`{ error: 'not_found' }`), which would leak the legacy shape into the C-style
 * PPT contract. This guard resolves the SAME thing — doc existence, same-space
 * scoping, archived state, doc-type kind, and the caller's effective role — but
 * signals every failure by THROWING a {@link PptApiError} so the router-scoped
 * `pptErrorHandler` renders the enveloped `{ error: { code, message } }` form.
 *
 * It deliberately does NOT enforce a minimum role: the source route's access
 * policy is mode-dependent (published → reader+, draft/live → writer+), so the
 * guard returns the resolved role and the handler applies the per-mode floor.
 * A cross-space doc is reported as `NOT_FOUND` (never `FORBIDDEN`) so a doc's
 * existence never leaks outside the caller's space — matching the legacy guard.
 */
import { docMetaRepo, type DocMeta } from '../../db/repos/docMetaRepo.js'
import { resolveRole } from '../../permission/resolveRole.js'
import { resolveEffectiveRole, resolveEffectiveRoleWithMembership } from '../../permission/resolveEffectiveRole.js'
import type { ResolvedRole } from '../../permission/role.js'
import { HTML_PPT_DOC_TYPE } from '../../db/docType.js'
import { PptApiError } from './envelope.js'

export interface PptDocGuard {
  meta: DocMeta
  /** The caller's effective role (incl. `'none'`); the handler enforces the floor. */
  role: ResolvedRole
  /**
   * The space-membership decision the effective role was resolved with, resolved
   * in the SAME call as `role` (never a second, possibly-disagreeing lookup).
   * `false` when membership is not load-bearing (restricted deck, or a direct
   * writer/admin whose access does not depend on an `anyone_in_space` share) —
   * so a direct writer/admin needs no membership IO. The PPT collab-token signs
   * THIS exact boolean into the ticket claim so a live downgrade recheck agrees
   * with issuance (XIN-1739 spaceMember single resolution).
   */
  spaceMember: boolean
}

export interface PptDocGuardCaller {
  /** Human octo session token — threaded to the share-scope membership resolver. */
  token?: string
  /**
   * How an `isSpaceMember` lookup ERROR is handled while resolving an
   * `anyone_in_space` share grant (XIN-1835 spec deviation):
   *   · `'fail-closed'` — the relay TICKET path: degrade to non-member on a lookup
   *     throw. The ticket must carry a concrete signable boolean and a live downgrade
   *     recheck must match issuance, so a throw here would break issuance/reauth
   *     rather than degrade gracefully. Consumes the returned `spaceMember`.
   *   · `'propagate'` (DEFAULT) — the LIVE REST read route (`GET .../source`): let an
   *     identity-service outage PROPAGATE as a 5xx instead of silently degrading a
   *     legitimate `anyone_in_space` reader to 403/404. The fail-closed swallow was
   *     never meant to ride the live REST route; narrowing it to the ticket path keeps
   *     that route surfacing real errors. `spaceMember` is not load-bearing here and is
   *     reported `false`.
   */
  membershipErrorMode?: 'fail-closed' | 'propagate'
}

/**
 * Load a doc for a PPT read and resolve the caller's effective role.
 *
 * Throws (rendered as the C-style envelope):
 *   · `NOT_FOUND`                 — doc missing / soft-deleted, OR in another space.
 *   · `CONFLICT`                  — doc archived (status 2), mirroring legacy 409.
 *   · `UNSUPPORTED_DOCUMENT_TYPE` — doc is not `html_ppt` (wrong-kind, 422).
 *
 * Returns `{ meta, role }` on success — `role` may be `'none'` (no access), which
 * the handler rejects for whatever mode was requested.
 */
export async function loadPptDocForRead(
  uid: string,
  spaceId: string,
  docId: string,
  caller: PptDocGuardCaller = {},
): Promise<PptDocGuard> {
  const meta = await docMetaRepo.getByDocId(docId)
  if (!meta || meta.status === 0) {
    throw new PptApiError('NOT_FOUND', 'document not found')
  }
  // Cross-space is indistinguishable from missing (P2 404 gate): never leak that
  // a doc exists outside the caller's space.
  if (meta.space_id !== spaceId) {
    throw new PptApiError('NOT_FOUND', 'document not found')
  }
  if (meta.status === 2) {
    throw new PptApiError('CONFLICT', 'document is archived')
  }
  // Wrong-kind guard (§4 / §5): a non-`html_ppt` doc must not be served through
  // the PPT source route. This also catches a `:ppt:`-named row whose doc_type
  // drifted, since the type — not the name — is authoritative here.
  if (meta.doc_type !== HTML_PPT_DOC_TYPE) {
    throw PptApiError.unsupportedDocumentType('document is not an html_ppt deck')
  }
  const direct = await resolveRole(uid, docId)
  // #64 share-scope layering: effectiveRole = max(direct, share-derived). Zero
  // extra IO for the default restricted doc or a caller already at writer/admin.
  // Membership-lookup ERROR handling is caller-scoped (XIN-1835 spec deviation):
  //   · ticket path ('fail-closed') resolves BOTH role and the `spaceMember` the
  //     collab-token signs, in ONE call, so a downgrade recheck agrees with issuance
  //     (XIN-1739 spaceMember single resolution), and a lookup throw degrades to
  //     non-member rather than breaking issuance.
  //   · the live REST read route ('propagate', the default) uses the non-swallowing
  //     resolver so an identity outage surfaces as a 5xx, never a silent 403/404 for a
  //     legitimate reader; `spaceMember` is not load-bearing there.
  let role: ResolvedRole
  let spaceMember: boolean
  if (caller.membershipErrorMode === 'fail-closed') {
    ;({ role, spaceMember } = await resolveEffectiveRoleWithMembership(uid, direct, meta, { token: caller.token }))
  } else {
    role = await resolveEffectiveRole(uid, direct, meta, { token: caller.token })
    spaceMember = false
  }
  return { meta, role, spaceMember }
}
