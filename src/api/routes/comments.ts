/**
 * Inline-comment endpoints (feature #3 — doc_comment).
 *   GET    /api/v1/docs/{docId}/comments        (reader)  list thread roots + replies
 *   POST   /api/v1/docs/{docId}/comments        (commenter) create root or reply
 *   PATCH  /api/v1/docs/{docId}/comments/{id}    body edit -> author+writer; resolve -> writer
 *   DELETE /api/v1/docs/{docId}/comments/{id}    soft -> author; hard -> admin
 *
 * Comments live entirely out-of-band from the Y.Doc. Anchors are opaque encoded
 * Yjs RelativePosition bytes: base64 on the wire, decoded to a Buffer for the
 * BLOB columns and served back as base64. The server never parses them.
 *
 * A root comment's anchors normally come from a browser's live selection. A bot
 * has no live selection, so it may instead supply `anchorText` (+ optional
 * `blockPath` / `occurrence` to disambiguate) and the server resolves it against
 * the live document into the same anchor bytes (feature #70; see anchorResolve).
 * The legacy explicit `anchorStart` / `anchorEnd` path is kept unchanged and
 * always takes precedence, so the existing front-end selection flow is not
 * affected.
 *
 * Readers are read-only. Creating/replying and deleting one's own comment need
 * commenter; body edits and resolve/reopen need writer; hard delete needs admin.
 */
import { Router, type Router as ExpressRouter, type Request, type Response } from 'express'
import { requireDocRole } from '../guard.js'
import { roleAtLeast } from '../../permission/role.js'
import { docCommentRepo, type DocComment } from '../../db/repos/docCommentRepo.js'
import {
  resolveAnchorFromLiveDoc,
  AmbiguousAnchorError,
  AnchorTextNotFoundError,
} from '../../collab/anchorResolve.js'
import { notifyDocMentioned } from '../services/docsNotify.js'
import type { BlockPath } from '../../collab/docBodyEdit.js'
import { isDocType } from '../../db/docType.js'
import { validateExplicitCommentAnchors } from '../services/commentAnchors.js'
import { publishCommentMutation } from '../services/commentEvents.js'

export const commentsRouter: ExpressRouter = Router()

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

/**
 * The only doc_type whose live body is a ProseMirror fragment `anchorText` can be
 * resolved against. A sheet/board/whiteboard stores a different Y.Doc shape
 * (COLLAB_FIELD is not a PM fragment), so feeding it to `initProseMirrorDoc`
 * inside the resolver throws. Mirrors docContent.ts's `BODY_EDITABLE_DOC_TYPE`
 * gate — kept local and self-contained so it holds regardless of merge order.
 */
const ANCHOR_RESOLVABLE_DOC_TYPE = 'doc'

/**
 * Reject `anchorText` resolution against a non-rich-text doc_type with a
 * 409 unsupported_doc_type (same contract as docContent.ts). Returns false when
 * blocked so the caller stops before opening/parsing the live document.
 */
function requireAnchorResolvableDocType(res: Response, docType: string): boolean {
  if (docType !== ANCHOR_RESOLVABLE_DOC_TYPE) {
    res.status(409).json({ error: 'unsupported_doc_type' })
    return false
  }
  return true
}

/** Parse a positive integer id from a path/body value, or null when malformed. */
function parseId(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const n = Number(raw)
    return Number.isSafeInteger(n) && n > 0 ? n : null
  }
  return null
}

/** Sentinel: a supplied disambiguation value is present but not well-formed. */
const INVALID_DISAMBIGUATION = Symbol('invalid_disambiguation')

/**
 * Parse an optional `blockPath` disambiguation value into a child-index path.
 *   - `undefined` / `null`      => absent
 *   - number[] of non-neg ints  => that path
 *   - "0,2,1" comma-separated    => parsed path (CLI passes a string flag)
 *   - anything else             => INVALID_DISAMBIGUATION
 * An empty path is rejected (it addresses the doc root, not a text block).
 */
function parseBlockPath(raw: unknown): BlockPath | undefined | typeof INVALID_DISAMBIGUATION {
  if (raw === undefined || raw === null) return undefined
  let parts: unknown[]
  if (Array.isArray(raw)) {
    parts = raw
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed === '') return INVALID_DISAMBIGUATION
    parts = trimmed.split(',').map((s) => s.trim())
  } else {
    return INVALID_DISAMBIGUATION
  }
  if (parts.length === 0) return INVALID_DISAMBIGUATION
  const path: number[] = []
  for (const part of parts) {
    const n =
      typeof part === 'number'
        ? part
        : typeof part === 'string' && /^\d+$/.test(part)
          ? Number(part)
          : NaN
    if (!Number.isInteger(n) || n < 0) return INVALID_DISAMBIGUATION
    path.push(n)
  }
  return path
}

