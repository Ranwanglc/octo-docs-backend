/**
 * Server-side PDF export via Typst.
 *
 *   POST /:docId/export/pdf   reader — render the doc's persisted state to PDF
 *                              using the standalone `typst` binary.
 *
 * The document's authoritative persisted Y.Doc is converted to ProseMirror JSON,
 * rendered to Typst source (renderTypst.ts) and compiled to a PDF by a
 * short-lived sandboxed `typst` child process (typstService.ts). Unlike a
 * headless-browser renderer there is no resident process and no network access
 * at compile time, so image bytes are pre-downloaded (size-bounded) into the
 * compile root.
 * (renderTypst) -> `typst compile` (typstService) instead of HTML -> headless
 * Chrome. It exists so we can A/B the two backends on real documents (fidelity,
 * speed, memory) before choosing one.
 *
 * Images: Typst compiles OFFLINE (no network), so unlike the browser path we
 * cannot hand it signed URLs to fetch at render time. We pre-download each
 * image attachment's bytes here (size-bounded) and place them in the compile
 * root for `image()` to read. When a store driver serves attachments from a
 * non-fetchable synthetic host (the local-hmac dev driver's
 * `*.object-store.local`), the download is skipped and the image node is dropped
 * — exactly how the HTML path treats an unresolved attachment. In prod (S3/MinIO)
 * the signed GET URL is a real endpoint and the bytes embed normally.
 */
import { Router, type Router as ExpressRouter, type Request, type Response } from 'express'
import { requireDocRole } from '../guard.js'
import { readLiveDocState } from '../../collab/liveDocRead.js'
import { readLiveSheet } from '../../collab/liveSheetWrite.js'
import { yDocStateToProsemirrorJSON } from '../../agent/conversion.js'
import { decodeSheetSnapshot, decodeSheetDimsSnapshot, decodeSheetDrawingsSnapshot, decodeSheetHyperLinksSnapshot, decodeSheetListSnapshot } from '../../collab/versionRestore.js'
import { SheetSnapshotInvalidError, type SheetCell, type StoredSheetMeta } from '../../agent/sheetConversion.js'
import { exportMarkdown, type PmNode } from '../../export/markdown.js'
import { exportDocx, type DocxImage } from '../../export/docx.js'
import { readIntrinsicSize } from '../../export/serialization/docx/images.js'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { exportXlsx } from '../../export/xlsx.js'
import { docAttachmentRepo } from '../../db/repos/docAttachmentRepo.js'
import { getObjectStore } from '../../storage/objectStore.js'
import { presignAttachmentReadUrl } from './attachments.js'
import { config } from '../../config/env.js'
import { InvalidSvgError, sanitizeSvg } from '../../util/sanitizeSvg.js'
import { renderTypst, type ResolvedAttachment } from '../../export/renderTypst.js'
import {
  compileTypst,
  acquireSlot,
  releaseSlot,
  TypstQueueFullError,
  TypstTimeoutError,
  TypstCompileError,
  type TypstImageInput,
} from '../../export/typstService.js'

export const exportRouter: ExpressRouter = Router()

const EMPTY_DOC = { type: 'doc', content: [] }

/**
 * Derive the compile-root file extension from the image's ACTUAL magic bytes,
 * not its declared mime. Uploads can be mislabeled (e.g. a JPEG saved as
 * `111.png` and stored with mime image/png). typst picks its decoder from the
 * file extension, so a `.png` name over JPEG bytes fails with "Invalid PNG
 * signature" and aborts the whole compile. Naming the file by the sniffed
 * format lets typst decode it correctly. Returns null for bytes we don't
 * recognise (caller drops the image). Kept in sync with isSupportedImage.
 */
