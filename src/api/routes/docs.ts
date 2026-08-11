/**
 * Document CRUD routes (§8.4): create / list / rename / soft-delete.
 * Mounted under /api/v1/docs.
 */
import { Router, type Router as ExpressRouter, type Request, type Response } from 'express'
import { docMetaRepo } from '../../db/repos/docMetaRepo.js'
import {
  CanonicalHtmlArchivedError,
  CanonicalHtmlDeletedError,
  CanonicalHtmlLegacyConflictError,
  DocOwnershipError,
} from '../../db/repos/docMetaRepo.js'
import { docMemberRepo } from '../../db/repos/docMemberRepo.js'
import { docViewHistoryRepo } from '../../db/repos/docViewHistoryRepo.js'
import { normalizeTypeFilter, isDocType, HTML_DOC_TYPE, HTML_PPT_DOC_TYPE } from '../../db/docType.js'
import { buildDocumentName, buildHtmlDocumentName, DocumentNameError } from '../../permission/documentName.js'
import { enqueueDocIndex, isSearchIndexedDoc } from '../../search/docIndexQueue.js'
import { refreshAndPublish, bumpEpoch } from '../../permission/epoch.js'
import { ROLE_ADMIN, roleFromNumber, type Role } from '../../permission/role.js'
import {
  parseShareScope,
  parseShareRole,
  shareScopeName,
  shareRoleName,
  SHARE_SCOPE_ANYONE,
  SHARE_ROLE_READ,
} from '../../permission/shareScope.js'
import { buildWhiteboardName, WhiteboardNameError } from '../../whiteboard/schema/index.js'
import { newDocId } from '../../util/ids.js'
import { buildDocShareUrl } from '../../util/docShareLink.js'
import { config } from '../../config/env.js'
import { getOctoIdentity } from '../../auth/octoIdentity.js'
import { requireDocRole } from '../guard.js'
import { resolveRole } from '../../permission/resolveRole.js'
import { resolveEffectiveRole } from '../../permission/resolveEffectiveRole.js'
import { issueCollabTokenByDocId } from '../../auth/issueCollabToken.js'
import { recordVerifiedRecentView } from '../services/recordRecentView.js'
import { requireSpaceMembership, spaceContextMiddleware } from '../middleware/spaceContext.js'
import { searchDocs, VisibleTermsTooLargeError, encodeSearchCursor, decodeSearchCursor } from '../../search/osClient.js'

export const docsRouter: ExpressRouter = Router()

const DEFAULT_FOLDER = 'f_default'

/** Serialize a validated persisted role to the wire enum. */
const roleName = (n: number): Role | undefined => roleFromNumber(n)

/** Normalize a repeated query param (`?creator=a&creator=b`) to a string[]. */
function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  if (typeof v === 'string') return [v]
  return []
}

/**
 * Resolve whether the caller is a member of the space they are querying — the
 * READ-side twin of resolveEffectiveRole's write-side membership gate. A bot's
 * `req.spaceId` is server-resolved (verifyBot reverse lookup, anti-spoof), so a
 * bot is by definition a member of it — this mirrors resolveEffectiveRole's isBot
 * short-circuit. A human carries an UNVERIFIED `X-Space-Id`, so membership is
 * confirmed via isSpaceMember, which fails closed to `false` on any lookup error.
 * The space-share read branch therefore only opens on a confirmed membership,
 * never on a spoofed header or a transient failure — keeping the read side
 * symmetric with the write side and closing the cross-space metadata leak.
 */
async function resolveViewerSpaceMembership(req: Request): Promise<boolean> {
  if (req.botToken !== undefined) return true
  // isSpaceMember documents a fail-closed `false` on lookup errors, but a rejected
  // promise would still bubble to a 500 on /docs, /docs/recent and
  // /docs/recent/creators instead of merely dropping the share branch. Catch it
  // here so a transient identity-service failure degrades to "not a member" —
  // symmetric with the write-side gate's fail-closed intent — never a 500.
  return getOctoIdentity()
    .isSpaceMember(req.uid!, req.spaceId!, req.octoToken ?? '')
    .catch(() => false)
}

/**
 * docType value the front-end stamps on whiteboards (DocsHome create menu /
 * docsApi). Boards persist + address under the 5-segment `:wb:` key; everything
 * else is a rich-text document under the 4-segment key.
 */
const WHITEBOARD_DOC_TYPE = 'board'
// Re-export the shared read-only html kind constant (defined in db/docType.ts,
// the doc_type source of truth) so existing importers of this module keep
// working while the collab-token chokepoint reuses the same value.
export { HTML_DOC_TYPE }

/**
 * Build the canonical persistence/routing document_name for a freshly created
 * doc. This is the SINGLE place a new key is minted, and it must agree with the
 * key the client addresses on join and the key onAuthenticate parses:
 *
 *   - whiteboard (docType 'board'): `octo:{space}:{folder}:wb:{docId}` (5-seg) —
 *     the board id is the {board} segment (BoardSession passes `board: docId`),
 *     so collab-token issuance + WS auth resolve the row by the same key the
 *     browser joins with. Minting a 4-seg `d_` key here was the hop-2 join 404:
 *     persistence wrote 4-seg while the client/auth path addressed 5-seg `:wb:`.
 *   - html registration: `octo:{space}:{folder}:html:{docId}` (5-seg).
 *   - document: `octo:{space}:{folder}:{docId}` (4-seg).
 *
 * Throws DocumentNameError / WhiteboardNameError on an illegal segment.
 */
export function buildCreatedDocumentName(
  spaceId: string,
  folder: string,
  docId: string,
  docType: string,
): string {
  // documentName 3rd segment MUST equal folder_id (§8.1 invariant).
  if (docType === WHITEBOARD_DOC_TYPE) return buildWhiteboardName(spaceId, folder, docId)
  if (docType === HTML_DOC_TYPE) return buildHtmlDocumentName(spaceId, folder, docId)
  if (docType === HTML_PPT_DOC_TYPE) {
    // Defense-in-depth: html_ppt keys are minted via buildPptDocumentName in the
    // /api/v1/ppt create path, never here. The legacy create handler rejects
    // html_ppt up front (422), so this throw is only reached if a future caller
    // wires html_ppt into this builder by mistake — fail loud instead of minting
    // a 4-seg document key that would route the deck into the Yjs path.
    throw new DocumentNameError('html_ppt documentName must be built via buildPptDocumentName')
  }
  return buildDocumentName(spaceId, folder, docId)
}