/**
 * Parse an optional 1-based `occurrence` selector.
 *   - `undefined` / `null` => absent
 *   - positive integer     => that occurrence
 *   - anything else        => INVALID_DISAMBIGUATION
 */
function parseOccurrence(raw: unknown): number | undefined | typeof INVALID_DISAMBIGUATION {
  if (raw === undefined || raw === null) return undefined
  const n =
    typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN
  if (!Number.isSafeInteger(n) || n < 1) return INVALID_DISAMBIGUATION
  return n
}

/** Serialize a stored comment for the wire (anchors -> base64). */
function serialize(c: DocComment) {
  return {
    id: c.id,
    docId: c.docId,
    parentId: c.parentId,
    authorUid: c.authorUid,
    body: c.body,
    anchorStart: c.anchorStart ? c.anchorStart.toString('base64') : null,
    anchorEnd: c.anchorEnd ? c.anchorEnd.toString('base64') : null,
    anchorText: c.anchorText,
    resolved: c.resolved,
    resolvedBy: c.resolvedBy,
    resolvedAt: c.resolvedAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }
}

commentsRouter.get('/:docId/comments/markers', listCommentMarkersHandler)
commentsRouter.get('/:docId/comments/:id/thread', getCommentThreadHandler)
commentsRouter.get('/:docId/comments', listCommentsHandler)

/** Fetch one grouped root by marker id without walking paginated thread pages. */
export async function getCommentThreadHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'reader', { isBot: req.botToken !== undefined, token: req.octoToken })
  if (!guard) return
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  const root = await docCommentRepo.getById(id)
  if (!root || root.docId !== guard.meta.doc_id || root.parentId !== null || root.deleted) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  const replies = await docCommentRepo.listReplies(id)
  res.status(200).json({ ...serialize(root), replies: replies.map(serialize) })
}

/** Paginated lightweight marker feed; every page contains unresolved roots only. */
export async function listCommentMarkersHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'reader', { isBot: req.botToken !== undefined, token: req.octoToken })
  if (!guard) return
  if (guard.meta.doc_type !== 'board') {
    res.status(409).json({ error: 'unsupported_doc_type' })
    return
  }
  const rawCursor = req.query.cursor
  const cursor = rawCursor === undefined ? null : parseId(rawCursor)
  if (rawCursor !== undefined && cursor === null) {
    res.status(400).json({ error: 'invalid_cursor' })
    return
  }
  const limitRaw = Number(req.query.limit ?? DEFAULT_LIMIT)
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : DEFAULT_LIMIT))
  const roots = await docCommentRepo.listUnresolvedMarkers(guard.meta.doc_id, cursor, limit)
  const items = roots.map((root) => ({
    id: root.id,
    anchorStart: root.anchorStart.toString('base64'),
    anchorEnd: root.anchorEnd.toString('base64'),
    anchorText: root.anchorText,
    resolved: root.resolved,
    updatedAt: root.updatedAt,
  }))
  const nextCursor = roots.length === limit ? roots[roots.length - 1]!.id : null
  res.status(200).json({ items, nextCursor })
}

export async function listCommentsHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'reader', { isBot: req.botToken !== undefined, token: req.octoToken })
  if (!guard) return

  const includeResolved = req.query.includeResolved === '1'
  const cursor = parseId(req.query.cursor)
  const limitRaw = Number(req.query.limit ?? DEFAULT_LIMIT)
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : DEFAULT_LIMIT))

  const roots = await docCommentRepo.listRoots(guard.meta.doc_id, { includeResolved, cursor, limit })
  // Batch all replies for this page of roots in ONE query, then group by
  // parent in memory — avoids an N+1 (one listReplies per root, up to ~101).
  const replies = await docCommentRepo.listRepliesForRoots(roots.map((r) => r.id))
  const byParent = new Map<number, DocComment[]>()
  for (const reply of replies) {
    const group = byParent.get(reply.parentId!)
    if (group) group.push(reply)
    else byParent.set(reply.parentId!, [reply])
  }
  const items = roots.map((root) => ({
    ...serialize(root),
    replies: (byParent.get(root.id) ?? []).map(serialize),
  }))
  const nextCursor = roots.length === limit ? roots[roots.length - 1]!.id : null

  res.status(200).json({ items, nextCursor })
}

commentsRouter.post('/:docId/comments', createCommentHandler)

