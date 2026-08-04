/**
 * Server-side .docx import (§ docx-import).
 *
 *   POST /:docId/import/docx   editor — parse an uploaded Word document into a
 *                              ProseMirror-JSON doc, uploading embedded images
 *                              into the doc's attachment store along the way.
 *
 * The raw .docx bytes arrive as an untrusted binary body (express.raw, scoped
 * to this route with a hard size cap). The zip extractor already enforces its
 * own bomb/oversize protection; this route adds the outer request-size ceiling
 * and a default-deny editor guard on top.
 *
 * Embedded images are streamed through a MediaUploadCtx that mirrors the
 * attachments presign+register flow: for each image the extractor keeps, we
 * mint an attachId, register a doc_attachment row, presign a PUT and upload the
 * bytes to object storage. The parser rewrites the image node to carry that
 * attachId; a failed / oversized / unrecognised image degrades to a
 * fileAttachment node instead of sinking the whole import.
 *
 * Parse failures (malformed zip, unreadable OOXML) return 422 import_failed and
 * are logged server-side without leaking any internal path or stack.
 */
import { Router, type Request, type Response } from 'express'
import express from 'express'
import { requireDocRole } from '../guard.js'
import { newAttachId } from '../../util/ids.js'
import { config } from '../../config/env.js'
import { getObjectStore } from '../../storage/objectStore.js'
import { docAttachmentRepo } from '../../db/repos/docAttachmentRepo.js'
import { importDocxWithMedia } from '../../import/docx/index.js'
import { DocxUnsafeError } from '../../import/docx/extract.js'
import {
  acquireDocxImportSlot,
  releaseDocxImportSlot,
  DocxImportBusyError,
} from '../../import/docx/importQueue.js'
import type { MediaUploadCtx } from '../../import/docx/media.js'
import { parseMarkdownToPmDoc } from '../../import/markdown/markdown.js'
import { resolveGitHubEmoji } from '../../import/markdown/emoji.js'
import { parseXlsx, XlsxParseError } from '../../import/xlsx/parse.js'
import { xlsxWorkbookToSheetBatch } from '../../import/xlsx/toSheetBatch.js'
import { readLiveSheet } from '../../collab/liveSheetWrite.js'
import { decodeSheetSnapshot, decodeSheetDimsSnapshot, decodeSheetDrawingsSnapshot, decodeSheetHyperLinksSnapshot, decodeSheetMergesSnapshot, decodeSheetListSnapshot } from '../../collab/versionRestore.js'
import type { SheetCell, StoredDrawing, StoredHyperLink, StoredSheetMeta } from '../../agent/sheetConversion.js'
import { editDocSheet } from '../services/editDocSheet.js'
import { readLiveForEdit } from '../../collab/liveDocWrite.js'
import { editDocBody } from '../services/editDocBody.js'
import type { DocEditOp } from '../../collab/docBodyEdit.js'
import { readLiveBoard } from '../../collab/liveBoardWrite.js'
import { decodeBoardSnapshot, WHITEBOARD_DOC_TYPE } from '../../collab/versionRestore.js'
import { editBoardScene } from '../services/editBoardScene.js'
import {
  prepareExcalidrawImport,
  cleanupExcalidrawAttachments,
  cleanupReplacedExcalidrawAttachments,
  ExcalidrawImportError,
} from '../../import/excalidraw.js'
import { cleanupCopiedAttachment, copyStoredObject } from './attachments.js'
import { docMetaRepo } from '../../db/repos/docMetaRepo.js'
import { resolveRole } from '../../permission/resolveRole.js'
import { roleAtLeast } from '../../permission/role.js'

export const importRouter = Router()

const MAX_EXCALIDRAW_UPLOAD_BYTES = config.docxImport.maxUploadBytes
const rawExcalidrawBody = express.raw({ type: 'application/json', limit: MAX_EXCALIDRAW_UPLOAD_BYTES })

importRouter.post('/:docId/import/excalidraw', rawExcalidrawBody, importExcalidrawHandler)

function parseExcalidrawMode(originalUrl: string): 'merge' | 'replace' | null {
  const query = new URL(originalUrl, 'http://localhost').searchParams
  let mode: 'merge' | 'replace' = 'merge'
  let found = false
  for (const [key, value] of query) {
    if (key.startsWith('mode[')) return null
    if (key !== 'mode') continue
    if (found || (value !== 'merge' && value !== 'replace')) return null
    found = true
    mode = value
  }
  return mode
}