async function grantBotOwnerAdmin(req: Request, docId: string, documentName: string): Promise<void> {
  const uid = req.uid!
  const botOwnerUid = req.botOwnerUid
  if (botOwnerUid && botOwnerUid !== uid) {
    await docMemberRepo.upsertDirect({
      docId,
      uid: botOwnerUid,
      roleNum: ROLE_ADMIN,
      grantedBy: uid,
    })
    await bumpEpoch(docId, documentName, botOwnerUid)
  }
}

/** POST /api/v1/docs — create. Creator becomes owner (implicit admin, §4.2). */
export async function createDocHandler(req: Request, res: Response) {
  const uid = req.uid!
  const { folderId, title, docType, octoDocSlug, idempotencyKey, mountType } = req.body ?? {}
  // Space isolation (P3): the space is sourced solely from the enforced
  // X-Space-Id header (req.spaceId, set by spaceContextMiddleware, guaranteed
  // non-empty). The transitional body.spaceId fallback (P1) is removed — any
  // spaceId in the request body is ignored; the header is the single source of
  // truth. The empty guard below stays as defense-in-depth for the header.
  const spaceId = req.spaceId ?? ''
  if (spaceId === '') {
    res.status(400).json({ error: 'spaceId required' })
    return
  }
  if (typeof title === 'string' && title.length > 512) {
    res.status(400).json({ error: 'title too long' })
    return
  }
  const folder = typeof folderId === 'string' && folderId !== '' ? folderId : DEFAULT_FOLDER
  const resolvedDocType = typeof docType === 'string' && docType !== '' ? docType : 'doc'
  if (resolvedDocType !== HTML_DOC_TYPE && idempotencyKey !== undefined) {
    res.status(400).json({ error: 'idempotencyKey is only valid for html documents' })
    return
  }
  if (resolvedDocType === HTML_PPT_DOC_TYPE) {
    // html_ppt (Bento slide-deck) is created ONLY through /api/v1/ppt/** (§3.1 /
    // §5.2), never the legacy /api/v1/docs create path. Reject as wrong-kind so a
    // PPT row is never minted here with a 4-seg document key (which would route
    // the deck into the Yjs/ProseMirror collab + version path).
    res.status(422).json({ error: 'unsupported_document_type' })
    return
  }
  if (!isDocType(resolvedDocType)) {
    // Make the wrong-kind gate TOTAL, not exact-match-on-html_ppt: any doc_type
    // outside DOC_TYPES would otherwise be persisted verbatim into
    // doc_meta.doc_type (VARCHAR, no CHECK constraint) and fall through to a
    // 4-seg Yjs document. Reject unknown types up front.
    res.status(400).json({ error: 'invalid_doc_type' })
    return
  }
  if (resolvedDocType === HTML_DOC_TYPE) {
    if (!req.botToken) {
      res.status(400).json({ error: 'html registration requires bot mount' })
      return
    }
    if (mountType !== 'group' && mountType !== 'space' && mountType !== 'thread') {
      res.status(400).json({ error: 'mountType must be group, space, or thread' })
      return
    }
    if (idempotencyKey !== undefined && octoDocSlug !== undefined) {
      res.status(400).json({ error: 'idempotencyKey and octoDocSlug are mutually exclusive' })
      return
    }
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '')) {
      res.status(400).json({ error: 'idempotencyKey required' })
      return
    }
    if (typeof idempotencyKey === 'string' && idempotencyKey.trim().length > 128) {
      res.status(400).json({ error: 'idempotencyKey too long' })
      return
    }
    if (idempotencyKey === undefined && (typeof octoDocSlug !== 'string' || octoDocSlug === '')) {
      res.status(400).json({ error: 'octoDocSlug required' })
      return
    }
    if (idempotencyKey === undefined && octoDocSlug.length > 128) {
      res.status(400).json({ error: 'octoDocSlug too long' })
      return
    }
  }
  const docId = newDocId()
  let documentName: string
  try {
    documentName = buildCreatedDocumentName(spaceId, folder, docId, resolvedDocType)
  } catch (err) {
    if (err instanceof DocumentNameError || err instanceof WhiteboardNameError) {
      res.status(400).json({ error: err.message })
      return
    }
    throw err
  }
  const normalizedIdempotencyKey = typeof idempotencyKey === 'string' ? idempotencyKey.trim() : undefined
  const createInput = {
    docId,
    documentName,
    title: typeof title === 'string' ? title : '',
    ownerId: uid,
    spaceId,
    folderId: folder,
    docType: resolvedDocType,
    ...(resolvedDocType === HTML_DOC_TYPE ? { octoDocSlug: normalizedIdempotencyKey !== undefined ? docId : octoDocSlug } : {}),
    createdBy: uid,
  }
  let writeResult: {
    meta: Awaited<ReturnType<typeof docMetaRepo.getByDocId>>
    created: boolean
    memberReconciled?: boolean
    permissionEpoch?: number
  }
  if (resolvedDocType === HTML_DOC_TYPE) {
    try {
      writeResult = normalizedIdempotencyKey !== undefined
        ? await docMetaRepo.createCanonicalHtml({
          ...createInput,
          octoDocSlug: docId,
          idempotencyKey: normalizedIdempotencyKey,
          humanOwnerUid: req.botOwnerUid,
        })
        : await docMetaRepo.upsertHtmlByOctoDocSlug({
          ...createInput,
          octoDocSlug,
          humanOwnerUid: req.botOwnerUid,
        })
    } catch (err) {
      if (err instanceof CanonicalHtmlDeletedError) {
        res.status(410).json({ error: 'canonical_document_deleted' })
        return
      }
      if (err instanceof CanonicalHtmlArchivedError) {
        res.status(409).json({ error: 'canonical_document_archived' })
        return
      }
      if (err instanceof CanonicalHtmlLegacyConflictError) {
        res.status(409).json({ error: 'canonical_document_conflict' })
        return
      }
      // Default-deny (P0): a non-owner upsert of an existing slug is rejected
      // rather than silently overwriting/reviving another bot's row. Mirrors the
      // 403 the sibling rename/delete (requireDocRole('admin')) paths return.
      if (err instanceof DocOwnershipError) {
        res.status(403).json({ error: 'forbidden' })
        return
      }
      throw err
    }
  } else {
    await docMetaRepo.create(createInput)
    writeResult = { meta: await docMetaRepo.getByDocId(docId), created: true, memberReconciled: false }
  }
  const meta = writeResult.meta
  // Fresh and historical legacy membership writes happen in the repository
  // transaction. Publish only a committed historical reconcile.
  if (meta && resolvedDocType !== HTML_DOC_TYPE) {
    await grantBotOwnerAdmin(req, meta.doc_id ?? docId, meta.document_name ?? documentName)
  } else if (meta && normalizedIdempotencyKey === undefined && writeResult.memberReconciled) {
    await refreshAndPublish(
      meta.document_name ?? documentName,
      writeResult.permissionEpoch ?? Number(meta.permission_epoch),
      req.botOwnerUid,
    )
  }

  const responseDocId = resolvedDocType === HTML_DOC_TYPE ? (meta?.doc_id ?? docId) : docId
  const responseDocumentName = resolvedDocType === HTML_DOC_TYPE ? (meta?.document_name ?? documentName) : documentName
  const responseSpaceId = resolvedDocType === HTML_DOC_TYPE ? (meta?.space_id ?? spaceId) : spaceId
  const responseFolderId = resolvedDocType === HTML_DOC_TYPE ? (meta?.folder_id ?? folder) : folder
  const responseOwnerId = resolvedDocType === HTML_DOC_TYPE ? (meta?.owner_id ?? uid) : uid
  // Legacy slug registration historically signals immediately. Canonical HTML
  // allocation waits for /:docId/published because its body is not durable yet.
  if (resolvedDocType === HTML_DOC_TYPE && normalizedIdempotencyKey === undefined
      && config.search.indexEnabled && isSearchIndexedDoc(responseDocumentName)) {
    void enqueueDocIndex(responseDocumentName)
  }
  res.status(201).json({
    docId: responseDocId,
    documentName: responseDocumentName,
    title: meta?.title ?? '',
    spaceId: responseSpaceId,
    folderId: responseFolderId,
    ownerId: responseOwnerId,
    docType: resolvedDocType,
    ...(resolvedDocType === HTML_DOC_TYPE ? { octoDocSlug: meta?.octo_doc_slug ?? octoDocSlug } : {}),
    ...(resolvedDocType === HTML_DOC_TYPE ? { created: writeResult.created, publisherUid: uid } : {}),
    // The caller is always admin on this response: a fresh create makes the
    // caller the owner (implicit admin, §4.2), and the idempotent update branch
    // (created:false) is now reachable ONLY by the owning bot — the repo's
    // owner固化 gate 403s every non-owner before this line. So 'admin' is the
    // caller's TRUE role on every surviving path (no fail-open).
    role: 'admin',
    createdAt: meta?.created_at,
    // Canonical browser-facing link a caller can pass straight to chat. See
    // buildDocShareUrl / config.webOrigin.
    shareUrl: buildDocShareUrl(config.webOrigin, responseDocId, responseSpaceId),
  })
}