export async function createCommentHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'commenter', { isBot: req.botToken !== undefined, token: req.octoToken })
  if (!guard) return

  const { body, anchorStart, anchorEnd, anchorText, parentId } = req.body ?? {}

  if (typeof body !== 'string' || body.trim() === '') {
    res.status(400).json({ error: 'body required' })
    return
  }

  const docId = guard.meta.doc_id
  const documentName = guard.meta.document_name

  if (parentId !== undefined && parentId !== null) {
    // ── Reply: must point at an existing root in THIS doc; no anchors. ──
    const pid = parseId(parentId)
    if (pid === null) {
      res.status(400).json({ error: 'invalid parentId' })
      return
    }
    // Validate and insert under one row lock so a concurrent root delete cannot create an orphan.
    const id = await docCommentRepo.createReplyIfRoot({
      docId,
      documentName,
      parentId: pid,
      authorUid: req.uid!,
      body,
    })
    // Hide cross-doc, deleted, and nested parent references behind 404.
    if (id === null) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    // Best-effort: notify mentions and invalidate live comment views.
    void notifyDocMentioned({ docId, spaceId: req.spaceId!, title: guard.meta.title, authorUid: req.uid!, body })
    void publishCommentMutation(documentName, docId, id, 'created')
    res.status(201).json({ id })
    return
  }

  // ── Root: anchors are required. Two ways to supply them: ──
  //   (a) legacy — explicit base64 anchorStart/anchorEnd from a live selection;
  //   (b) bot — anchorText (+ optional blockPath/occurrence), resolved here.
  // Legacy explicit anchors always win, so the existing front-end flow (which
  // sends both anchors AND an anchorText snapshot) is untouched.
  const hasStart = anchorStart !== undefined && anchorStart !== null
  const hasEnd = anchorEnd !== undefined && anchorEnd !== null

  let start: Buffer
  let end: Buffer
  if (hasStart && hasEnd) {
    // (a) Explicit anchors. Board anchors are canonical versioned JSON; all
    // other document types retain their existing opaque formats and reject the
    // board namespace.
    if (!isDocType(guard.meta.doc_type)) {
      res.status(409).json({ error: 'unsupported_doc_type' })
      return
    }
    const validated = validateExplicitCommentAnchors(guard.meta.doc_type, anchorStart, anchorEnd)
    if (!validated.ok) {
      res.status(400).json({ error: validated.error })
      return
    }
    start = validated.start
    end = validated.end
  } else if (!hasStart && !hasEnd && typeof anchorText === 'string' && anchorText.trim() !== '') {
    // (b) Bot path: resolve anchorText against the live document.
    // Gate the doc_type BEFORE touching the live doc: a non-'doc' target stores a
    // non-ProseMirror Y.Doc, so the resolver's initProseMirrorDoc would throw.
    if (!requireAnchorResolvableDocType(res, guard.meta.doc_type)) return
    const blockPath = parseBlockPath((req.body as Record<string, unknown>).blockPath)
    const occurrence = parseOccurrence((req.body as Record<string, unknown>).occurrence)
    if (blockPath === INVALID_DISAMBIGUATION) {
      res.status(400).json({ error: 'invalid_block_path' })
      return
    }
    if (occurrence === INVALID_DISAMBIGUATION) {
      res.status(400).json({ error: 'invalid_occurrence' })
      return
    }
    try {
      const resolved = await resolveAnchorFromLiveDoc(documentName, { anchorText, blockPath, occurrence })
      start = resolved.anchorStart
      end = resolved.anchorEnd
    } catch (err) {
      // Fail-loud ambiguity/miss contract (design item 3) -> 422.
      if (err instanceof AmbiguousAnchorError) {
        res.status(422).json({ error: 'ambiguous_anchor', matches: err.matches })
        return
      }
      if (err instanceof AnchorTextNotFoundError) {
        res.status(422).json({ error: 'anchor_text_not_found' })
        return
      }
      // Any other failure (bad fragment, live-doc read error, …) is unexpected.
      // This is a bare async Express handler, so a re-thrown rejection would
      // escape as an unhandled rejection — never reaching app.ts's central error
      // middleware — and the client request would hang until timeout. Convert it
      // to a 500 internal_error here, matching docContent.ts's try/catch.
      res.status(500).json({ error: 'internal_error' })
      return
    }
  } else {
    // Neither a full legacy anchor pair nor a usable anchorText.
    res.status(400).json({ error: 'anchorStart and anchorEnd required for a root comment' })
    return
  }
  const id = await docCommentRepo.create({
    docId,
    documentName,
    parentId: null,
    authorUid: req.uid!,
    body,
    anchorStart: start,
    anchorEnd: end,
    anchorText: typeof anchorText === 'string' ? anchorText.slice(0, 512) : '',
  })
  // Best-effort: notify mentions and invalidate live comment views.
  void notifyDocMentioned({ docId, spaceId: req.spaceId!, title: guard.meta.title, authorUid: req.uid!, body })
  void publishCommentMutation(documentName, docId, id, 'created')
  res.status(201).json({ id })
}

