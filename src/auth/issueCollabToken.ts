/**
 * collab-token issuance service (§4.4).
 *
 * Two-layer chain: octo session token (opaque) -> verify -> trusted uid ->
 * resolveRole (doc_member + owner) -> sign short-lived collab JWT.
 *
 * The document existence/status check is performed HERE (§4.1: "docMetaRepo
 * existence/status check moved forward to the issuance endpoint"), so the WS
 * onAuthenticate does not recompute it.
 *
 * Both documents and whiteboards are served, resolved the SAME way — by
 * document_name — through the shared resolveDocMetaByName resolver (appendix B):
 *   - document  `octo:{space}:{folder}:{doc}`
 *   - whiteboard `octo:{space}:{folder}:wb:{board}`  (the board's document_name
 *     IS this 5-segment key; a board row is doc_type='board')
 * Authorization (resolveRole = doc_member + owner) and signing are identical for
 * both — a board owner gets admin, a board member gets their stored role.
 */
import { signCollabToken, signCollabTokenV2, type CollabTokenResult } from './collabToken.js'
import { getOctoIdentity } from './octoIdentity.js'
import { parseDocumentName, isDocTypeConsistentWithName } from '../permission/documentName.js'
import { resolveRole, resolveDocMetaByName } from '../permission/resolveRole.js'
import { docMetaRepo } from '../db/repos/docMetaRepo.js'
import { recordVerifiedRecentView } from '../api/services/recordRecentView.js'
import { effectiveRole, SHARE_SCOPE_ANYONE } from '../permission/shareScope.js'
import { HTML_DOC_TYPE, HTML_PPT_DOC_TYPE } from '../db/docType.js'

export type IssueResult =
  | { ok: true; result: CollabTokenResult }
  | { ok: false; status: 401 | 403 | 404 | 409 | 422; error: string }

/**
 * Issue a collab token for (octoToken, documentName).
 *   - octoToken invalid/missing  => 401
 *   - documentName malformed      => 403
 *   - doc/board missing/deleted   => 404
 *   - role === none               => 403 (no token)
 *
 * `viewerSpaceId` is the space the caller is CURRENTLY working in (the
 * `X-Space-Id` header the front-end injects on the collab-token request). It is
 * used only for the recent-view fallback ingest below, to keep the WRITE space
 * consistent with the READ space — see that block for the contract.
 */