// WRITE routes whose target is chosen by the space alone carry
// requireSpaceMembership: `POST /` mints a NEW row into the named space, so no
// document exists yet to resolve a role from and the header IS the whole
// authorization. Confirming it here is what stops a session holder from planting
// a doc into a space they do not belong to.
//
// The COLLECTION READS below (`GET /`, `POST /search`, `GET /recent`,
// `GET /recent/creators`) deliberately do NOT carry it, even though the space is
// their selector too. They are not authorized by space membership in the first
// place: each pushes a row-level predicate down to the repo that admits only
// `owner OR doc_member`, and ADDS the `share_scope = anyone_in_space` branch only
// when `isSpaceMember` is confirmed (docMetaRepo.listForUser's `includeSpaceShare`,
// listVisibleDocIdSet's `spaceShare`, docViewHistoryRepo.visibilityPredicate). A
// non-member naming someone else's space therefore already sees nothing of that
// space — the predicate collapses to their own direct grants. Gating the route
// instead would SUBTRACT: a legitimate cross-space owner / doc_member, whose grant
// is independent of space membership by design (members.ts / forwardGrant.ts
// verify only that the grantee is a real octo user), would be 404'd out of listing
// or searching documents they own. That violates the contract's supplemental-only
// rule (docs/contract/backend-design.md:1514, only-adds) — the same subtraction
// that split this middleware off the global mount in the first place.
//
// The `/:docId` routes below also do NOT carry it: requireDocRole is strictly
// stronger there (real-uid role resolution + requireSameSpace pinning req.spaceId
// to meta.space_id).
// See api/middleware/spaceContext.ts for why this is per-route, not global.
docsRouter.post('/', requireSpaceMembership, createDocHandler)

/** Notify the backend after HTML content is durably published. */
export async function publishHtmlHandler(req: Request, res: Response) {
  if (req.botToken === undefined) {
    res.status(403).json({ error: 'forbidden' })
    return
  }
  const meta = await docMetaRepo.getByDocId(req.params.docId!)
  if (!meta || meta.space_id !== req.spaceId) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  if (meta.owner_id !== req.uid) {
    res.status(403).json({ error: 'forbidden' })
    return
  }
  if (meta.status === 0) {
    res.status(410).json({ error: 'canonical_document_deleted' })
    return
  }
  if (meta.status === 2 || meta.doc_type !== HTML_DOC_TYPE) {
    res.status(409).json({ error: meta.status === 2 ? 'document_archived' : 'wrong_document_type' })
    return
  }
  const { title } = req.body ?? {}
  if (title !== undefined && (typeof title !== 'string' || title.length > 512)) {
    res.status(400).json({ error: typeof title === 'string' ? 'title too long' : 'invalid_title' })
    return
  }
  if (typeof title === 'string') await docMetaRepo.rename(meta.doc_id, title, req.uid!)
  let indexed = false
  if (config.search.indexEnabled && isSearchIndexedDoc(meta.document_name)) {
    indexed = await enqueueDocIndex(meta.document_name)
  }
  res.status(200).json({ docId: meta.doc_id, title: typeof title === 'string' ? title : meta.title, indexed })
}