export async function importExcalidrawHandler(req: Request, res: Response): Promise<void> {
  const docIdParam: unknown = req.params.docId
  if (Array.isArray(docIdParam)) {
    res.status(400).json({ error: 'invalid_request' })
    return
  }
  if (typeof docIdParam !== 'string' || !docIdParam || typeof req.uid !== 'string' || typeof req.spaceId !== 'string') {
    res.status(400).json({ error: 'invalid_request' })
    return
  }
  const docIdSafe: string = docIdParam
  const guard = await requireDocRole(res, req.uid, docIdSafe, req.spaceId, 'writer', {
    isBot: req.botToken !== undefined, token: req.octoToken,
  })
  if (!guard) return
  if (guard.meta.doc_type !== WHITEBOARD_DOC_TYPE) {
    res.status(409).json({ error: 'unsupported_doc_type' })
    return
  }
  const mode = parseExcalidrawMode(String(req.originalUrl))
  if (mode === null) {
    res.status(400).json({ error: 'invalid_mode' })
    return
  }
  const rawBody: unknown = req.body
  if (Array.isArray(rawBody) || !Buffer.isBuffer(rawBody)) {
    res.status(400).json({ error: 'invalid_body' })
    return
  }
  const body: Buffer = rawBody
  const bodyLength: number = body.length
  if (bodyLength === 0) {
    res.status(400).json({ error: 'invalid_body' })
    return
  }
  if (bodyLength > MAX_EXCALIDRAW_UPLOAD_BYTES) {
    res.status(413).json({ error: 'doc_too_large' })
    return
  }

  let scene: unknown
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body)
    scene = JSON.parse(text)
  } catch {
    res.status(400).json({ error: 'invalid_json' })
    return
  }

  let prepared: Awaited<ReturnType<typeof prepareExcalidrawImport>> | undefined
  try {
    // The state vector from this exact live read is the import's concurrency
    // base. editBoardScene re-reads/rechecks it and creates the safety snapshot.
    const live = await readLiveBoard(guard.meta.document_name)
    const current = decodeBoardSnapshot(live.state)
    prepared = await prepareExcalidrawImport({
      scene,
      existingElements: current.elements,
      existingFiles: current.files,
      docId: guard.meta.doc_id,
      uid: req.uid,
    })
    const deletedElementIds = mode === 'replace'
      ? current.elements.filter((el) => typeof el.id === 'string').map((el) => el.id as string)
      : undefined
    const deletedFileIds = mode === 'replace' ? Object.keys(current.files) : undefined
    const result = await editBoardScene({
      uid: req.uid,
      docId: guard.meta.doc_id,
      documentName: guard.meta.document_name,
      clientBaseVersion: live.baseSV,
      ops: { elements: prepared.elements, files: prepared.files, deletedElementIds, deletedFileIds },
      authorizedEpoch: guard.meta.permission_epoch,
      isBot: req.botToken !== undefined,
      token: req.octoToken,
    })
    if (!result.ok) {
      await cleanupExcalidrawAttachments(prepared.uploadedAttachments ?? [])
      const body: Record<string, unknown> = { error: result.error }
      if (result.docBytes !== undefined) body.docBytes = result.docBytes
      if (result.limit !== undefined) body.limit = result.limit
      res.status(result.status).json(body)
      return
    }
    if (mode === 'replace') {
      await cleanupReplacedExcalidrawAttachments(guard.meta.doc_id, current.files)
    }
    res.status(200).json({
      docId: guard.meta.doc_id,
      mode,
      importedElements: prepared.elements.length,
      importedFiles: Object.keys(prepared.files).length,
      elementIdMap: prepared.elementIdMap,
      fileIdMap: prepared.fileIdMap,
      bytes: result.bytes,
      baseVersion: result.baseVersion,
      newDocVersionSeq: result.newDocVersionSeq,
    })
  } catch (err) {
    await cleanupExcalidrawAttachments(prepared?.uploadedAttachments ?? [])
    if (err instanceof ExcalidrawImportError) {
      res.status(err.status).json({ error: err.code })
      return
    }
    res.status(500).json({ error: 'internal_error' })
  }
}