export async function issueCollabToken(
  octoToken: string,
  documentName: string,
  viewerSpaceId?: string,
): Promise<IssueResult> {
  // Layer-1: octo identity -> trusted uid (never trust a client-supplied uid).
  const identity = await getOctoIdentity().verifyToken(octoToken)
  if (!identity) return { ok: false, status: 401, error: 'login_required' }
  const uid = identity.uid

  // Resolve the trusted DISPLAY NAME for this uid from the octo directory
  // (§4.7(b)), so the collab/presence layer can stamp the awareness frame's
  // user.name with a real name instead of the raw uid a not-yet-resolved client
  // publishes (XIN-694). The name is a separate field; uid stays the identity.
  //
  // verify already returns the caller's name in the common case (no extra IO).
  // Only when it is absent do we fall back to the per-uid directory lookup,
  // authenticated with the caller's own octo session token — the same token we
  // already hold. Both are best-effort: an unavailable name never blocks token
  // issuance (getUser swallows transport errors and returns null), it just
  // means this token carries no name and the presence layer keeps its existing
  // client-supplied-name behavior.
  let displayName = typeof identity.name === 'string' ? identity.name.trim() : ''
  if (displayName === '') {
    const profile = await getOctoIdentity().getUser(uid, octoToken)
    if (profile && typeof profile.name === 'string') displayName = profile.name.trim()
  }

  // Validate / parse documentName first so a structurally malformed key is a
  // 403 (distinct from a well-formed key that resolves to no row => 404).
  let parsed
  try {
    parsed = parseDocumentName(documentName)
  } catch {
    return { ok: false, status: 403, error: 'forbidden' }
  }

  // Resolve the addressed doc_meta row through the SHARED document_name resolver
  // (same path documents and the WS recheck use). An exact document_name match
  // implicitly validates every segment, so there is no board-only doc_id branch
  // anymore. A null here means the well-formed key addresses no live row.
  const meta = await resolveDocMetaByName(documentName)
  if (!meta) return { ok: false, status: 404, error: 'not_found' }
  // A namespaced key must address a row of the matching kind. This is the shared
  // cross-type guard (§5): a `:wb:` key on a non-board row, a `:ppt:` key on a
  // non-`html_ppt` row, or a `:html:` key on a non-`html` row is a corrupt
  // key/row pairing and resolves to "no such document". Previously only the
  // whiteboard arm was hand-rolled here; the `:ppt:`/`:html:` arms had the hole
  // the helper was written to close. Not reachable by any current mint path, but
  // the one site that could serve a corrupt pairing is now closed.
  if (!isDocTypeConsistentWithName(parsed, meta.doc_type)) {
    return { ok: false, status: 404, error: 'not_found' }
  }

  // HTML has its own body/comment backend and no Yjs collaboration design.
  // html_ppt (Bento slide-deck) is an EXPLICIT sibling here: it uses the Bento
  // frame protocol over its OWN relay + `POST /api/v1/ppt/docs/collab-token`
  // endpoint, never the Hocuspocus/Yjs token. Reject BOTH before role resolution
  // so no html / html_ppt role can mint a Hocuspocus token (§1.2 / §6).
  if (meta.doc_type === HTML_DOC_TYPE || meta.doc_type === HTML_PPT_DOC_TYPE) {
    // eslint-disable-next-line no-console
    console.warn('[octo-docs] collab-token rejected: doc type does not support Hocuspocus collaboration', {
      docId: meta.doc_id,
      docType: meta.doc_type,
    })
    return { ok: false, status: 422, error: 'unsupported_document_type' }
  }

  // Authorization: resolveRole = doc_member + owner (same model for docs/boards).
  const direct = await resolveRole(uid, meta.doc_id)

  // #64: space-scoped share. Only when the doc is anyone_in_space do we resolve
  // the requester's Space membership — restricted docs (the default/common case)
  // add ZERO new IO here. collab-token issuance is human-only, so this is the
  // human isSpaceMember path (fail-closed false on any lookup error). The result
  // is both merged into the effective role and baked into the token as the
  // space_member claim, so the live-socket write recheck (§5.3) can re-derive
  // access on a scope narrowing without a fresh membership call.
  let spaceMember = false
  if (meta.share_scope === SHARE_SCOPE_ANYONE) {
    spaceMember = await getOctoIdentity().isSpaceMember(uid, meta.space_id, octoToken)
  }
  const role = effectiveRole(direct, spaceMember, meta.share_scope, meta.share_role)
  if (role === 'none') return { ok: false, status: 403, error: 'forbidden' }

  // Keep legacy issuance aligned with the docId-first and open-context paths.
  // This check deliberately follows authorization so archived state is not
  // disclosed to a caller who has no role.
  if (meta.status === 2) return { ok: false, status: 409, error: 'conflict' }

  // FEAT-B recent-view ingest, now VERIFIED-OR-SKIP (remove-sp §7.1). Every
  // document open — read-only INCLUDED — passes through here, so this remains
  // the reliable "open == viewed" seam. But phase-1 no longer writes an
  // unverified viewer Space nor falls back to the document's home Space: the row
  // lands ONLY when the caller is a confirmed active member of the viewer Space
  // they supplied (X-Space-Id), otherwise it is skipped. Fire-and-forget so it
  // can neither slow nor fail token issuance.
  void recordVerifiedRecentView({
    scope: { mode: 'human' },
    uid,
    docId: meta.doc_id,
    viewerSpaceId,
    token: octoToken,
  })

  // Sign with the document's current epoch (§4.4 / §4.5). The token carries the
  // exact connection documentName (incl. the `:wb:` whiteboard form) so the WS
  // handshake's documentName match (§4.1 step 2) holds. Legacy documentName-
  // addressed issuance signs a v1 token; the docId-first path (§7.1) signs v2.
  const result = signCollabToken({
    uid,
    documentName,
    role,
    permission_epoch: meta.permission_epoch,
    ...(displayName !== '' ? { name: displayName } : {}),
    ...(spaceMember ? { space_member: true } : {}),
  })
  return { ok: true, result }
}