docsRouter.post('/:docId/published', publishHtmlHandler)

/** GET /api/v1/docs/{docId} — fetch one doc's metadata (needs reader). */
export async function getDocHandler(req: Request, res: Response) {
  const docId = req.params.docId!
  const guard = await requireDocRole(req, res, docId, 'reader')
  if (!guard) return
  const { meta, role } = guard
  res.status(200).json({
    docId: meta.doc_id,
    documentName: meta.document_name,
    title: meta.title,
    ownerId: meta.owner_id,
    spaceId: meta.space_id,
    folderId: meta.folder_id,
    docType: meta.doc_type,
    ...(meta.octo_doc_slug ? { octoDocSlug: meta.octo_doc_slug } : {}),
    role,
    createdAt: meta.created_at,
    updatedAt: meta.updated_at,
    // Canonical browser-facing link a caller can pass straight to chat. See
    // buildDocShareUrl / config.webOrigin.
    shareUrl: buildDocShareUrl(config.webOrigin, meta.doc_id, meta.space_id),
    // #64: additive share-scope fields so the client dialog can render current
    // state without a second round-trip to GET /:docId/share. Coerced through the
    // fail-safe name mappers, so an unexpected stored value reads as the most
    // restrictive (restricted / read).
    shareScope: shareScopeName(meta.share_scope),
    shareRole: shareRoleName(meta.share_role),
    ...(meta.permission_epoch != null ? { permissionEpoch: meta.permission_epoch } : {}),
  })
}

/** GET /api/v1/docs — list docs the caller owns or is a member of. */
export async function listDocsHandler(req: Request, res: Response) {
  const uid = req.uid!
  // Space isolation (P1): the space is the enforced X-Space-Id header
  // (req.spaceId, set by spaceContextMiddleware), never a client-supplied query
  // param. Listing is hard-scoped to that space.
  const spaceId = req.spaceId!
  const folderId = typeof req.query.folderId === 'string' ? req.query.folderId : undefined
  // FEAT-B: `owner=me` narrows to strictly the caller's own docs (excludes
  // shared-with-me); `q` is a filename substring search. Both are optional and
  // additive — omitting them preserves the pre-FEAT-B behavior verbatim.
  const owner = req.query.owner === 'me' ? 'me' : undefined
  // FEAT: for owner=me, "my documents" also includes docs owned by bots this
  // human owns (req.ownedBots, from octo verify). Defaults to [] so listForUser
  // degrades to strictly the caller's own docs when absent.
  const ownedBots = req.ownedBots ?? []
  const q = typeof req.query.q === 'string' ? req.query.q : undefined
  // FEAT-B/XIN-1188: optional multi-value `?type=` kind filter (repeated param,
  // never CSV). Validated against the fixed enum; unknown/absent => no filter.
  const types = normalizeTypeFilter(req.query.type)
  const page = Math.max(1, Number(req.query.page ?? 1) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20) || 20))
  const sort = req.query.sort === 'updatedAt:asc' ? 'updatedAt:asc' : 'updatedAt:desc'

  // Space-share visibility must match the write side: only a confirmed member of
  // the queried space sees its anyone_in_space docs. owner='me' excludes the share
  // branch outright, so skip the membership lookup entirely in that case.
  const isSpaceMember = owner === 'me' ? false : await resolveViewerSpaceMembership(req)

  const { total, items } = await docMetaRepo.listForUser({ uid, spaceId, isSpaceMember, folderId, owner, ownedBots, q, types, page, pageSize, sort })
  const visibleItems = items.flatMap((d) => {
    const role = roleName(Number(d.role))
    if (!role) return []
    return [{
      docId: d.doc_id,
      title: d.title,
      ownerId: d.owner_id,
      docType: d.doc_type,
      ...(d.octo_doc_slug ? { octoDocSlug: d.octo_doc_slug } : {}),
      role,
      updatedAt: d.updated_at,
    }]
  })
  res.status(200).json({ total, items: visibleItems })
}

docsRouter.get('/', listDocsHandler)

/**
 * POST /api/v1/docs/search — full-text search with permission down-push (P4).
 *
 * MySQL computes the FULL visible set first (§5.3): the caller's visible doc_id
 * set — owner OR doc_member OR (for a confirmed space member) share_scope=anyone,
 * all gated by status=1. That set is pushed DOWN into the OpenSearch query as a
 * `doc_id IN <set>` filter (§5.4), alongside space + status. OS then does the
 * FULL-TEXT match, highlight, AND pagination — every hit
 * is already within the caller's access, so there is NO per-hit MySQL re-check
 * (§6.4). For space members, anyone_in_space docs ARE enumerated into that set
 * in MySQL (docMetaRepo adds `OR m.share_scope = ANYONE`), trading scale for a
 * clean fail-closed doc_id filter that also drops stale/soft-deleted OS copies.
 * NOTE: a very large space can push visibleDocIds past OpenSearch
 * `index.max_terms_count` (default 65536), which surfaces as a 503; bound this
 * before enabling search on large spaces.
 *
 * Registered BEFORE the '/:docId' routes so the '/search' literal is never
 * shadowed by the single-doc param route.
 *
 * Pagination is keyset (search_after), NOT offset: the client omits `cursor` on
 * the first page and echoes back the response's `nextCursor` for each subsequent
 * page. `nextCursor` is an opaque base64url token wrapping the last hit's sort
 * values; it is absent once there is no further page, so the client's stop
 * condition is simply "nextCursor missing" (never `page * size >= total`, which
 * offset paging can get wrong under index churn). `total` is still an exact count
 * for display, but no longer drives the stop.
 *
 *   body: { q: string, docType?: string[], cursor?: string, pageSize?: number }
 *   400 q required         q empty/missing
 *   400 invalid_cursor     cursor present but malformed
 *   503 search unavailable search disabled, OR OpenSearch errored (never fail-open)
 */