/** CLI callers opt into server-side atomic application; browser callers keep parse-only behavior. */
function shouldApplyImport(req: Request): boolean {
  return req.header('x-octo-import-apply') === 'true'
}

async function applyImportedDoc(
  req: Request,
  res: Response,
  guard: NonNullable<Awaited<ReturnType<typeof requireDocRole>>>,
  doc: { type: string; content?: unknown[] },
  warnings: string[],
  requestCreatedAttachIds: string[] = [],
): Promise<void> {
  if (guard.meta.doc_type !== 'doc') {
    res.status(409).json({ error: 'unsupported_doc_type' })
    return
  }
  if (doc.type !== 'doc' || !Array.isArray(doc.content)) {
    res.status(422).json({ error: 'import_failed' })
    return
  }

  // Markdown exported from another document can carry that source document's
  // durable attachId alongside a signed URL. The id is not valid in the target
  // document and editDocBody correctly rejects cross-document references. Do
  // not let one stale/foreign image sink the whole atomic import: remove only
  // invalid attachment ids and retain the original src as a best-effort image.
  // We deliberately do not fetch the URL here; remote ingestion must go through
  // the dedicated SSRF-guarded attachment endpoint.
  const migration = await migrateImportedAttachments(
    doc.content,
    guard.meta.doc_id,
    req.uid!,
    req.spaceId!,
  )
  if (migration.count > 0) {
    warnings.push(`docs.import.imageAttachmentsMigrated:${migration.count}`)
  }

  let result: Awaited<ReturnType<typeof editDocBody>>
  try {
    const strippedAttachmentIds = await stripForeignAttachmentIds(doc.content, guard.meta.doc_id)
    if (strippedAttachmentIds > 0) {
      warnings.push(`docs.import.foreignImageAttachmentsSkipped:${strippedAttachmentIds}`)
    }

    const { pmDoc, baseSV } = await readLiveForEdit(guard.meta.document_name)
    const op: DocEditOp =
      pmDoc.childCount === 0
        ? { type: 'insert', at: { path: [], position: 'inside_end' }, content: doc.content }
        : {
            type: 'replace',
            range: { from: { path: [0] }, to: { path: [pmDoc.childCount - 1] } },
            content: doc.content,
          }
    result = await editDocBody({
      uid: req.uid!,
      docId: guard.meta.doc_id,
      documentName: guard.meta.document_name,
      clientBaseVersion: baseSV,
      ops: [op],
      authorizedEpoch: guard.meta.permission_epoch,
      isBot: req.botToken !== undefined,
      token: req.octoToken,
    })
  } catch (err) {
    await Promise.allSettled(migration.createdAttachIds.map((attachId) => cleanupCopiedAttachment(attachId)))
    throw err
  }
  if (!result.ok) {
    await Promise.allSettled(
      [...migration.createdAttachIds, ...requestCreatedAttachIds].map((attachId) => cleanupCopiedAttachment(attachId)),
    )
    res.status(result.status).json({ error: result.error })
    return
  }
  res.status(200).json({
    docId: guard.meta.doc_id,
    bytes: result.bytes,
    baseVersion: result.baseVersion,
    newDocVersionSeq: result.newDocVersionSeq,
    warnings,
  })
}

/**
 * Re-host references produced by our Markdown exporter before the PM document is
 * written. Attachment ids are document-scoped, so retaining a source id (or only
 * its expiring signed URL) is never a valid cross-document import. The source
 * document and attachment are both verified authoritatively and the caller must
 * be able to read the source; failures remain best-effort and are stripped by the
 * validation pass below. No signed URL is fetched and no URL credentials are
 * copied into the new attachment identity.
 */
