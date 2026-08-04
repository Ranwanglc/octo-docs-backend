/**
 * Document CRUD routes (§8.4): create / list / rename / soft-delete.
 * Mounted under /api/v1/docs.
 */
import { Router, type Router as ExpressRouter, type Request, type Response } from 'express'
import { docMetaRepo } from '../../db/repos/docMetaRepo.js'
import { DocOwnershipError } from '../../db/repos/docMetaRepo.js'
import { docMemberRepo } from '../../db/repos/docMemberRepo.js'
import { docViewHistoryRepo } from '../../db/repos/docViewHistoryRepo.js'
import { normalizeTypeFilter, HTML_DOC_TYPE } from '../../db/docType.js'
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
    // Mirror the PUT /members mutation: a doc_member change bumps the epoch and
    // broadcasts the invalidation (§4.5) so any listener recomputes access.
    await bumpEpoch(docId, documentName, botOwnerUid)
  }
}

/** POST /api/v1/docs — create. Creator becomes owner (implicit admin, §4.2). */
export async function createDocHandler(req: Request, res: Response) {
  const uid = req.uid!
  const { folderId, title, docType, octoDocSlug, mountType } = req.body ?? {}
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
  if (resolvedDocType === HTML_DOC_TYPE) {
    if (!req.botToken) {
      res.status(400).json({ error: 'html registration requires bot mount' })
      return
    }
    if (mountType !== 'group' && mountType !== 'space' && mountType !== 'thread') {
      res.status(400).json({ error: 'mountType must be group, space, or thread' })
      return
    }
    if (typeof octoDocSlug !== 'string' || octoDocSlug === '') {
      res.status(400).json({ error: 'octoDocSlug required' })
      return
    }
    if (octoDocSlug.length > 128) {
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
  const createInput = {
    docId,
    documentName,
    title: typeof title === 'string' ? title : '',
    ownerId: uid,
    spaceId,
    folderId: folder,
    docType: resolvedDocType,
    ...(resolvedDocType === HTML_DOC_TYPE ? { octoDocSlug } : {}),
    createdBy: uid,
  }
  let writeResult
  if (resolvedDocType === HTML_DOC_TYPE) {
    try {
      writeResult = await docMetaRepo.upsertHtmlByOctoDocSlug({ ...createInput, octoDocSlug })
    } catch (err) {
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
    writeResult = { meta: await docMetaRepo.getByDocId(docId), created: true }
  }
  const meta = writeResult.meta
  // Bot path only: the doc owner is the bot itself (ownerId = bot uid), so the
  // bot's human owner would otherwise have no membership and could not see the
  // doc. Auto-grant that human owner admin. req.botOwnerUid is set solely by
  // verifyBot (from octo-server's robot.creator_uid reverse lookup) and only when
  // a real human creator exists — it is never set on the human mount, so this
  // block is a no-op there. Skip when the owner is the bot itself (no distinct
  // human owner, e.g. a platform bot) to avoid a redundant self-membership row.
  // This is purely additive: the doc's owner field and the bot's own access are
  // unchanged (§4.2 owner is implicit admin); the human owner is added on top.
  //
  // Run on BOTH the fresh-create AND the html idempotent-recovery path
  // (created:false): a prior partial failure could have written doc_meta but
  // never granted the human owner admin, leaving them unable to see their own
  // doc. grantBotOwnerAdmin is idempotent (upsertDirect + bumpEpoch) and
  // self-no-ops when botOwnerUid is absent or equals uid, so calling it
  // unconditionally heals that recovery case with no double-work regression.
  if (meta) {
    await grantBotOwnerAdmin(req, meta.doc_id ?? docId, meta.document_name ?? documentName)
  }

  // html docs are now indexed too: after registering the meta row (fresh
  // create OR idempotent-recovery upsert), enqueue an index signal for the
  // published documentName. Gated OFF by default; html goes through the SAME
  // isSearchIndexedDoc + enqueueDocIndex path as the rename branch below, so
  // the octo-doc-indexer picks it up and resolves the body by reading the
  // latest `v<N>/index.html` from S3 (html has no Yjs body, so the collab
  // afterStoreDocument feed cannot see it — this handler is the enqueue site).
  // Best-effort / fire-and-forget: enqueue swallows its own errors so a Kafka
  // outage does not fail the registration response.
  const responseDocId = resolvedDocType === HTML_DOC_TYPE ? (meta?.doc_id ?? docId) : docId
  const responseDocumentName = resolvedDocType === HTML_DOC_TYPE ? (meta?.document_name ?? documentName) : documentName
  const responseSpaceId = resolvedDocType === HTML_DOC_TYPE ? (meta?.space_id ?? spaceId) : spaceId
  const responseFolderId = resolvedDocType === HTML_DOC_TYPE ? (meta?.folder_id ?? folder) : folder
  const responseOwnerId = resolvedDocType === HTML_DOC_TYPE ? (meta?.owner_id ?? uid) : uid
  if (resolvedDocType === HTML_DOC_TYPE && config.search.indexEnabled && isSearchIndexedDoc(responseDocumentName)) {
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
    ...(resolvedDocType === HTML_DOC_TYPE ? { octoDocSlug } : {}),
    ...(resolvedDocType === HTML_DOC_TYPE ? { created: writeResult.created } : {}),
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

docsRouter.post('/', createDocHandler)

/** GET /api/v1/docs/{docId} — fetch one doc's metadata (needs reader). */
export async function getDocHandler(req: Request, res: Response) {
  const uid = req.uid!
  const docId = req.params.docId!
  const guard = await requireDocRole(res, uid, docId, req.spaceId!, 'reader', { isBot: req.botToken !== undefined, token: req.octoToken })
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
 * (FEAT-B ingest, §3.1). Idempotent UPSERT on (uid, doc_id): a re-open only
 * refreshes viewed_at, never adds a row. uid is derived server-side; any uid /
 * viewedBy in the body is ignored. Needs reader (reuses requireDocRole guard).
 */
export async function recordDocViewHandler(req: Request, res: Response) {
  const uid = req.uid!
  const docId = req.params.docId!
  const guard = await requireDocRole(res, uid, docId, req.spaceId!, 'reader', {
    isBot: req.botToken !== undefined,
    token: req.octoToken,
  })
  if (!guard) return
  const viewedAt = await docViewHistoryRepo.upsertViewWithPrune({
    uid,
    docId,
    spaceId: req.spaceId!,
    retainCount: config.docView.retainCount,
    retainDays: config.docView.retainDays,
  })
  res.status(200).json({ ok: true, viewedAt: new Date(viewedAt).toISOString() })
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
  // Tenant isolation (P0): resolve the slug within the caller's enforced space
  // (req.spaceId; set by spaceContextMiddleware on the human mount and injected
  // by verifyBot on the bot mount). A slug is only unique per space, so this
  // never resolves another space's row (which requireDocRole would 404 anyway).
  const meta = await docMetaRepo.getByOctoDocSlug(octoDocSlug, req.spaceId!)
  if (!meta || meta.status === 0) {
    res.status(404).json({ error: 'not_found' })
    return null
  }
  return meta.doc_id
}

async function renameDocById(req: Request, res: Response, docId: string): Promise<void> {
  const guard = await requireDocRole(res, req.uid!, docId, req.spaceId!, 'admin', { isBot: req.botToken !== undefined })
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
  const guard = await requireDocRole(res, req.uid!, docId, req.spaceId!, 'admin', { isBot: req.botToken !== undefined })
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

docsRouter.patch('/octo-doc/:octoDocSlug', async (req: Request, res: Response) => {
  const docId = await resolveDocIdBySlug(req, res)
  if (!docId) return
  await renameDocById(req, res, docId)
})

docsRouter.delete('/octo-doc/:octoDocSlug', async (req: Request, res: Response) => {
  const docId = await resolveDocIdBySlug(req, res)
  if (!docId) return
  await deleteDocById(req, res, docId)
})

/** PATCH /api/v1/docs/{docId} — rename (needs admin). */
docsRouter.patch('/:docId', async (req: Request, res: Response) => {
  await renameDocById(req, res, req.params.docId!)
})

/** DELETE /api/v1/docs/{docId} — soft delete (needs admin). */
docsRouter.delete('/:docId', async (req: Request, res: Response) => {
  await deleteDocById(req, res, req.params.docId!)
})

/**
 * GET /api/v1/docs/{docId}/share — read a doc's share settings (#64, needs
 * reader). Anyone who can see the doc can see its scope, so the client dialog
 * can render current state for any viewer. 404 (not 403) for a missing/deleted
 * or cross-space doc (requireDocRole existence-hiding ordering); 403 when the
 * caller has no effective role on the doc.
 */
export async function getShareHandler(req: Request, res: Response) {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'reader', {
    isBot: req.botToken !== undefined,
    token: req.octoToken,
  })
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
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'admin', {
    isBot: req.botToken !== undefined,
  })
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
