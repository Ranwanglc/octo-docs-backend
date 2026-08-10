/**
 * PPT collab-token endpoint: `POST /api/v1/ppt/docs/collab-token` (R4-B1, §7.1).
 *
 * Mints the credentials the Bento-frame relay needs — a short-lived relay token
 * plus a single-use WS ticket — for an authorized caller. This is the `html_ppt`
 * sibling of the legacy Hocuspocus collab-token: the legacy route
 * (issueCollabToken) explicitly REJECTS `html_ppt` with
 * `unsupported_document_type`, so a PPT deck never mints a Yjs token; it comes
 * here instead.
 *
 * The caller identity is the authenticated session (`req.uid`) and the space is
 * the enforced `X-Space-Id` header (`req.spaceId`). The addressed deck is named
 * ONLY by `docId` in the body — the same docId-centric addressing every other
 * PPT endpoint uses. Failure statuses (PPT-TOKEN-002):
 *   · malformed/inconsistent stored document_name → 403 FORBIDDEN
 *   · caller has no role on the deck               → 403 FORBIDDEN
 *   · deck missing / soft-deleted / cross-space    → 404 NOT_FOUND
 *   · deck is not `html_ppt`                        → 422 UNSUPPORTED_DOCUMENT_TYPE
 *
 * On success the enveloped `data` carries token/ticket/expiresAt/role/epoch/
 * pptWsUrl/documentName/snapshotVersion/name (PPT-TOKEN-001).
 */
import { Router, type Request, type Response, type NextFunction, type Router as ExpressRouter } from 'express'
import { loadPptDocForRead } from './pptDocGuard.js'
import { PptApiError, sendPptData } from './envelope.js'
import { pptAuthMiddleware, pptSpaceContextMiddleware } from './auth.js'
import { pptLiveSnapshotRepo } from '../../db/repos/pptLiveSnapshotRepo.js'
import { parseDocumentName, isDocTypeConsistentWithName } from '../../permission/documentName.js'
import { getOctoIdentity } from '../../auth/octoIdentity.js'
import { issuePptCollabToken } from '../../auth/pptCollabToken.js'
import type { Role } from '../../permission/role.js'

/** POST /docs/collab-token — issue relay token + one-time WS ticket. */
export async function collabTokenHandler(req: Request, res: Response): Promise<void> {
  const uid = req.uid!
  const spaceId = req.spaceId!
  const token = req.octoToken
  const body = (req.body ?? {}) as Record<string, unknown>

  const docIdRaw = body.docId
  if (typeof docIdRaw !== 'string' || docIdRaw.trim() === '') {
    throw new PptApiError('VALIDATION_ERROR', 'docId is required', { details: { field: 'docId' } })
  }
  const docId = docIdRaw.trim()

  // Shared load + role resolution (throws NOT_FOUND / CONFLICT /
  // UNSUPPORTED_DOCUMENT_TYPE); `role` may be 'none'. `spaceMember` is the SAME
  // membership decision the effective role was resolved with (XIN-1739): the
  // relay ticket signs THIS value so a later live downgrade recheck agrees with
  // issuance, and a direct writer/admin resolved no membership IO. The ticket path
  // uses the fail-closed membership resolver (XIN-1835 spec deviation): a lookup
  // throw must degrade to non-member so the ticket carries a concrete signable
  // boolean, never break issuance.
  const { meta, role, spaceMember } = await loadPptDocForRead(uid, spaceId, docId, {
    token,
    membershipErrorMode: 'fail-closed',
  })

  // Access floor FIRST: a caller with no role must be told only that it has no
  // access — never a stored-name/type defect below. Checking access before the
  // document_name validation stops a stored-name defect from leaking to a caller
  // who cannot even see the deck.
  if (role === 'none') {
    throw new PptApiError('FORBIDDEN', 'no access to this document')
  }

  // A corrupt document_name / type pairing must not mint a relay credential:
  // treat a malformed or cross-type name as forbidden (never leak more than the
  // guard already did). The type check above is authoritative for the row kind;
  // this closes the stored-name half.
  try {
    const parsed = parseDocumentName(meta.document_name)
    if (!isDocTypeConsistentWithName(parsed, meta.doc_type)) {
      throw new PptApiError('FORBIDDEN', 'document name is inconsistent with its type')
    }
  } catch (err) {
    if (err instanceof PptApiError) throw err
    throw new PptApiError('FORBIDDEN', 'document name is malformed')
  }

  // Live snapshot VERSION tag (snapshot-change detection), sourced from the
  // AUTHORITATIVE live-snapshot row (`ppt_live_snapshot`), which the relay
  // advances on each snapshot save — not `ppt_doc_state.snapshot_version`, which
  // nothing on the live path updates and so is permanently 0 (B8). Absent live
  // snapshot => 0 (a freshly created deck before any live snapshot). This is NOT
  // the replay cursor: the relay's replay `since` is an op-sequence the client
  // seeds from `ready.q` (0 on first join), a distinct coordinate (XIN-1655 C5).
  const liveSnapshot = await pptLiveSnapshotRepo.get(docId)
  const snapshotVersion = liveSnapshot?.snapshotVersion ?? 0

  // Trusted display name (§4.7(b)): resolved from the octo directory at issuance,
  // best-effort — an unavailable name never blocks token issuance.
  let displayName = ''
  try {
    const profile = await getOctoIdentity().getUser(uid, token)
    if (profile && typeof profile.name === 'string') displayName = profile.name.trim()
  } catch {
    /* best-effort: presence falls back to client-supplied name */
  }

  // Space-membership claim (§4.4) is resolved ONCE, together with the effective
  // role, in `loadPptDocForRead` above (XIN-1739 spaceMember single resolution).
  // The relay carries this exact boolean to re-resolve the same effective role on
  // downgrade checks — signing a value that DISAGREED with the role decision (the
  // old two-lookup path) could mint `role: writer` with `space_member: false` and
  // wrongly revoke a live share writer.

  const result = issuePptCollabToken({
    uid,
    docId,
    documentName: meta.document_name,
    role: role as Role,
    permission_epoch: meta.permission_epoch,
    snapshotVersion,
    spaceMember,
    ...(displayName !== '' ? { name: displayName } : {}),
  })
  sendPptData(res, result)
}

/** Adapt an async handler so a thrown error reaches the router-scoped envelope handler. */
function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next)
  }
}

/** Build the PPT collab-token sub-router (`POST /api/v1/ppt/docs/collab-token`). */
export function createPptCollabTokenRouter(): ExpressRouter {
  const router = Router()
  router.post('/docs/collab-token', pptAuthMiddleware, pptSpaceContextMiddleware, asyncHandler(collabTokenHandler))
  return router
}
