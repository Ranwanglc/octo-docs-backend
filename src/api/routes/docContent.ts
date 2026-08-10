/**
 * Bot document-body content endpoints (design §2). Incremental edit + live read
 * of a document's ProseMirror body, mounted on BOTH the human /api/v1/docs chain
 * and the bot /v1/bot/docs chain (see app.ts) so each reads req.uid / req.spaceId
 * from whichever identity middleware ran.
 *
 *   PATCH /:docId/content   writer  — incremental edit under a strict If-Match
 *                                     client base-version guard (§2.1)
 *   GET   /:docId/content   reader  — read the LIVE body + its base version (§2.2)
 *
 * The route gate (requireDocRole) is UX / a cheap 404 pass; the authoritative
 * role + permission_epoch recheck happens again under the row lock inside the
 * editDocBody service, because the live write path bypasses onAuthenticate.
 */
import { Router, type Router as ExpressRouter, type Request, type Response } from 'express'
import { requireDocRole } from '../guard.js'
import { readLiveForEdit } from '../../collab/liveDocWrite.js'
import { editDocBody } from '../services/editDocBody.js'
import { encodeBaseVersion, parseBaseVersion, type DocEditOp } from '../../collab/docBodyEdit.js'
import { SCHEMA_VERSION } from '../../schema/index.js'
import { config } from '../../config/env.js'

export const docContentRouter: ExpressRouter = Router()

/**
 * The only doc_type this rich-text body-edit surface accepts. board/whiteboard
 * (and any future non-ProseMirror body type) store a different Y.Doc shape, so
 * feeding them ProseMirror block-ops would GET silent-empty and PATCH corrupt
 * the blob. Both handlers reject a non-'doc' target BEFORE any decode/mutate;
 * the guard is defensive and self-contained so it holds regardless of the merge
 * order with the whiteboard stack.
 */
const BODY_EDITABLE_DOC_TYPE = 'doc'

/**
 * Reject a target whose doc_type is not the rich-text body type. Writes a
 * 409 unsupported_doc_type and returns false when blocked. Applied to both the
 * read and write handlers so a board/whiteboard doc can neither be read as empty
 * rich text nor mutated into a spurious ProseMirror fragment.
 */
function requireBodyEditableDocType(res: Response, docType: string): boolean {
  if (docType !== BODY_EDITABLE_DOC_TYPE) {
    res.status(409).json({ error: 'unsupported_doc_type' })
    return false
  }
  return true
}

/** Extract the base-version token from the If-Match header or the body mirror. */
function readBaseVersion(req: Request): string | null {
  const header = req.headers['if-match']
  const raw = Array.isArray(header) ? header[0] : header
  if (typeof raw === 'string' && raw.trim() !== '') {
    // If-Match carries the token as a quoted entity-tag; strip the quotes.
    return raw.trim().replace(/^"(.*)"$/, '$1')
  }
  const bodyBase = (req.body ?? {}).baseVersion
  if (typeof bodyBase === 'string' && bodyBase !== '') return bodyBase
  return null
}

/** Every entry of `path` must be a non-negative integer. */
function isValidPath(path: unknown): path is number[] {
  return Array.isArray(path) && path.length > 0 && path.every((n) => Number.isInteger(n) && (n as number) >= 0)
}

/**
 * A root-container insert: the empty path `[]` addresses the doc root and is
 * legal ONLY for `insert` with `inside_start` / `inside_end` (insert as the
 * doc's first / last child — the sole way to write the first block into an
 * empty document). `before` / `after` and replace/delete against the root stay
 * rejected via isValidPath, which still requires a non-empty path.
 */
function isRootInsertPosition(path: unknown, position: unknown): boolean {
  return (
    Array.isArray(path) &&
    path.length === 0 &&
    (position === 'inside_start' || position === 'inside_end')
  )
}

/** Structural (shape-only) validation of the op batch — a bad shape is a 400. */
function validateOpsShape(ops: unknown): ops is DocEditOp[] {
  if (!Array.isArray(ops) || ops.length === 0) return false
  return ops.every((op) => {
    if (!op || typeof op !== 'object') return false
    const o = op as Record<string, unknown>
    if (o.type === 'insert') {
      const at = o.at as { path?: unknown; position?: unknown } | undefined
      const positions = ['before', 'after', 'inside_start', 'inside_end']
      return (
        !!at &&
        typeof at.position === 'string' &&
        positions.includes(at.position) &&
        (isValidPath(at.path) || isRootInsertPosition(at.path, at.position)) &&
        Array.isArray(o.content)
      )
    }
    if (o.type === 'replace' || o.type === 'delete') {
      const range = o.range as { from?: { path?: unknown }; to?: { path?: unknown } } | undefined
      if (!range || !range.from || !range.to || !isValidPath(range.from.path) || !isValidPath(range.to.path)) {
        return false
      }
      return o.type === 'delete' ? true : Array.isArray(o.content)
    }
    return false
  })
}