export function sniffImageExt(buf: Buffer): 'png' | 'jpg' | 'gif' | 'svg' | null {
  if (buf.length < 4) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif'
  // SVG has no binary magic. Only classify a UTF-8 XML document whose first
  // element is <svg>; prepareTypstImage still parses and sanitizes it before it
  // can reach the compile root. Do not infer SVG from the declared MIME alone.
  const head = buf.subarray(0, Math.min(buf.length, 4096)).toString('utf8')
    .replace(/^\uFEFF/, '')
    .replace(/^\s*<\?xml[^>]*>\s*/i, '')
    .replace(/^\s*<!--(?:[\s\S]*?)-->\s*/i, '')
  if (/^\s*<svg(?:\s|>)/i.test(head)) return 'svg'
  return null
}

/**
 * Turn downloaded bytes into a safe Typst image input. Raster formats are
 * accepted by magic bytes. SVG is parsed and sanitized again at export time
 * (including legacy/imported objects which may predate the sanitized SVG
 * upload route), and the sanitized XML is written with a truthful `.svg`
 * extension. Typst 0.13.1 supports SVG natively, so no lossy raster step is
 * needed and SVG bytes are never disguised as PNG.
 */
export function prepareTypstImage(buf: Buffer): { ext: 'png' | 'jpg' | 'gif' | 'svg'; bytes: Buffer } | null {
  const ext = sniffImageExt(buf)
  if (!ext) return null
  if (ext !== 'svg') return { ext, bytes: buf }
  try {
    return { ext, bytes: sanitizeSvg(buf) }
  } catch (err) {
    if (err instanceof InvalidSvgError) return null
    throw err
  }
}

/**
 * Resolve every attachment to metadata, and attempt to download the bytes of
 * IMAGE attachments so Typst can embed them. Returns the attachment metadata map
 * (for the renderer), the attachId->local-filename map (for image() paths), and
 * the concrete image inputs (bytes) to place in the compile root.
 *
 * Non-image attachments are metadata-only (file cards render as text). Image
 * downloads are size-bounded and best-effort: a fetch failure (e.g. the dev
 * synthetic host) just drops that image, never fails the whole export.
 */
async function resolveInputs(
  docId: string,
  referencedIds: ReadonlySet<string>,
): Promise<{
  attachments: Map<string, ResolvedAttachment>
  imagePaths: Map<string, string>
  images: TypstImageInput[]
}> {
  const store = getObjectStore()
  const ttl = config.attachments.readUrlTtlSeconds
  const attachments = new Map<string, ResolvedAttachment>()
  const imagePaths = new Map<string, string>()
  const images: TypstImageInput[] = []

  const { maxImageBytes, maxImageCount, maxImageTotalBytes } = config.typstExport
  const list = await docAttachmentRepo.listByDoc(docId)
  let imgIdx = 0
  let attempts = 0
  let totalBytes = 0
  for (const a of list) {
    const url = store.presignGet(a.objectKey, ttl)
    attachments.set(a.attachId, { url, fileName: a.fileName, mime: a.mime, sizeBytes: a.sizeBytes })
    if (!a.mime.startsWith('image/')) continue
    // Only embed images the document actually references — never prefetch the
    // full attachment list (a doc can carry orphaned/unreferenced uploads).
    if (!referencedIds.has(a.attachId)) continue
    // Count bound: cap the number of download ATTEMPTS (not just successful
    // embeds) so a doc referencing many failing images can't force more than
    // maxImageCount downloads, each up to the per-image abort timeout.
    if (attempts >= maxImageCount) break
    attempts++
    // Skip anything whose declared size alone would blow the aggregate budget,
    // before spending a download on it.
    if (typeof a.sizeBytes === 'number' && a.sizeBytes > 0 && totalBytes + a.sizeBytes > maxImageTotalBytes) {
      continue
    }
    const bytes = await tryDownload(url, maxImageBytes)
    if (!bytes) continue // unfetchable host or oversize/failed — drop the image
    // Defensive: a corrupt or mislabeled (renamed non-image) object would abort
    // the WHOLE typst compile with a decode error. Sniff the magic bytes and
    // drop anything that isn't a real image, matching the best-effort intent
    // (a bad image is skipped, not fatal).
    const prepared = prepareTypstImage(bytes)
    if (!prepared) continue
    // Re-check both budgets after SVG sanitation, which can change byte length.
    // A lying/absent sizeBytes cannot smuggle past either cap.
    if (prepared.bytes.byteLength > maxImageBytes) continue
    if (totalBytes + prepared.bytes.byteLength > maxImageTotalBytes) continue
    totalBytes += prepared.bytes.byteLength
    const fileName = `img_${imgIdx++}.${prepared.ext}`
    imagePaths.set(a.attachId, fileName)
    images.push({ fileName, bytes: prepared.bytes })
  }
  return { attachments, imagePaths, images }
}