commentsRouter.patch('/:docId/comments/:id', patchCommentHandler)

export async function patchCommentHandler(req: Request, res: Response): Promise<void> {
  const docId = req.params.docId!
  // Mutation floor: readers may list comments but cannot change them.
  // This runs FIRST so it 404s on missing/deleted docs, 409s on archived ones,
  // and 403s a caller whose role is 'none' (e.g. revoked author) — before the
  // author check below ever gets a chance to allow a write.
  const guard = await requireDocRole(res, req.uid!, docId, req.spaceId!, 'commenter', { isBot: req.botToken !== undefined, token: req.octoToken })
  if (!guard) return

  const id = parseId(req.params.id)
  if (id === null) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  const comment = await docCommentRepo.getById(id)
  // Cross-doc / missing / deleted => 404 (do not leak existence).
  if (!comment || comment.docId !== guard.meta.doc_id || comment.deleted) {
    res.status(404).json({ error: 'not_found' })
    return
  }

  const { body, resolved } = req.body ?? {}

  // Resolve / reopen a thread root — requires writer (elevated above the floor).
  if (resolved !== undefined) {
    if (!roleAtLeast(guard.role, 'writer')) {
      res.status(403).json({ error: 'forbidden' })
      return
    }
    if (comment.parentId !== null) {
      res.status(400).json({ error: 'only a thread root can be resolved' })
      return
    }
    if (typeof resolved !== 'boolean') {
      res.status(400).json({ error: 'resolved must be a boolean' })
      return
    }
    await docCommentRepo.setResolved(id, resolved, req.uid!)
    // Resolve/reopen changes both thread and marker visibility; clients refresh.
    void publishCommentMutation(guard.meta.document_name, guard.meta.doc_id, id, 'updated')
    res.status(200).json({ id })
    return
  }

  // Body edit remains a writer operation; writers may edit only their own comments.
  if (body !== undefined) {
    if (comment.authorUid !== req.uid || !roleAtLeast(guard.role, 'writer')) {
      res.status(403).json({ error: 'forbidden' })
      return
    }
    if (typeof body !== 'string' || body.trim() === '') {
      res.status(400).json({ error: 'body required' })
      return
    }
    await docCommentRepo.updateBody(id, body)
    void publishCommentMutation(guard.meta.document_name, guard.meta.doc_id, id, 'updated')
    res.status(200).json({ id })
    return
  }

  res.status(400).json({ error: 'nothing to update' })
}

commentsRouter.delete('/:docId/comments/:id', deleteCommentHandler)

export async function deleteCommentHandler(req: Request, res: Response): Promise<void> {
  const docId = req.params.docId!
  // Commenter floor (see patchCommentHandler): blocks readers/revoked authors and
  // enforces doc-status 404/409 semantics before the author check below.
  const guard = await requireDocRole(res, req.uid!, docId, req.spaceId!, 'commenter', { isBot: req.botToken !== undefined, token: req.octoToken })
  if (!guard) return

  const id = parseId(req.params.id)
  if (id === null) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  const comment = await docCommentRepo.getById(id)
  if (!comment || comment.docId !== guard.meta.doc_id || comment.deleted) {
    res.status(404).json({ error: 'not_found' })
    return
  }

  const hard = req.query.hard === '1'

  if (hard) {
    // Hard delete is a moderator action — needs admin (admin/owner).
    if (!roleAtLeast(guard.role, 'admin')) {
      res.status(403).json({ error: 'forbidden' })
      return
    }
    // doc_id from the guard is authoritative; scopes the destructive cascade.
    await docCommentRepo.hardDelete(id, guard.meta.doc_id)
    void publishCommentMutation(guard.meta.document_name, guard.meta.doc_id, id, 'deleted')
    res.status(200).json({ id })
    return
  }

  // Soft delete — only the author can remove their own comment.
  if (comment.authorUid !== req.uid) {
    res.status(403).json({ error: 'forbidden' })
    return
  }
  await docCommentRepo.softDelete(id)
  void publishCommentMutation(guard.meta.document_name, guard.meta.doc_id, id, 'deleted')
  res.status(200).json({ id })
}
