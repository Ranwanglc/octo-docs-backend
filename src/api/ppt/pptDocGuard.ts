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
import { resolveEffectiveRole } from '../../permission/resolveEffectiveRole.js'
import type { ResolvedRole } from '../../permission/role.js'
import { HTML_PPT_DOC_TYPE } from '../../db/docType.js'
import { PptApiError } from './envelope.js'

export interface PptDocGuard {
  meta: DocMeta
  /** The caller's effective role (incl. `'none'`); the handler enforces the floor. */
  role: ResolvedRole
}

export interface PptDocGuardCaller {
  /** Human octo session token — threaded to the share-scope membership resolver. */
  token?: string
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
  const role = await resolveEffectiveRole(uid, direct, meta, { token: caller.token })
  return { meta, role }
}
