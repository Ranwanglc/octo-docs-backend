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
import { signCollabToken, type CollabTokenResult } from './collabToken.js'
import { getOctoIdentity } from './octoIdentity.js'
import { parseDocumentName } from '../permission/documentName.js'
import { resolveRole, resolveDocMetaByName } from '../permission/resolveRole.js'
import { docViewHistoryRepo } from '../db/repos/docViewHistoryRepo.js'
import { config } from '../config/env.js'
import { effectiveRole, SHARE_SCOPE_ANYONE } from '../permission/shareScope.js'
import { HTML_DOC_TYPE } from '../db/docType.js'

export type IssueResult =
  | { ok: true; result: CollabTokenResult }
  | { ok: false; status: 401 | 403 | 404; error: string }

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
  // The `:wb:` namespace addresses boards only — a resolved row that is not a
  // board (corrupt key/row pairing) is "no such whiteboard".
  if (parsed.kind === 'whiteboard' && meta.doc_type !== 'board') {
    return { ok: false, status: 404, error: 'not_found' }
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

  // HTML bodies remain read-only on this Yjs channel. Preserve commenter in the
  // claim for role-aware clients; writer/admin are still clamped to reader.
  const effRole = meta.doc_type === HTML_DOC_TYPE ? (role === 'commenter' ? role : 'reader') : role

  // FEAT-B recent-view fallback ingest (MF2, default-on). Every document open —
  // read-only INCLUDED — passes through here, so this is the reliable "open ==
  // viewed" seam even if the front-end never calls POST /docs/{id}/view. We now
  // hold a trusted uid + doc_id + role(!=none), everything the UPSERT needs.
  // Best-effort: fire-and-forget (never awaited) so it can't slow or fail token
  // issuance, and a failure only warns. It shares the (uid, doc_id) PK with the
  // explicit endpoint, so a front-end that ALSO calls view never double-counts.
  //
  // SPACE 口径统一 (XIN-1237): recent-view is READ scoped to the viewer's CURRENT
  // space (GET /docs/recent filters doc_view_history.space_id = X-Space-Id). To
  // stay readable, the WRITE must land in that SAME space. So when the caller
  // supplies its current space (viewerSpaceId, from the collab-token request's
  // X-Space-Id header), record under it. This is what lets a doc opened from a
  // chat share link (standalone page) show up in the viewer's current-space
  // recent-view. Only when it is absent (legacy client that doesn't send the
  // header) do we fall back to the document's home space (meta.space_id) — the
  // pre-fix behavior, so same-space opens do not regress.
  const trimmedViewerSpace = typeof viewerSpaceId === 'string' ? viewerSpaceId.trim() : ''
  const ingestSpaceId = trimmedViewerSpace !== '' ? trimmedViewerSpace : meta.space_id
  void docViewHistoryRepo
    .upsertViewWithPrune({
      uid,
      docId: meta.doc_id,
      spaceId: ingestSpaceId,
      retainCount: config.docView.retainCount,
      retainDays: config.docView.retainDays,
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(`[octo-docs] recent-view fallback ingest failed for ${meta.doc_id}:`, err)
    })

  // Sign with the document's current epoch (§4.4 / §4.5). The token carries the
  // exact connection documentName (incl. the `:wb:` whiteboard form) so the WS
  // handshake's documentName match (§4.1 step 2) holds.
  const result = signCollabToken({
    uid,
    documentName,
    role: effRole,
    permission_epoch: meta.permission_epoch,
    ...(displayName !== '' ? { name: displayName } : {}),
    ...(spaceMember ? { space_member: true } : {}),
  })
  return { ok: true, result }
}