async function migrateImportedAttachments(
  content: unknown[],
  targetDocId: string,
  uid: string,
  spaceId: string,
): Promise<{ count: number; createdAttachIds: string[] }> {
  let migrated = 0
  const createdAttachIds: string[] = []
  const sourceCache = new Map<string, Awaited<ReturnType<typeof docAttachmentRepo.getById>> | null>()
  const copiedCache = new Map<string, string>()

  const visit = async (value: unknown): Promise<void> => {
    if (!value || typeof value !== 'object') return
    const node = value as { type?: unknown; attrs?: Record<string, unknown>; content?: unknown }
    if ((node.type === 'image' || node.type === 'fileAttachment') && node.attrs) {
      const src = typeof node.attrs.src === 'string' ? node.attrs.src : ''
      const ref = parseExportedAttachmentRef(src)
      if (ref && ref.docId !== targetDocId) {
        // A recognized exported URL is a source-document capability, never a
        // valid target-document fallback. Strip it before any fallible lookup
        // or copy so denied access and storage failures cannot persist it.
        delete node.attrs.src
        const key = `${ref.docId}\u0000${ref.attachId}`
        const copied = copiedCache.get(key)
        if (copied) {
          node.attrs.attachId = copied
          delete node.attrs.src
          migrated += 1
          return
        }
        let source = sourceCache.get(key)
        if (source === undefined) {
          source = null
          const meta = await docMetaRepo.getByDocId(ref.docId)
          if (meta && meta.status !== 0 && meta.space_id === spaceId) {
            const role = await resolveRole(uid, ref.docId)
            if (roleAtLeast(role, 'reader')) {
              const attachment = await docAttachmentRepo.getById(ref.attachId)
              if (attachment?.docId === ref.docId) source = attachment
            }
          }
          sourceCache.set(key, source)
        }
        if (source) {
          try {
            const attachId = await copyStoredObject(source, targetDocId, uid)
            copiedCache.set(key, attachId)
            createdAttachIds.push(attachId)
            node.attrs.attachId = attachId
            // The editor resolves a fresh target-doc URL from attachId. Do not
            // persist the source document's signed URL as a fallback identity.
            delete node.attrs.src
            migrated += 1
          } catch {
            // Best effort: stripForeignAttachmentIds below removes the foreign id.
          }
        }
      }
    }
    if (Array.isArray(node.content)) for (const child of node.content) await visit(child)
  }
  try {
    for (const node of content) await visit(node)
    return { count: migrated, createdAttachIds }
  } catch (err) {
    await Promise.allSettled(createdAttachIds.map((attachId) => cleanupCopiedAttachment(attachId)))
    throw err
  }
}

function parseExportedAttachmentRef(src: string): { docId: string; attachId: string } | null {
  if (!/^https?:\/\//i.test(src)) return null
  try {
    const url = new URL(src)
    const marker = /^octo-attachment:([^:]+):(att_[A-Za-z0-9]+)$/.exec(
      decodeURIComponent(url.hash.slice(1)),
    )
    if (marker) return { docId: marker[1]!, attachId: marker[2]! }
    const path = /\/file\/([^/]+)\/(att_[A-Za-z0-9]+)(?:\/|$)/.exec(url.pathname)
    return path ? { docId: decodeURIComponent(path[1]!), attachId: path[2]! } : null
  } catch {
    return null
  }
}

async function stripForeignAttachmentIds(content: unknown[], targetDocId: string): Promise<number> {
  let stripped = 0
  const cache = new Map<string, boolean>()

  const visit = async (value: unknown): Promise<void> => {
    if (!value || typeof value !== 'object') return
    const node = value as { type?: unknown; attrs?: Record<string, unknown>; content?: unknown }
    if ((node.type === 'image' || node.type === 'fileAttachment') && node.attrs && typeof node.attrs.attachId === 'string') {
      const attachId = node.attrs.attachId
      let valid = cache.get(attachId)
      if (valid === undefined) {
        const attachment = await docAttachmentRepo.getById(attachId)
        valid = attachment?.docId === targetDocId
        cache.set(attachId, valid)
      }
      if (!valid) {
        delete node.attrs.attachId
        stripped += 1
      }
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) await visit(child)
    }
  }

  for (const node of content) await visit(node)
  return stripped
}

/** MIME the browser sends for a .docx; octet-stream is accepted as a fallback. */
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/**
 * Hard ceiling on the uploaded request body. The zip extractor enforces its own
 * (matching) upload + inflate/entry-count bomb protection downstream; this is the
 * outer transport bound so an oversized upload is rejected before it is buffered.
 * Sourced from the same config as the extractor so the two never drift.
 */
const MAX_UPLOAD_BYTES = config.docxImport.maxUploadBytes

/**
 * Reduce a client-supplied file name to a safe single path segment: strip any
 * directory components and reject '..' traversal so the object key can never
 * escape the `${docId}/${attachId}/` prefix. Mirrors attachments.ts.
 */