export async function searchDocsHandler(req: Request, res: Response) {
  // Gray release gate: with search disabled the endpoint never connects to OS.
  if (config.search.enabled === false) {
    res.status(503).json({ error: 'search unavailable', reason: 'search_disabled' })
    return
  }
  const uid = req.uid!
  const spaceId = req.spaceId!
  const { q, docType: docTypeRaw, cursor: cursorRaw, pageSize: pageSizeRaw } = req.body ?? {}
  if (typeof q !== 'string' || q.trim() === '') {
    res.status(400).json({ error: 'q required' })
    return
  }
  // Decode the opaque keyset cursor (absent => first page). A malformed cursor is
  // a client bug, not a transient failure — answer 400 rather than silently
  // restarting from page one (mirrors listRecentHandler's invalid_cursor path).
  let searchAfter
  try {
    searchAfter = decodeSearchCursor(typeof cursorRaw === 'string' ? cursorRaw : undefined) ?? undefined
  } catch {
    res.status(400).json({ error: 'invalid_cursor' })
    return
  }
  // Optional kind filter (§6.3): validated against the fixed doc_type enum;
  // unknown/absent => no filter. Pushed to both the MySQL constraint and OS filter.
  const docType = normalizeTypeFilter(docTypeRaw)
  const pageSize = Math.min(config.search.pageSizeMax, Math.max(1, Number(pageSizeRaw ?? 20) || 20))
  // Space-share visibility must match the list side: only a confirmed member of
  // the queried space sees its anyone_in_space docs (fail-closed on lookup error).
  const isSpaceMember = await resolveViewerSpaceMembership(req)

  // 1. MySQL: the caller's visible doc_id set (private + explicitly-granted +,
  //    for a confirmed member, space-share). All gated by status=1 in MySQL, so
  //    soft-deleted docs are absent here regardless of what OS still holds.
  //    Capped at maxVisibleTerms+1 rows: an oversized set is rejected below
  //    (searchDocs throws VisibleTermsTooLargeError) before a large terms array
  //    reaches OpenSearch, and the DB scan itself is bounded to limit+1 rather
  //    than the true count. Recomputed on every keyset page (stateless paging),
  //    so the bound also caps the per-page cost.
  const visibleDocIds = await docMetaRepo.listVisibleDocIdSet({
    uid,
    spaceId,
    docType,
    isSpaceMember,
    limit: config.search.maxVisibleTerms,
  })

  // 2. OS: full-text match with the visibility constraint pushed down as a filter,
  //    keyset-paginated by OS via search_after. Empty visible set short-circuits to
  //    total=0 inside searchDocs (no OS call). OS error => 503, never fail-open.
  let result
  try {
    result = await searchDocs({
      spaceId,
      query: q.trim(),
      docType,
      visibleDocIds,
      size: pageSize,
      searchAfter,
    })
  } catch (err) {
    // A visible set too large to push down as a terms filter is a deterministic,
    // caller-observable limit (not a transient OS outage) — surface a distinct
    // reason so clients can narrow the query rather than blindly retry.
    if (err instanceof VisibleTermsTooLargeError) {
      res.status(503).json({ error: 'search unavailable', reason: 'terms_limit_exceeded' })
      return
    }
    res.status(503).json({ error: 'search unavailable' })
    return
  }

  // Hits are already within the visibility constraint and carry their own display
  // metadata from OS _source — no MySQL round-trip, no role (§6.3 response).
  // nextCursor is present only when searchDocs reported a further page; the client
  // stops paginating as soon as it is absent.
  res.status(200).json({
    total: result.total,
    items: result.items.map((it) => ({
      docId: it.docId,
      title: it.title,
      docType: it.docType,
      updatedAt: it.updatedAt,
      spaceId: it.spaceId,
      ...(it.highlight ? { highlight: it.highlight } : {}),
    })),
    ...(result.searchAfter ? { nextCursor: encodeSearchCursor(result.searchAfter) } : {}),
  })
}

docsRouter.post('/search', searchDocsHandler)

/**
 * POST /api/v1/docs/{docId}/view — record that the caller opened this doc
 * (FEAT-B ingest, §3.1). Needs reader (reuses requireDocRole guard). The recent-
 * view WRITE is verified-or-skip (remove-sp §7.1): a bot records under its
 * server-resolved Space; a human records ONLY under a viewer Space whose active
 * membership is confirmed (never an unverified header, never the doc home Space),
 * otherwise the write is skipped and the response reports `recorded: false`.
 */
export async function recordDocViewHandler(req: Request, res: Response) {
  const uid = req.uid!
  const docId = req.params.docId!
  const guard = await requireDocRole(req, res, docId, 'reader')
  if (!guard) return
  const viewedAt = await recordVerifiedRecentView({
    scope: req.docSpaceScope ?? { mode: 'human' },
    uid,
    docId,
    viewerSpaceId: req.viewerSpaceId,
    token: req.octoToken,
  })
  res
    .status(200)
    .json(viewedAt ? { ok: true, viewedAt: viewedAt.toISOString() } : { ok: true, recorded: false })
}

docsRouter.post('/:docId/view', recordDocViewHandler)

/**
 * GET /api/v1/docs/recent — the caller's recently-viewed docs (FEAT-B, §3.2).
 * keyset-paginated, viewed_at DESC. Query-time filtering (status + permission)
 * lives in the repo, so revoked / deleted / archived docs drop out immediately.
 */