/**
 * Sniff the leading magic bytes to confirm a buffer is an image format the
 * pinned typst engine (v0.13.1) can actually decode: PNG, JPEG, GIF, or SVG.
 * (SVG is accepted only after prepareTypstImage sanitizes it; Typst does
 * NOT decode WebP or BMP — those raise `unknown image format` and would abort
 * the whole compile, which is exactly what this guard exists to prevent.)
 * Guards against a corrupt, renamed, or undecodable attachment sinking the
 * entire export; a rejected image is dropped like any other unresolved image.
 */
export function isSupportedImage(buf: Buffer): boolean {
  // Delegate to sniffImageExt so the accepted-format list and the extension
  // used for the compile-root filename can never drift apart. typst v0.13.1
  // decodes PNG/JPEG/GIF/SVG; WebP and BMP are intentionally rejected (they would
  // fail the whole compile). Revisit if TYPST_VERSION is bumped.
  return prepareTypstImage(buf) !== null
}

/**
 * Collect the attachIds actually referenced by `image` nodes in the ProseMirror
 * document, so the export only downloads images the doc embeds — not every
 * attachment ever uploaded to it. Bounded DFS (shares the renderer's intent).
 */
export function collectReferencedAttachIds(pmJson: unknown): Set<string> {
  const ids = new Set<string>()
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as { type?: unknown; attrs?: unknown; content?: unknown }
    if (n.type === 'image' && n.attrs && typeof n.attrs === 'object') {
      const id = (n.attrs as { attachId?: unknown }).attachId
      if (typeof id === 'string' && id) ids.add(id)
    }
    if (Array.isArray(n.content)) for (const c of n.content) walk(c)
  }
  walk(pmJson)
  return ids
}

/**
 * Collect every unique raw `latex` string from inlineMath/blockMath nodes.
 * Used by the per-formula fallback: after a whole-document compile failure we
 * probe each unique formula in isolation to find the one(s) that actually break
 * Typst, so only those degrade to verbatim source and the rest stay real math.
 */
export function collectFormulaLatex(pmJson: unknown): string[] {
  const set = new Set<string>()
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as { type?: unknown; attrs?: unknown; content?: unknown }
    if ((n.type === 'inlineMath' || n.type === 'blockMath') && n.attrs && typeof n.attrs === 'object') {
      const latex = (n.attrs as { latex?: unknown }).latex
      if (typeof latex === 'string' && latex) set.add(latex)
    }
    if (Array.isArray(n.content)) for (const c of n.content) walk(c)
  }
  walk(pmJson)
  return [...set]
}

/**
 * Attribute formula compile failures with batched divide-and-conquer probes.
 * A successful batch clears every formula in it at once; only a failing batch
 * is split, until a failing singleton can be marked verbatim. For a document
 * with many valid formulas and a few bad ones this takes O(k log n) compiles,
 * rather than one compile per formula.
 *
 * Bounded to protect the scarce compile pool: at most `maxProbes` batch
 * compiles run and probing stops once `budgetMs` of wall-clock is spent. Any
 * still-unresolved formulas are conservatively marked verbatim. This is vital:
 * exhausting the attribution budget must not turn formulas already proven
 * valid into raw LaTeX. The caller can still compile the partially degraded
 * document once and use the whole-document safety net only if that retry fails.
 */