function sanitizeFileName(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? ''
  const cleaned = base.replace(/^\.+/, '').trim()
  return cleaned === '' ? 'file' : cleaned
}

/**
 * express.raw scoped to this route: accept the two content-types a .docx upload
 * can arrive as, buffer up to the hard cap, and reject anything larger with the
 * body-parser's own 413 (mapped by the central error handler).
 */
const rawDocxBody = express.raw({
  type: [DOCX_MIME, 'application/octet-stream'],
  limit: MAX_UPLOAD_BYTES,
})

importRouter.post('/:docId/import/docx', rawDocxBody, importDocxHandler)

export async function importDocxHandler(req: Request, res: Response): Promise<void> {
  // Reject a tampered array/non-string param up front (type confusion through
  // parameter tampering), then hand the raw params straight to requireDocRole
  // exactly as every other doc route does — the guard validates them and
  // returns the authoritative doc id from the DB for all downstream use.
  if (typeof req.params.docId !== 'string' || req.params.docId.length === 0) {
    res.status(400).json({ error: 'invalid_doc_id' })
    return
  }
  if (typeof req.uid !== 'string' || typeof req.spaceId !== 'string') {
    res.status(400).json({ error: 'invalid_request' })
    return
  }

  // Import WRITES content into the doc → writer role, never reader. Default-deny.
  const guard = await requireDocRole(res, req.uid, req.params.docId, req.spaceId, 'writer', {
    isBot: req.botToken !== undefined,
    token: req.octoToken,
  })
  if (!guard) return
  // Reject the target type before parsing: DOCX parsing can persist embedded
  // media, so a non-document target must never reach the upload context.
  if (guard.meta.doc_type !== 'doc') {
    res.status(409).json({ error: 'unsupported_doc_type' })
    return
  }
  const uid = req.uid
  // express.raw yields a Buffer only when the content-type matched; anything
  // else (wrong/absent content-type, or a tampered body) leaves req.body as {}
  // or some other shape. Explicitly reject an array body first (CodeQL's
  // type-confusion barrier is an Array.isArray check), then require a real
  // Buffer before any length/size access so a non-Buffer body can never reach
  // the length checks.
  const rawBody: unknown = req.body
  if (Array.isArray(rawBody) || !Buffer.isBuffer(rawBody)) {
    res.status(400).json({ error: 'invalid_body' })
    return
  }
  const buffer: Buffer = rawBody
  const bufferLength: number = buffer.length
  if (bufferLength === 0) {
    res.status(400).json({ error: 'empty_upload' })
    return
  }
  // Defence-in-depth size cap. express.raw already rejects bodies over its
  // `limit`, but only fires when the content-type matched and the raw parser
  // actually ran; this explicit re-check guarantees an oversized buffer is
  // rejected here regardless of how it was buffered, using the same
  // MAX_UPLOAD_BYTES source so the two bounds never drift.
  if (bufferLength > MAX_UPLOAD_BYTES) {
    res.status(413).json({ error: 'doc_too_large' })
    return
  }

  // requireDocRole validated the param and returns the authoritative doc id
  // from the DB. Use THIS value — not the raw request param — for the object
  // key and all logging, so no user-controlled string flows into the store key
  // or a log format string (CodeQL: log-injection / externally-controlled
  // format string). It is a definite string sourced from trusted metadata.
  const docId = guard.meta.doc_id

  // Admission control: the parse/convert phase below is a synchronous,
  // CPU-heavy walk that holds an inflated document in memory. Bound how many
  // run at once — acquire a slot (queue if all busy) or shed load with 503 so
  // a burst of uploads cannot pin the event loop. Mirrors the pdfExport gate.
  try {
    await acquireDocxImportSlot()
  } catch (err) {
    if (err instanceof DocxImportBusyError) {
      // eslint-disable-next-line no-console
      console.warn('[import:docx] queue full for doc %s', docId)
      res.status(503).json({ error: 'import_busy' })
      return
    }
    throw err
  }

  // MediaUploadCtx mirrors the attachments presign+register flow so embedded
  // images land in the same store/table as a normal upload. Failures degrade
  // in the parser (fileAttachment node) rather than throwing here.
  // Each PUT carries an AbortSignal so a wedged object store can't pin the
  // docx-import concurrency slot indefinitely (§DOCX_TIMEOUT).
  const requestCreatedAttachIds: string[] = []
  const uploadCtx: MediaUploadCtx = {
    docId,
    uid,
    maxImageBytes: config.attachments.maxImageSizeBytes,
    upload: async ({ bytes, mime, fileName }) => {
      const attachId = newAttachId()
      const safeName = sanitizeFileName(fileName)
      const objectKey = `${docId}/${attachId}/${safeName}`
      const signal = AbortSignal.timeout(config.docxImport.timeoutMs)
      await getObjectStore().upload(objectKey, mime, new Uint8Array(bytes), { signal })
      try {
        await docAttachmentRepo.register({
          attachId,
          docId,
          objectKey,
          mime,
          sizeBytes: bytes.length,
          fileName: safeName,
          createdBy: uid,
        })
      } catch (err) {
        await getObjectStore().delete(objectKey).catch(() => {})
        throw err
      }
      requestCreatedAttachIds.push(attachId)
      return attachId
    },
  }

  const applyMode = shouldApplyImport(req)
  try {
    const { doc, warnings } = await importDocxWithMedia(buffer, uploadCtx)
    if (applyMode) {
      await applyImportedDoc(req, res, guard, doc, warnings, requestCreatedAttachIds)
    } else {
      res.status(200).json({ doc, warnings })
    }
  } catch (err) {
    if (applyMode) {
      await Promise.allSettled(requestCreatedAttachIds.map((attachId) => cleanupCopiedAttachment(attachId)))
    }
    // A DocxUnsafeError means the extractor hit a hard safety bound (zip bomb,
    // oversize, too many entries, timeout, or malformed zip). It carries a
    // machine-readable `reason`; map it to a precise status so the client can
    // tell "this file is too big/complex" (413) from "this isn't a valid docx"
    // (400) instead of a generic parse failure. The message/path is never
    // leaked — only the stable error code + reason.
    if (err instanceof DocxUnsafeError) {
      // eslint-disable-next-line no-console
      console.warn('[import:docx] unsafe upload for doc %s: %s', docId, err.reason)
      const status =
        err.reason === 'not-a-zip' || err.reason === 'corrupt' || err.reason === 'timeout'
          ? 400
          : 413 // total/entry-too-large, ratio-too-high, too-many-entries, too-many-media
      res.status(status).json({ error: 'import_unsafe', reason: err.reason })
      return
    }
    // Malformed / unreadable OOXML beyond the zip layer lands here. Log
    // server-side without leaking any path or stack to the client; the parser
    // treats the whole file as untrusted, so a failure is the document's fault
    // (422), not ours.
    // eslint-disable-next-line no-console
    console.error('[import:docx] parse failed for doc %s:', docId, err)
    res.status(422).json({ error: 'import_failed' })
  } finally {
    // Always hand the slot back, whether the import succeeded, failed, or the
    // parse deadline tripped — otherwise the queue leaks capacity permanently.
    releaseDocxImportSlot()
  }
}