export async function listRecentHandler(req: Request, res: Response) {
  const uid = req.uid!
  const spaceId = req.spaceId!
  const q = typeof req.query.q === 'string' ? req.query.q : undefined
  const creators = toStringArray(req.query.creator)
  // FEAT-B/XIN-1188: optional multi-value `?type=` kind filter (same convention
  // as `creator`). Validated against the fixed enum; unknown/absent => no filter.
  const types = normalizeTypeFilter(req.query.type)
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20) || 20))
  const isSpaceMember = await resolveViewerSpaceMembership(req)
  let result
  try {
    result = await docViewHistoryRepo.listRecent({ uid, spaceId, isSpaceMember, q, creators, types, cursor, pageSize })
  } catch (err) {
    if (err instanceof Error && err.message === 'invalid_cursor') {
      res.status(400).json({ error: 'invalid_cursor' })
      return
    }
    throw err
  }
  // Resolve the last-editor (updated_by) display names server-side so the
  // front-end (XIN-1236 merged-view) can render "<name> 更新于 <time>" without a
  // second round-trip — mirrors the creators handler's name resolution. Batch the
  // distinct non-empty uids through one directory call, authenticated with the
  // caller's own token; a uid that fails to resolve falls back to its own value.
  // updated_by is '' for a doc that has never been edited (schema DEFAULT ''),
  // which maps to updatedBy: null so the client can hide the editor line.
  const editorIds = [...new Set(result.items.map((d) => d.updated_by).filter((id) => id !== ''))]
  const editorNameByUid = new Map<string, string>()
  if (editorIds.length > 0) {
    const users = await getOctoIdentity().getUsers(editorIds, req.octoToken)
    for (const u of users) {
      const name = typeof u.name === 'string' ? u.name.trim() : ''
      if (name !== '') editorNameByUid.set(u.uid, name)
    }
  }
  const visibleItems = result.items.flatMap((d) => {
    const role = roleName(Number(d.role))
    if (!role) return []
    return [{
      docId: d.doc_id,
      title: d.title,
      ownerId: d.owner_id,
      docType: d.doc_type,
      ...(d.octo_doc_slug ? { octoDocSlug: d.octo_doc_slug } : {}),
      role,
      updatedAt: d.updated_at,
      updatedBy:
        d.updated_by === ''
          ? null
          : { uid: d.updated_by, name: editorNameByUid.get(d.updated_by) ?? d.updated_by },
      viewedAt: new Date(d.viewed_at).toISOString(),
    }]
  })
  res.status(200).json({ total: result.total, items: visibleItems, nextCursor: result.nextCursor })
}

docsRouter.get('/recent', listRecentHandler)

/**
 * GET /api/v1/docs/recent/creators — distinct creators of the caller's
 * recently-viewed docs for the CreatorFilter dropdown (FEAT-B, §3.4). Scope:
 * q-filtered, creator-NOT-filtered, pre-pagination, permission-filtered — the
 * full distinct owner set. Display names are resolved server-side so the
 * front-end needs no per-uid lookups; a uid that fails to resolve falls back to
 * its own value as the name (a directory hiccup never drops a candidate).
 */
export async function listRecentCreatorsHandler(req: Request, res: Response) {
  const uid = req.uid!
  const spaceId = req.spaceId!
  const q = typeof req.query.q === 'string' ? req.query.q : undefined
  const isSpaceMember = await resolveViewerSpaceMembership(req)
  const ownerIds = await docViewHistoryRepo.listCreators({ uid, spaceId, isSpaceMember, q })
  const nameByUid = new Map<string, string>()
  if (ownerIds.length > 0) {
    const users = await getOctoIdentity().getUsers(ownerIds, req.octoToken)
    for (const u of users) {
      const name = typeof u.name === 'string' ? u.name.trim() : ''
      if (name !== '') nameByUid.set(u.uid, name)
    }
  }
  res.status(200).json({
    creators: ownerIds.map((id) => ({ uid: id, name: nameByUid.get(id) ?? id })),
  })
}

docsRouter.get('/recent/creators', listRecentCreatorsHandler)

// Registered after GET '/' so the collection route is matched distinctly from
// the single-doc route (Express treats '/' and '/:docId' as separate paths).
docsRouter.get('/:docId', getDocHandler)

async function resolveDocIdBySlug(req: Request, res: Response): Promise<string | null> {
  const octoDocSlug = req.params.octoDocSlug!
  // A slug is only unique per Space, so it MUST be resolved within a Space. The
  // Space follows the per-mount policy (remove-sp §6): a bot uses its
  // server-resolved Space; a human uses the optional viewer Space (X-Space-Id).
  // octo-doc slug operations are bot-facing (html registration); a human with no
  // viewer Space simply cannot resolve a slug (404) — never another Space's row.
  const scope = req.docSpaceScope
  const slugSpace = scope?.mode === 'bot' ? scope.spaceId : (req.viewerSpaceId ?? '')
  const meta = await docMetaRepo.getByOctoDocSlug(octoDocSlug, slugSpace)
  if (!meta || meta.status === 0) {
    res.status(404).json({ error: 'not_found' })
    return null
  }
  return meta.doc_id
}

/**
 * Resolve a canonical HTML delete target. An already soft-deleted row is visible
 * only to its owning authenticated principal, which makes the retry idempotent
 * without allowing unrelated callers to probe deleted document existence.
 */
async function resolveCanonicalDeleteBySlug(req: Request, res: Response): Promise<{ docId: string; deleted: boolean } | null> {
  const meta = await docMetaRepo.getByOctoDocSlug(req.params.octoDocSlug!, req.spaceId!)
  if (!meta) {
    res.status(404).json({ error: 'not_found' })
    return null
  }
  if (meta.status === 0) {
    // Only the canonical identity contract is idempotent here. Historical
    // slug-registered rows retain their existing 404 behavior.
    if (meta.owner_id === req.uid && meta.octo_doc_slug === meta.doc_id) {
      return { docId: meta.doc_id, deleted: true }
    }
    res.status(404).json({ error: 'not_found' })
    return null
  }
  return { docId: meta.doc_id, deleted: false }
}