/** Every block path referenced by an op (insert anchor, range endpoints). */
function opPaths(op: DocEditOp): number[][] {
  if (op.type === 'insert') return [op.at.path]
  return [op.range.from.path, op.range.to.path]
}

/**
 * Request-shape bounds enforced BEFORE the no-lock op resolution (DoS gate).
 * validateOpsShape only checks structure; this caps magnitude so a ≤1mb body
 * cannot force unbounded resolve / PMNode.fromJSON / Y.Doc hydration work:
 *   - op count            → 413 too_many_ops
 *   - single op content   → 413 op_content_too_large
 *   - block-path depth    → 400 path_too_deep
 * Content byte-size is measured on the already-parsed (≤1mb) body, so the check
 * itself is bounded. Returns the error to send, or null when within bounds.
 */
function checkOpsBounds(ops: DocEditOp[]): { status: number; error: string } | null {
  if (ops.length > config.docBodyEdit.maxOps) {
    return { status: 413, error: 'too_many_ops' }
  }
  for (const op of ops) {
    for (const path of opPaths(op)) {
      if (path.length > config.docBodyEdit.maxPathDepth) {
        return { status: 400, error: 'path_too_deep' }
      }
    }
    if (op.type === 'insert' || op.type === 'replace') {
      if (Buffer.byteLength(JSON.stringify(op.content)) > config.docBodyEdit.maxOpContentBytes) {
        return { status: 413, error: 'op_content_too_large' }
      }
    }
  }
  return null
}

// ── GET /:docId/content — read the live body (reader) ─────────────────────────
docContentRouter.get('/:docId/content', getDocContentHandler)

export async function getDocContentHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(req, res, req.params.docId!, 'reader')
  if (!guard) return
  if (!requireBodyEditableDocType(res, guard.meta.doc_type)) return

  try {
    const { pmDoc, baseSV } = await readLiveForEdit(guard.meta.document_name)
    res.status(200).json({
      docId: guard.meta.doc_id,
      doc: pmDoc.toJSON(),
      schemaVersion: SCHEMA_VERSION,
      baseVersion: encodeBaseVersion(baseSV),
    })
  } catch {
    res.status(500).json({ error: 'internal_error' })
  }
}

// ── PATCH /:docId/content — incremental edit (writer) ─────────────────────────
docContentRouter.patch('/:docId/content', patchDocContentHandler)

export async function patchDocContentHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(req, res, req.params.docId!, 'writer')
  if (!guard) return
  if (!requireBodyEditableDocType(res, guard.meta.doc_type)) return

  const baseVersionRaw = readBaseVersion(req)
  if (baseVersionRaw === null) {
    res.status(400).json({ error: 'invalid_body' })
    return
  }
  const ops = (req.body ?? {}).ops
  if (!validateOpsShape(ops)) {
    res.status(400).json({ error: 'invalid_body' })
    return
  }
  // Fail-fast request-shape bounds (DoS gate) before any op resolution.
  const bounds = checkOpsBounds(ops)
  if (bounds) {
    res.status(bounds.status).json({ error: bounds.error })
    return
  }

  try {
    const result = await editDocBody({
      uid: req.uid!,
      docId: guard.meta.doc_id,
      documentName: guard.meta.document_name,
      clientBaseVersion: parseBaseVersion(baseVersionRaw),
      ops,
      authorizedEpoch: guard.meta.permission_epoch,
      isBot: req.botToken !== undefined,
      token: req.octoToken,
    })
    if (result.ok) {
      res.status(200).json({
        docId: guard.meta.doc_id,
        bytes: result.bytes,
        baseVersion: result.baseVersion,
        newDocVersionSeq: result.newDocVersionSeq,
      })
      return
    }
    res.status(result.status).json({ error: result.error })
  } catch {
    res.status(500).json({ error: 'internal_error' })
  }
}