/**
 * Hard ceiling on an uploaded Markdown request body. Markdown is plain text and
 * much smaller than a .docx zip; reuse the docx cap until a markdown-specific
 * config field exists so the two bounds can be tuned independently.
 */
const MAX_MD_UPLOAD_BYTES = config.docxImport.maxUploadBytes

/**
 * express.raw scoped to the markdown route: accept text/markdown, text/plain,
 * and application/octet-stream (fallback for clients that cannot set a precise
 * MIME). Buffer up to the hard cap; oversize bodies are rejected with 413.
 */
const rawMarkdownBody = express.raw({
  type: ['text/markdown', 'text/plain', 'application/octet-stream'],
  limit: MAX_MD_UPLOAD_BYTES,
})

importRouter.post('/:docId/import/markdown', rawMarkdownBody, importMarkdownHandler)

export async function importMarkdownHandler(req: Request, res: Response): Promise<void> {
  if (typeof req.params.docId !== 'string' || req.params.docId.length === 0) {
    res.status(400).json({ error: 'invalid_doc_id' })
    return
  }
  if (typeof req.uid !== 'string' || typeof req.spaceId !== 'string') {
    res.status(400).json({ error: 'invalid_request' })
    return
  }

  // Import WRITES content into the doc → writer role, never reader. Default-deny.
  const guard = await requireDocRole(res, req.uid, req.params.docId, req.spaceId, 'writer', {
    isBot: req.botToken !== undefined,
    token: req.octoToken,
  })
  if (!guard) return

  const rawBody: unknown = req.body
  if (Array.isArray(rawBody) || !Buffer.isBuffer(rawBody)) {
    res.status(400).json({ error: 'invalid_body' })
    return
  }
  const buffer: Buffer = rawBody
  const bufferLength: number = buffer.length
  if (bufferLength === 0) {
    res.status(400).json({ error: 'empty_upload' })
    return
  }
  if (bufferLength > MAX_MD_UPLOAD_BYTES) {
    res.status(413).json({ error: 'doc_too_large' })
    return
  }

  // Authoritative doc id from the guard, not the raw request param.
  const docId = guard.meta.doc_id

  let text: string
  try {
    // Buffer.toString() silently replaces malformed byte sequences with U+FFFD. Reject them instead
    // so web and CLI callers get deterministic UTF-8 semantics from the authoritative importer.
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    res.status(400).json({ error: 'invalid_utf8' })
    return
  }

  let result
  try {
    result = parseMarkdownToPmDoc(text, { emojiName: resolveGitHubEmoji })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[import:markdown] parse failed for doc %s:', docId, err)
    res.status(422).json({ error: 'import_failed' })
    return
  }

  const { doc, warnings } = result
  if (shouldApplyImport(req)) {
    await applyImportedDoc(req, res, guard, doc, warnings)
  } else {
    res.status(200).json({ doc, warnings })
  }
}

