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
import { issuePptCollabToken, mintCollabActor } from '../../auth/pptCollabToken.js'
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

  // Stable per-client session id (XIN-1792 P0-2 / D3 owner contract). The client
  // persists ONE id across reconnects (e.g. in sessionStorage) and sends the SAME
  // value on every collab-token request for this deck+tab; the server derives the
  // Bento actor from `(uid, docId, clientSessionId)` so the actor is STABLE across
  // reconnects rather than a fresh random per issuance. A CRDT actor identifies a
  // replica, so a churning actor discards unsent work on every blip (P0-2) — a stable
  // client session id is what pins it. Required, length-bounded, and charset-bounded
  // to an opaque URL-safe token (it is mixed into a NUL-delimited HMAC input, so a
  // control byte would make that input ambiguous — XIN-1800 P2-4).
  const sessionRaw = body.clientSessionId
  if (typeof sessionRaw !== 'string' || sessionRaw.trim() === '') {
    throw new PptApiError('VALIDATION_ERROR', 'clientSessionId is required', {
      details: { field: 'clientSessionId' },
    })
  }
  const clientSessionId = sessionRaw.trim()
  if (clientSessionId.length > 200) {
    throw new PptApiError('VALIDATION_ERROR', 'clientSessionId exceeds 200 chars', {
      details: { field: 'clientSessionId' },
    })
  }
  // Charset-bound it to an opaque token (XIN-1800 P2-4). `mintCollabActor` mixes it
  // into a NUL-DELIMITED HMAC input (`uid\0docId\0session`); a session id carrying a
  // NUL byte (or other control bytes) would make that input ambiguous. Restricting to
  // an opaque URL-safe charset removes the ambiguity in one check. Not exploitable as
  // written — `uid` is authenticated so cross-user forgery is out, and actors are
  // per-room so a same-user cross-doc collision is harmless — but the constraint costs
  // nothing and closes the question. Clients already use random URL-safe ids here.
  if (!/^[A-Za-z0-9._~-]+$/.test(clientSessionId)) {
    throw new PptApiError('VALIDATION_ERROR', 'clientSessionId must be an opaque URL-safe token', {
      details: { field: 'clientSessionId' },
    })
  }

  // Shared load + role resolution (throws NOT_FOUND / CONFLICT /
  // UNSUPPORTED_DOCUMENT_TYPE); `role` may be 'none'. `spaceMember` is the SAME
  // membership decision the effective role was resolved with (XIN-1739): the
  // relay ticket signs THIS value so a later live downgrade recheck agrees with
  // issuance, and a direct writer/admin resolved no membership IO.
  const { meta, role, spaceMember } = await loadPptDocForRead(uid, spaceId, docId, { token })

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

  // Server-minted actor for this session (XIN-1789 D1 / XIN-1792 P0-2), derived from
  // the authenticated uid + a client-persisted session id so it is stable across
  // reconnects and unforgeable.
  const actor = mintCollabActor(uid, docId, clientSessionId)
  // Pre-connect per-actor `s` hint (XIN-1807 P0-1): a LOWER BOUND from the durable
  // snapshot's version vector — `1` for a fresh actor with no covered ops. It is NOT
  // authoritative (it cannot see ops still in the un-snapshotted tail; the relay's
  // `ready.nextS` is the value the client must adopt), so it only lets a client
  // pre-seed a fresh replica before the socket opens. Computing the tail-inclusive
  // value here would require the per-join durable-tail scan P1-1 warns against.
  const coveredActorSeq = liveSnapshot?.state?.vv?.[actor]
  const nextS = (typeof coveredActorSeq === 'number' && coveredActorSeq >= 0 ? coveredActorSeq : 0) + 1

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
    // Bind the collab session to an actor derived from the authenticated uid AND a
    // client-persisted session id, so the relay can enforce `op.a === server-minted
    // actor`, the client can neither choose nor forge which actor its ops are
    // attributed to (XIN-1789 D1), and the actor is STABLE across reconnects for the
    // same clientSessionId (XIN-1792 P0-2). The actor is echoed back in the response
    // (`result.actor`, P0-1) so the client authors under it.
    actor,
    // Pre-connect per-actor `s` lower-bound hint (XIN-1807 P0-1); the authoritative
    // value is `ready.nextS`, which the client adopts on connect.
    nextS,
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