async function renameDocById(req: Request, res: Response, docId: string): Promise<void> {
  const guard = await requireDocRole(req, res, docId, 'admin')
  if (!guard) return
  const { title } = req.body ?? {}
  if (typeof title !== 'string' || title === '') {
    res.status(400).json({ error: 'title required' })
    return
  }
  if (title.length > 512) {
    res.status(400).json({ error: 'title too long' })
    return
  }
  await docMetaRepo.rename(docId, title, req.uid!)
  // Title lives in the search index (matched as title^2, returned as _source.title),
  // so a rename must re-index or the new title is missed / the stale one keeps
  // showing until an unrelated body edit reindexes. Enqueue a body signal: the
  // indexer re-reads the latest authoritative state (including title) by
  // documentName. Best-effort / fire-and-forget (enqueue swallows its own
  // errors); gated OFF by default. html now flows through the same gate
  // (isSearchIndexedDoc accepts 'html') — the indexer reads the S3 body for
  // html docs; doc/sheet/board keep reading the Yjs body.
  if (config.search.indexEnabled) {
    const documentName = await docMetaRepo.resolveDocumentName(docId)
    if (documentName && isSearchIndexedDoc(documentName)) {
      void enqueueDocIndex(documentName)
    }
  }
  res.status(200).json({ docId, title })
}

async function deleteDocById(req: Request, res: Response, docId: string): Promise<void> {
  const guard = await requireDocRole(req, res, docId, 'admin')
  if (!guard) return
  const deleted = await docMetaRepo.softDelete(docId)
  // Broadcast the epoch invalidation so connected writers recheck and get cut
  // off (status===0 -> resolveRole 'none'). Doc-wide (no uid): everyone loses
  // access on delete. Mirrors acceptInvite's refreshAndPublish call.
  if (deleted) {
    await refreshAndPublish(deleted.documentName, deleted.permissionEpoch)
  }
  res.status(200).json({ docId, status: 'deleted' })
}

export async function octoDocRenameHandler(req: Request, res: Response): Promise<void> {
  const docId = await resolveDocIdBySlug(req, res)
  if (!docId) return
  await renameDocById(req, res, docId)
}

export async function octoDocDeleteHandler(req: Request, res: Response): Promise<void> {
  const target = await resolveCanonicalDeleteBySlug(req, res)
  if (!target) return
  if (target.deleted) {
    res.status(204).end()
    return
  }
  await deleteDocById(req, res, target.docId)
}

/** PATCH /api/v1/docs/{docId} — rename (needs admin). */
export async function renameDocHandler(req: Request, res: Response): Promise<void> {
  await renameDocById(req, res, req.params.docId!)
}

/** DELETE /api/v1/docs/{docId} — soft delete (needs admin). */
export async function deleteDocHandler(req: Request, res: Response): Promise<void> {
  await deleteDocById(req, res, req.params.docId!)
}

docsRouter.patch('/octo-doc/:octoDocSlug', octoDocRenameHandler)
docsRouter.delete('/octo-doc/:octoDocSlug', octoDocDeleteHandler)
docsRouter.patch('/:docId', renameDocHandler)
docsRouter.delete('/:docId', deleteDocHandler)

/**
 * GET /api/v1/docs/{docId}/share — read a doc's share settings (#64, needs
 * reader). Anyone who can see the doc can see its scope, so the client dialog
 * can render current state for any viewer. 404 (not 403) for a missing/deleted
 * or cross-space doc (requireDocRole existence-hiding ordering); 403 when the
 * caller has no effective role on the doc.
 */
export async function getShareHandler(req: Request, res: Response) {
  const guard = await requireDocRole(req, res, req.params.docId!, 'reader')
  if (!guard) return
  res.status(200).json({
    docId: guard.meta.doc_id,
    shareScope: shareScopeName(guard.meta.share_scope),
    shareRole: shareRoleName(guard.meta.share_role),
  })
}

/**
 * PUT /api/v1/docs/{docId}/share — change a doc's share settings (#64, needs
 * admin; owner is implicit admin). Mirrors the members mutation shape: guard,
 * validate, write, bump epoch.
 *
 *   body: { shareScope: "restricted"|"anyone_in_space", shareRole?: "read"|"edit" }
 *   400 invalid_scope   shareScope not in enum
 *   400 invalid_role    shareScope=anyone_in_space but shareRole missing/invalid
 *   403 forbidden       caller is not admin/owner (requireDocRole admin gate)
 *   404 not_found       doc missing/deleted OR cross-space
 *   409 conflict        archived (status=2)
 *
 * Normalization (design §3.2): when shareScope=restricted the handler persists
 * share_role=read regardless of any shareRole sent (the field is ignored, not
 * rejected), so the stored row stays canonical and the read API is deterministic.
 * The write is followed by a DOC-WIDE epoch bump (no uid) so a narrowing cuts
 * every non-member's live session, exactly like soft-delete.
 */
export async function putShareHandler(req: Request, res: Response) {
  const guard = await requireDocRole(req, res, req.params.docId!, 'admin')
  if (!guard) return
  const { shareScope, shareRole } = req.body ?? {}
  const scopeNum = parseShareScope(shareScope)
  if (scopeNum === null) {
    res.status(400).json({ error: 'invalid_scope' })
    return
  }
  let roleNum: number
  if (scopeNum === SHARE_SCOPE_ANYONE) {
    // anyone_in_space requires an explicit, valid share role.
    const parsed = parseShareRole(shareRole)
    if (parsed === null) {
      res.status(400).json({ error: 'invalid_role' })
      return
    }
    roleNum = parsed
  } else {
    // restricted: normalize+persist read, ignoring any body shareRole.
    roleNum = SHARE_ROLE_READ
  }
  // Flip the share settings AND bump the epoch atomically (one transaction), so
  // a narrowing is never observable at the new scope with a stale epoch. Then
  // refresh caches + publish the doc-wide invalidation (no uid) so every
  // non-member's live session re-derives access (§3.2 / §5.3), mirroring the
  // softDelete -> refreshAndPublish path.
  const newEpoch = await docMetaRepo.setShareSettings(guard.meta.doc_id, scopeNum, roleNum)
  await refreshAndPublish(guard.meta.document_name, newEpoch)
  res.status(200).json({
    docId: guard.meta.doc_id,
    shareScope: shareScopeName(scopeNum),
    shareRole: shareRoleName(roleNum),
  })
}