/**
 * Hard ceiling on an uploaded .xlsx body. Reuses the docx upload cap so the two transport
 * bounds never drift; a workbook and a Word document share the same reasonable upload size.
 */
const MAX_XLSX_UPLOAD_BYTES = config.docxImport.maxUploadBytes

/** MIME the browser sends for an .xlsx; octet-stream is accepted as a fallback. */
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/**
 * express.raw scoped to the xlsx route: accept the content-types an .xlsx upload can arrive
 * as, buffer up to the hard cap, and reject anything larger with the body-parser's 413.
 */
const rawXlsxBody = express.raw({
  type: [XLSX_MIME, 'application/octet-stream'],
  limit: MAX_XLSX_UPLOAD_BYTES,
})

importRouter.post('/:docId/import/xlsx', rawXlsxBody, importXlsxHandler)

/**
 * Server-side .xlsx import: parse an uploaded workbook into cells and write them into the
 * target SHEET doc. Unlike the docx/markdown routes (which return a ProseMirror doc for the
 * caller to apply), a sheet is edited in place through the same optimistic-concurrency path
 * the collaborative editor and CLI use: read the live sheet for its base version, then submit
 * the parsed cells via editDocSheet under that version.
 */
export async function importXlsxHandler(req: Request, res: Response): Promise<void> {
  if (typeof req.params.docId !== 'string' || req.params.docId.length === 0) {
    res.status(400).json({ error: 'invalid_doc_id' })
    return
  }
  if (typeof req.uid !== 'string' || typeof req.spaceId !== 'string') {
    res.status(400).json({ error: 'invalid_request' })
    return
  }

  // Import WRITES content into the doc -> writer role, never reader. Default-deny. The bot /
  // human membership context is threaded through exactly as the docSheet write route does.
  const guard = await requireDocRole(res, req.uid, req.params.docId, req.spaceId, 'writer', {
    isBot: req.botToken !== undefined,
    token: req.octoToken,
  })
  if (!guard) return

  // Only a sheet doc can receive a workbook import; a doc/board target is a 409.
  if (guard.meta.doc_type !== 'sheet') {
    res.status(409).json({ error: 'unsupported_doc_type' })
    return
  }

  const rawBody: unknown = req.body
  if (Array.isArray(rawBody) || !Buffer.isBuffer(rawBody)) {
    res.status(400).json({ error: 'invalid_body' })
    return
  }
  const buffer: Buffer = rawBody
  const bufferLength: number = buffer.length
  if (bufferLength === 0) {
    res.status(400).json({ error: 'empty_upload' })
    return
  }
  if (bufferLength > MAX_XLSX_UPLOAD_BYTES) {
    res.status(413).json({ error: 'doc_too_large' })
    return
  }

  // Authoritative doc id / name from the guard, not the raw request param.
  const docId = guard.meta.doc_id

  // Parse the workbook into the intermediate structure, then map it onto a SheetCell batch.
  let importedCells: Record<string, SheetCell>
  let importedDims: Record<string, number>
  let importedDrawings: Record<string, StoredDrawing>
  let importedHyperlinks: Record<string, StoredHyperLink>
  let importedSheetName: string | undefined
  let importWarnings: string[]
  try {
    const workbook = await parseXlsx(buffer)
    importedSheetName = workbook.sheets[0]?.name
    const batch = xlsxWorkbookToSheetBatch(workbook)
    importedCells = batch.cells
    importedDims = batch.dims
    importedDrawings = batch.drawings
    importedHyperlinks = batch.hyperlinks
    importWarnings = batch.warnings
  } catch (err) {
    if (err instanceof XlsxParseError) {
      // eslint-disable-next-line no-console
      console.warn('[import:xlsx] unreadable/empty upload for doc %s: %s', docId, err.reason)
      // empty workbook or unreadable bytes are both the document's fault, not ours.
      res
        .status(err.reason === 'unsafe' ? 413 : err.reason === 'empty' ? 400 : 422)
        .json({ error: err.reason === 'unsafe' ? 'import_unsafe' : 'import_failed', reason: err.reason })
      return
    }
    // eslint-disable-next-line no-console
    console.error('[import:xlsx] parse failed for doc %s:', docId, err)
    res.status(422).json({ error: 'import_failed' })
    return
  }

  // Read the live sheet to obtain the current base version, then write the parsed cells under
  // it through the same optimistic-concurrency path the editor / CLI use. A concurrent edit
  // surfaces as editDocSheet's version conflict, mapped straight to the caller.
  try {
    const { state, baseSV } = await readLiveSheet(guard.meta.document_name)
    // Import replaces the sheet rather than merging into it: delete every existing cell first,
    // then overlay the parsed workbook cells in the same atomic editDocSheet transaction.
    const existingCells = decodeSheetSnapshot(state)
    const existingDims = decodeSheetDimsSnapshot(state)
    const existingDrawings = decodeSheetDrawingsSnapshot(state)
    const existingHyperlinks = decodeSheetHyperLinksSnapshot(state)
    const existingMerges = decodeSheetMergesSnapshot(state)
    const existingSheets = decodeSheetListSnapshot(state)
    const cells: Record<string, SheetCell | null> = {}
    for (const key of Object.keys(existingCells)) cells[key] = null
    Object.assign(cells, importedCells)
    const dims: Record<string, number | null> = {}
    for (const key of Object.keys(existingDims)) dims[key] = null
    Object.assign(dims, importedDims)
    const drawings: Record<string, StoredDrawing | null> = {}
    for (const key of Object.keys(existingDrawings)) drawings[key] = null
    Object.assign(drawings, importedDrawings)
    const hyperlinks: Record<string, StoredHyperLink | null> = {}
    for (const key of Object.keys(existingHyperlinks)) hyperlinks[key] = null
    Object.assign(hyperlinks, importedHyperlinks)
    const merges: Record<string, boolean | null> = {}
    for (const key of Object.keys(existingMerges)) merges[key] = null
    const sheets: Record<string, StoredSheetMeta | null> = {}
    for (const key of Object.keys(existingSheets)) sheets[key] = null
    sheets.default = { name: importedSheetName?.trim() || 'Sheet1', order: 0 }
    const result = await editDocSheet({
      uid: req.uid,
      docId,
      documentName: guard.meta.document_name,
      clientBaseVersion: baseSV,
      cells,
      dims,
      drawings,
      hyperlinks,
      merges,
      sheets,
      authorizedEpoch: guard.meta.permission_epoch,
      isBot: req.botToken !== undefined,
      token: req.octoToken,
    })
    if (!result.ok) {
      const errBody: Record<string, unknown> = { error: result.error }
      if (result.payloadBytes !== undefined) errBody.payloadBytes = result.payloadBytes
      if (result.docBytes !== undefined) errBody.docBytes = result.docBytes
      if (result.limit !== undefined) errBody.limit = result.limit
      res.status(result.status).json(errBody)
      return
    }
    res.status(200).json({ baseVersion: result.baseVersion, warnings: importWarnings })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[import:xlsx] write failed for doc %s:', docId, err)
    res.status(500).json({ error: 'internal_error' })
  }
}