/**
 * docId-first collab-token issuance (remove-sp §7.1). Locates the doc by its
 * business `docId` (never a client-supplied Space / header), reuses the exact
 * role model, and signs a v2 token bound to docId + canonical documentName +
 * home Space + epoch. Called from the authenticated `POST /:docId/collab-token`
 * route, so the caller identity (`uid`, `octoToken`) is already trusted.
 *
 *   - doc missing/deleted        => 404
 *   - role === none              => 403 (no token)
 *   - html / html_ppt            => 422 (authorized caller, but no Hocuspocus/Yjs collaboration)
 *   - archived                   => 409 (authorized, supported document only)
 */
export async function issueCollabTokenByDocId(
  uid: string,
  docId: string,
  octoToken: string,
  viewerSpaceId?: string,
): Promise<IssueResult> {
  const meta = await docMetaRepo.getByDocId(docId)
  if (!meta || meta.status === 0) return { ok: false, status: 404, error: 'not_found' }

  // Authorization: resolveRole (owner + doc_member) merged with #64 space-share.
  // This MUST precede every state/type-specific response: the docId-first route
  // is reachable from the bare `/d/:docId` locator, so returning 422 for an
  // unauthorized html/html_ppt row would disclose its type/existence details.
  const direct = await resolveRole(uid, meta.doc_id)
  let spaceMember = false
  if (meta.share_scope === SHARE_SCOPE_ANYONE) {
    spaceMember = await getOctoIdentity().isSpaceMember(uid, meta.space_id, octoToken)
  }
  const role = effectiveRole(direct, spaceMember, meta.share_scope, meta.share_role)
  if (role === 'none') return { ok: false, status: 403, error: 'forbidden' }

  // Treat a malformed or internally inconsistent persisted identity as absent.
  // This guard deliberately follows authorization: otherwise a caller holding
  // only a docId could distinguish corrupt rows from ordinary forbidden rows.
  // The v2 token must bind one canonical identity across doc_meta, its room key,
  // and the explicit docId/homeSpaceId claims used by the WebSocket handshake.
  let parsed
  try {
    parsed = parseDocumentName(meta.document_name)
  } catch {
    return { ok: false, status: 404, error: 'not_found' }
  }
  const nameDocId = parsed.kind === 'whiteboard' ? parsed.board : parsed.doc
  if (
    !isDocTypeConsistentWithName(parsed, meta.doc_type) ||
    nameDocId !== meta.doc_id ||
    parsed.space !== meta.space_id ||
    parsed.folder !== meta.folder_id
  ) {
    return { ok: false, status: 404, error: 'not_found' }
  }

  // Authorized wrong-kind callers receive the precise API error. HTML uses its
  // own body backend; html_ppt uses the Bento relay. Neither may mint a
  // Hocuspocus token, but that fact is revealed only after authorization.
  if (meta.doc_type === HTML_DOC_TYPE || meta.doc_type === HTML_PPT_DOC_TYPE) {
    return { ok: false, status: 422, error: 'unsupported_document_type' }
  }

  // Match open-context's non-leaking order: unauthorized callers receive 403;
  // only an authorized caller can observe that the document is archived.
  if (meta.status === 2) return { ok: false, status: 409, error: 'conflict' }

  // Trusted display name (best-effort; never blocks issuance).
  let displayName = ''
  const profile = await getOctoIdentity().getUser(uid, octoToken)
  if (profile && typeof profile.name === 'string') displayName = profile.name.trim()

  // Verified-or-skip recent view (§7.1) — human path, fire-and-forget.
  void recordVerifiedRecentView({
    scope: { mode: 'human' },
    uid,
    docId: meta.doc_id,
    viewerSpaceId,
    token: octoToken,
  })

  const result = signCollabTokenV2({
    uid,
    docId: meta.doc_id,
    documentName: meta.document_name,
    homeSpaceId: meta.space_id,
    role,
    permissionEpoch: meta.permission_epoch,
    ...(displayName !== '' ? { name: displayName } : {}),
    ...(spaceMember ? { spaceMember: true } : {}),
  })
  return { ok: true, result }
}