// Two-segment paths: distinct from the single-segment '/:docId' route, so
// registration order relative to it does not matter (Express keys on segment
// count). Registered here alongside the other single-doc routes.
docsRouter.get('/:docId/share', getShareHandler)
docsRouter.put('/:docId/share', putShareHandler)

// ---------------------------------------------------------------------------
// remove-sp §4 / §6: Open Context + docId-first physical router split.
// ---------------------------------------------------------------------------

/** doc_id shape gate for the open-context locate (mirrors newDocId/segment charset). */
const DOC_ID_MAX_LEN = 128
function isPlausibleDocId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= DOC_ID_MAX_LEN && /^[A-Za-z0-9_-]+$/.test(id)
}

/**
 * GET /api/v1/docs/{docId}/open-context (remove-sp §4). The browser `/d/:docId`
 * bootstrap: locate the doc by docId ALONE (no `sp`, no `X-Space-Id` for
 * selection) and return the canonical context needed to start REST + collab.
 * Human-only — mounted on the DocumentResourceRouter after authMiddleware,
 * NEVER behind spaceContextMiddleware.
 *
 * Fixed status order so NOTHING is leaked before authorization (§4):
 *   locate/exist → compute role → role=none ⇒ 403 → archived ⇒ 409 → context.
 * A `none` caller gets 403 WITHOUT learning archived/locked state; any failure
 * response carries no title / Space / owner / documentName.
 *
 * The 403-vs-404 distinction is deliberately preserved (§4): it is what keeps
 * "hold a doc link, request access" working; enumeration resistance is a later
 * sharing-security phase, not this one.
 */
export async function openContextHandler(req: Request, res: Response): Promise<void> {
  const uid = req.uid!
  const docId = req.params.docId
  if (!isPlausibleDocId(docId)) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  const meta = await docMetaRepo.getByDocId(docId)
  if (!meta || meta.status === 0) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  // Compute role WITHOUT returning any metadata. Human open-context: membership
  // for an anyone_in_space doc is resolved against the doc's HOME Space
  // (meta.space_id) via the caller's own token — never a client header.
  const direct = await resolveRole(uid, docId)
  const role = await resolveEffectiveRole(uid, direct, meta, { isBot: false, token: req.octoToken })
  if (role === 'none') {
    res.status(403).json({ error: 'forbidden' })
    return
  }
  // Only now — the caller is at least a reader — may archived/locked state be
  // revealed (§4: 409 comes AFTER the role gate, never before).
  if (meta.status === 2) {
    res.status(409).json({ error: 'conflict' })
    return
  }
  res.status(200).json({
    docId: meta.doc_id,
    homeSpaceId: meta.space_id,
    documentName: meta.document_name,
    folderId: meta.folder_id,
    docType: meta.doc_type,
    role,
    permissionEpoch: meta.permission_epoch,
    title: meta.title,
    ...(meta.octo_doc_slug ? { octoDocSlug: meta.octo_doc_slug } : {}),
  })
}

/**
 * POST /api/v1/docs/{docId}/collab-token (remove-sp §7.1) — docId-first, v2.
 * Human-only. Resolves the canonical documentName + home Space by docId and
 * issues a v2 token bound to them; never derives the doc from `sp`/`X-Space-Id`.
 */
export async function docIdCollabTokenHandler(req: Request, res: Response): Promise<void> {
  const out = await issueCollabTokenByDocId(req.uid!, req.params.docId!, req.octoToken ?? '', req.viewerSpaceId)
  if (!out.ok) {
    res.status(out.status).json({ error: out.error })
    return
  }
  res.status(200).json(out.result)
}

/**
 * Human SpaceCollectionRouter (remove-sp §6): the Space-scoped collection ops.
 * `X-Space-Id` is REQUIRED here (per-route spaceContextMiddleware, so a
 * single-document request passing through this router without a match never
 * trips the 400). Mounted BEFORE the DocumentResourceRouter so the fixed paths
 * (`/`, `/search`, `/recent`, `/recent/creators`) are never shadowed by `/:docId`.
 */
export const spaceCollectionRouter: ExpressRouter = Router()
// Creating a document has no existing doc role to authorize against, so the
// caller must prove membership in the requested Space. Collection reads keep
// their row-level owner/doc_member predicates and only add Space-shared rows for
// confirmed members; gating those reads would subtract legitimate cross-Space
// direct grants.
spaceCollectionRouter.post('/', spaceContextMiddleware, requireSpaceMembership, createDocHandler)
spaceCollectionRouter.get('/', spaceContextMiddleware, listDocsHandler)
spaceCollectionRouter.post('/search', spaceContextMiddleware, searchDocsHandler)
spaceCollectionRouter.get('/recent', spaceContextMiddleware, listRecentHandler)
spaceCollectionRouter.get('/recent/creators', spaceContextMiddleware, listRecentCreatorsHandler)

/**
 * Human DocumentResourceRouter (remove-sp §6): every single-document operation,
 * located by path docId with NO spaceContextMiddleware. open-context and the
 * docId-first collab-token are human-only foundation routes and live only here
 * (not on the shared/bot `docsRouter`). The shared single-doc handlers
 * (get/view/rename/delete/share/octo-doc) are reused verbatim — no fork.
 */
export const documentResourceRouter: ExpressRouter = Router()
documentResourceRouter.get('/:docId/open-context', openContextHandler)
documentResourceRouter.post('/:docId/collab-token', docIdCollabTokenHandler)
documentResourceRouter.post('/:docId/view', recordDocViewHandler)
documentResourceRouter.get('/:docId/share', getShareHandler)
documentResourceRouter.put('/:docId/share', putShareHandler)
// `/octo-doc/:slug` is intentionally bot-only on `docsRouter`: a slug is unique
// only within a server-resolved Bot Space and cannot be made docId-first safely
// on the human mount. Humans rename/delete through canonical `/:docId` routes.
documentResourceRouter.get('/:docId', getDocHandler)
documentResourceRouter.patch('/:docId', renameDocHandler)
documentResourceRouter.delete('/:docId', deleteDocHandler)