export async function probeFailingFormulas(
  latexList: string[],
  title: string,
  opts: { maxProbes: number; budgetMs: number },
): Promise<{ failing: Set<string>; exhausted: boolean }> {
  const failing = new Set<string>()
  const deadline = Date.now() + Math.max(0, opts.budgetMs)
  const limit = Math.max(0, opts.maxProbes)
  if (latexList.length === 0) return { failing, exhausted: false }

  const pending: string[][] = [latexList]
  let probes = 0
  while (pending.length > 0) {
    if (probes >= limit || Date.now() >= deadline) {
      for (const group of pending) for (const latex of group) failing.add(latex)
      return { failing, exhausted: true }
    }
    const group = pending.pop()!
    probes++
    const probeDoc = {
      type: 'doc',
      content: group.map((latex) => ({ type: 'blockMath', attrs: { latex } })),
    }
    try {
      const src = renderTypst(probeDoc, { title, attachments: new Map(), imagePaths: new Map() })
      await compileTypst(src, [])
    } catch (e) {
      if (!(e instanceof TypstCompileError)) {
        // We cannot attribute infrastructure failures. Conservatively degrade
        // this and every pending group, preserving any batches already proven.
        for (const latex of group) failing.add(latex)
        for (const rest of pending) for (const latex of rest) failing.add(latex)
        return { failing, exhausted: true }
      }
      if (group.length === 1) {
        failing.add(group[0]!)
      } else {
        const mid = Math.ceil(group.length / 2)
        pending.push(group.slice(mid), group.slice(0, mid))
      }
    }
  }
  return { failing, exhausted: false }
}

/**
 * Fetch up to maxBytes from a signed GET URL. Aborts and returns null on any
 * failure, non-200, or over-size body (streamed, so an oversize response can't
 * blow memory before the limit trips). A synthetic/dev host that isn't a real
 * endpoint simply throws and yields null.
 */
async function tryDownload(url: string, maxBytes: number): Promise<Buffer | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok || !res.body) return null
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel().catch(() => {})
          return null
        }
        chunks.push(value)
      }
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)))
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function contentDisposition(title: string, extension = 'pdf'): string {
  const base = title.trim() || '未命名文档'
  const encoded = encodeURIComponent(`${base}.${extension}`)
  const ascii = base.replace(/[^\x20-\x7E]/g, '').replace(/["\\\r\n]/g, '').trim() || 'document'
  return `attachment; filename="${ascii}.${extension}"; filename*=UTF-8''${encoded}`
}

exportRouter.post('/:docId/export/pdf', exportPdfHandler)
exportRouter.get('/:docId/export/file', exportFileHandler)

const FILE_FORMATS = new Set(['md', 'docx', 'pdf', 'xlsx'])

/** Unified binary export used by both the human and bot router mounts. */
export async function exportFileHandler(req: Request, res: Response): Promise<void> {
  const raw = Array.isArray(req.query.format) ? req.query.format[0] : req.query.format
  const format = typeof raw === 'string' ? raw.toLowerCase() : ''
  if (!FILE_FORMATS.has(format)) {
    res.status(400).json({ error: 'invalid_format' })
    return
  }
  // Keep the mature Typst path as the single PDF implementation (including its
  // queue and formula fallbacks). It performs the same reader guard below.
  if (format === 'pdf') {
    await exportPdfHandler(req, res)
    return
  }

  const guard = await requireDocRole(req, res, req.params.docId!, 'reader')
  if (!guard) return
  const expectedType = format === 'xlsx' ? 'sheet' : 'doc'
  if (guard.meta.doc_type !== expectedType) {
    res.status(409).json({ error: 'unsupported_doc_type' })
    return
  }

  try {
    let bytes: Buffer
    let mime: string
    if (format === 'xlsx') {
      const { state } = await readLiveSheet(guard.meta.document_name)
      const cells = decodeSheetSnapshot(state) as Record<string, SheetCell>
      const dims = decodeSheetDimsSnapshot(state)
      const drawings = decodeSheetDrawingsSnapshot(state)
      const hyperlinks = decodeSheetHyperLinksSnapshot(state)
      const sheets = decodeSheetListSnapshot(state) as Record<string, StoredSheetMeta>
      bytes = await exportXlsx(cells, guard.meta.title, { dims, drawings, hyperlinks, sheets })
      mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    } else {
      const state = await readLiveDocState(guard.meta.document_name)
      const doc = yDocStateToProsemirrorJSON(state) as PmNode
      if (format === 'md') {
        await hydrateAttachmentUrls(doc, guard.meta.doc_id)
        bytes = Buffer.from(exportMarkdown(doc), 'utf8')
        mime = 'text/markdown; charset=utf-8'
      } else {
        // DOCX fileAttachment blocks are hyperlinks rather than embedded media;
        // hydrate their signed download targets before the image-only adapter
        // resolves/fetches image bytes.
        await hydrateAttachmentUrls(doc, guard.meta.doc_id)
        const images = await resolveDocxImages(guard.meta.doc_id, collectReferencedAttachIds(doc))
        bytes = await exportDocx(doc, images)
        mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      }
    }
    res.status(200)
    res.setHeader('Content-Type', mime)
    res.setHeader('Content-Disposition', contentDisposition(guard.meta.title, format))
    res.setHeader('Content-Length', String(bytes.length))
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.end(bytes)
  } catch (err) {
    if (err instanceof SheetSnapshotInvalidError) {
      res.status(409).json({ error: 'sheet_snapshot_invalid' })
      return
    }
    // eslint-disable-next-line no-console
    console.error(`[export:file] export failed for doc ${guard.meta.doc_id}:`, err)
    res.status(500).json({ error: 'export_failed' })
  }
}

async function hydrateAttachmentUrls(doc: PmNode, docId: string): Promise<void> {
  const attachments = await docAttachmentRepo.listByDoc(docId)
  const byId = new Map(attachments.map((a) => [a.attachId, a]))
  const walk = (node: PmNode): void => {
    if ((node.type === 'image' || node.type === 'fileAttachment') && node.attrs) {
      const attachId = node.attrs.attachId
      if (typeof attachId === 'string') {
        const attachment = byId.get(attachId)
        if (attachment) {
          const signed = presignAttachmentReadUrl(attachment, config.attachments.readUrlTtlSeconds)
          // Preserve a non-secret, durable source identity independently of the
          // expiring signature. Importers authorize and copy this attachment;
          // the fragment is never sent to object storage and contains no token.
          node.attrs.src = `${signed}#${encodeURIComponent(`octo-attachment:${docId}:${attachId}`)}`
          if (node.type === 'fileAttachment' && !node.attrs.fileName) node.attrs.fileName = attachment.fileName
        }
      }
    }
    for (const child of node.content ?? []) walk(child)
  }
  walk(doc)
}

async function resolveDocxImages(
  docId: string,
  referencedIds: ReadonlySet<string>,
): Promise<Map<string, DocxImage>> {
  const images = new Map<string, DocxImage>()
  const attachments = await docAttachmentRepo.listByDoc(docId)
  const store = getObjectStore()
  let total = 0
  for (const attachment of attachments) {
    if (!referencedIds.has(attachment.attachId) || images.size >= config.typstExport.maxImageCount) continue
    if (attachment.sizeBytes > config.typstExport.maxImageBytes) continue
    const bytes = await tryDownload(
      store.presignGet(attachment.objectKey, config.attachments.readUrlTtlSeconds),
      config.typstExport.maxImageBytes,
    )
    if (!bytes || total + bytes.length > config.typstExport.maxImageTotalBytes) continue
    const type = sniffImageExt(bytes)
    if (!type) continue
    try {
      const data = type === 'svg' ? sanitizeSvg(bytes) : bytes
      const intrinsic = type === 'svg' ? readBoundedSvgDimensions(data) : readIntrinsicSize(toArrayBuffer(data))
      if (!intrinsic || !safeDocxSourceDimensions(intrinsic.width, intrinsic.height)) continue
      const image = await loadImage(data)
      let fallback: Buffer | undefined
      if (type === 'svg') {
        const scale = Math.min(1, 2048 / intrinsic.width, 2048 / intrinsic.height, Math.sqrt(4_000_000 / (intrinsic.width * intrinsic.height)))
        const fallbackWidth = Math.max(1, Math.round(intrinsic.width * scale))
        const fallbackHeight = Math.max(1, Math.round(intrinsic.height * scale))
        const canvas = createCanvas(fallbackWidth, fallbackHeight)
        canvas.getContext('2d').drawImage(image, 0, 0, fallbackWidth, fallbackHeight)
        fallback = canvas.toBuffer('image/png')
        if (fallback.length > config.typstExport.maxImageBytes || total + data.length + fallback.length > config.typstExport.maxImageTotalBytes) continue
      }
      images.set(attachment.attachId, {
        data,
        type,
        width: intrinsic.width,
        height: intrinsic.height,
        ...(fallback ? { fallback } : {}),
      })
      total += data.length + (fallback?.length ?? 0)
    } catch {
      // A corrupt image is omitted without sinking the whole document export.
    }
  }
  return images
}

const MAX_DOCX_IMAGE_DIMENSION = 16_384
const MAX_DOCX_IMAGE_PIXELS = 40_000_000

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export function safeDocxSourceDimensions(width: number, height: number): boolean {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 &&
    width <= MAX_DOCX_IMAGE_DIMENSION && height <= MAX_DOCX_IMAGE_DIMENSION &&
    width * height <= MAX_DOCX_IMAGE_PIXELS
}

/** Read bounded SVG geometry before loadImage/createCanvas can allocate from it. */
export function readBoundedSvgDimensions(svg: Buffer): { width: number; height: number } | undefined {
  const head = svg.subarray(0, Math.min(svg.length, 64 * 1024)).toString('utf8')
  const root = /<svg\b([^>]*)>/i.exec(head)?.[1]
  if (root == null) return undefined
  const numeric = (name: string): number | undefined => {
    const raw = new RegExp(`\\b${name}\\s*=\\s*["']\\s*([0-9]+(?:\\.[0-9]+)?)`, 'i').exec(root)?.[1]
    const value = raw == null ? undefined : Number(raw)
    return value != null && Number.isFinite(value) && value > 0 ? value : undefined
  }
  const width = numeric('width')
  const height = numeric('height')
  if (width && height) return { width, height }
  const viewBox = /\bviewBox\s*=\s*["']\s*[-+\d.eE]+[ ,]+[-+\d.eE]+[ ,]+([-+\d.eE]+)[ ,]+([-+\d.eE]+)/i.exec(root)
  const viewWidth = Number(viewBox?.[1])
  const viewHeight = Number(viewBox?.[2])
  return Number.isFinite(viewWidth) && viewWidth > 0 && Number.isFinite(viewHeight) && viewHeight > 0
    ? { width: width ?? viewWidth, height: height ?? viewHeight }
    : undefined
}

export async function exportPdfHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(req, res, req.params.docId!, 'reader')
  if (!guard) return
  if (guard.meta.doc_type !== 'doc') {
    res.status(409).json({ error: 'unsupported_doc_type' })
    return
  }

  // Gate the whole pipeline (prep + compile) behind the queue, matching the
  // Gate the whole pipeline (prep + compile) behind the queue so heavy prep
  // (Yjs fetch, image downloads) must not run
  // unbounded ahead of the compile limit.
  try {
    await acquireSlot()
  } catch (err) {
    if (err instanceof TypstQueueFullError) {
      // eslint-disable-next-line no-console
      console.warn(`[export:typst] queue full for doc ${req.params.docId}`)
      res.status(503).json({ error: 'export_busy' })
      return
    }
    throw err
  }

  const docId = guard.meta.doc_id
  try {
    // Read the live in-memory Y.Doc when active, hydrating from persistence when
    // inactive. This avoids exporting a debounced/stale persisted snapshot.
    const state = await readLiveDocState(guard.meta.document_name)
    const pmJson = state ? yDocStateToProsemirrorJSON(state) : EMPTY_DOC

    const referencedIds = collectReferencedAttachIds(pmJson)
    const { attachments, imagePaths, images } = await resolveInputs(docId, referencedIds)
    let pdf: Buffer
    try {
      const source = renderTypst(pmJson, { title: guard.meta.title, attachments, imagePaths })
      pdf = await compileTypst(source, images)
    } catch (compileErr) {
      // A single malformed formula can produce Typst-invalid math that fails the
      // whole compile (the per-formula JS-throw fallback can't catch a typst
      // non-zero exit). Isolate the culprit(s): probe each unique formula alone,
      // then re-render with ONLY the failing formulas verbatim so the rest of
      // the document still exports as real math. If that still fails (a
      // non-formula issue, or probing couldn't attribute it), fall back to the
      // whole-document verbatim retry as the final safety net.
      if (!(compileErr instanceof TypstCompileError)) throw compileErr
      // eslint-disable-next-line no-console
      console.warn(`[export:typst] compile failed for doc ${docId}; probing formulas for per-formula fallback`)
      const { failing: verbatimFormulas, exhausted } = await probeFailingFormulas(
        collectFormulaLatex(pmJson),
        guard.meta.title,
        { maxProbes: config.typstExport.maxFormulaProbes, budgetMs: config.typstExport.formulaProbeBudgetMs },
      )
      let partialPdf: Buffer | null = null
      if (verbatimFormulas.size > 0) {
        try {
          const partial = renderTypst(pmJson, {
            title: guard.meta.title,
            attachments,
            imagePaths,
            verbatimFormulas,
          })
          partialPdf = await compileTypst(partial, images)
          // eslint-disable-next-line no-console
          console.warn(`[export:typst] doc ${docId} recovered with ${verbatimFormulas.size} formula(s) verbatim${exhausted ? ' (probe budget exhausted)' : ''}`)
        } catch (partialErr) {
          if (!(partialErr instanceof TypstCompileError)) throw partialErr
        }
      }
      if (partialPdf) {
        pdf = partialPdf
      } else {
        // eslint-disable-next-line no-console
        console.warn(`[export:typst] doc ${docId} per-formula fallback insufficient; whole-document verbatim retry`)
        const fallback = renderTypst(pmJson, {
          title: guard.meta.title,
          attachments,
          imagePaths,
          mathMode: 'verbatim',
        })
        pdf = await compileTypst(fallback, images)
      }
    }

    res.status(200)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', contentDisposition(guard.meta.title))
    res.setHeader('Content-Length', String(pdf.length))
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.end(pdf)
  } catch (err) {
    if (err instanceof TypstTimeoutError) {
      // eslint-disable-next-line no-console
      console.error(`[export:typst] compile timed out for doc ${docId}`)
      res.status(504).json({ error: 'export_timeout' })
      return
    }
    if (err instanceof TypstCompileError) {
      // eslint-disable-next-line no-console
      console.error(`[export:typst] compile failed for doc ${docId}:`, err.message)
      res.status(500).json({ error: 'export_failed' })
      return
    }
    // eslint-disable-next-line no-console
    console.error(`[export:typst] export failed for doc ${docId}:`, err)
    res.status(500).json({ error: 'export_failed' })
  } finally {
    releaseSlot()
  }
}
