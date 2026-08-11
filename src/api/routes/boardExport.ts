/**
 * Server-side whiteboard image export (W3).
 *
 *   GET /:docId/export?format=png|svg   reader — render the board's LIVE scene
 *                                        to a PNG or SVG image.
 *
 * A board stores its scene as an Excalidraw element/file graph in the live
 * Hocuspocus Y.Doc, not as a persisted image. This endpoint reads the live
 * authoritative state (readLiveDocState — the same source the version-snapshot
 * path uses, so it never reads a stale/empty persisted row), decodes it into an
 * `{elements, files}` scene with the SAME validated primitive the version
 * preview uses (decodeBoardSnapshot — fail-closed on a wrong-kind/corrupt blob),
 * pre-downloads referenced image bytes (size-bounded, best-effort), then
 * serializes to SVG and — for PNG — rasterizes with @napi-rs/canvas (Skia),
 * compositing the downloaded image bytes onto the canvas (Skia's SVG engine
 * does not render data-URI <image> elements).
 *
 * There is no headless browser: the renderer is a pure in-process serializer
 * plus a prebuilt native rasterizer, mirroring the short-lived/network-less
 * philosophy of the Typst PDF path. See the W3 renderer-selection spike.
 *
 * Mounted on BOTH the human /api/v1/docs chain and the bot /v1/bot/docs chain
 * (app.ts), so it reads req.uid / req.spaceId from whichever identity ran.
 */
import { Router, type Router as ExpressRouter, type Request, type Response } from 'express'
import { requireDocRole } from '../guard.js'
import { readLiveDocState } from '../../collab/liveDocRead.js'
import {
  decodeBoardSnapshot,
  BoardSnapshotInvalidError,
  WHITEBOARD_DOC_TYPE,
} from '../../collab/versionRestore.js'
import {
  serializeSceneToSvg,
  computeSceneLayout,
  rasterizeSvgToPng,
  type ResolvedSceneImage,
} from '../../whiteboard/exportScene.js'
import {
  acquirePngSlot,
  releasePngSlot,
  BoardExportBusyError,
} from '../../whiteboard/boardExportQueue.js'
import { docAttachmentRepo } from '../../db/repos/docAttachmentRepo.js'
import { getObjectStore } from '../../storage/objectStore.js'
import { config } from '../../config/env.js'
import { sanitizeSvg } from '../../util/sanitizeSvg.js'

export const boardExportRouter: ExpressRouter = Router()

type ExportFormat = 'png' | 'svg'

const MIME: Record<ExportFormat, string> = {
  png: 'image/png',
  svg: 'image/svg+xml; charset=utf-8',
}

/**
 * Reject a target whose doc_type is not 'board'. Mirrors requireSheetDocType in
 * docSheet.ts — a rich-text/sheet Y.Doc has no Excalidraw scene, so exporting it
 * here would be nonsensical; fail with 409 unsupported_doc_type before any read.
 */
function requireBoardDocType(res: Response, docType: string): boolean {
  if (docType !== WHITEBOARD_DOC_TYPE) {
    res.status(409).json({ error: 'unsupported_doc_type' })
    return false
  }
  return true
}

/** A single query value, taking the first when Express parsed a repeated param. */
function firstQueryValue(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0]
  return undefined
}

/** Parse ?format into png|svg (default png), or null when unrecognized. */
function parseFormat(raw: string | undefined): ExportFormat | null {
  if (raw === undefined || raw === '') return 'png'
  if (raw === 'png' || raw === 'svg') return raw
  return null
}

/** Magic-byte sniff → the mime a rasterizer/browser can decode, or null. */
export function sanitizeSceneImage(buf: Buffer): ResolvedSceneImage | null {
  if (buf.length >= 4) {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { mime: 'image/png', bytes: buf }
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', bytes: buf }
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return { mime: 'image/gif', bytes: buf }
  }
  // SVG attachments reached storage only through the sanitizing upload path.
  // Re-validate on export so a corrupt/legacy object cannot become active XML
  // embedded in the generated board SVG.
  try {
    return { mime: 'image/svg+xml', bytes: sanitizeSvg(buf) }
  } catch {
    return null
  }
}

/**
 * Fetch up to maxBytes from a signed GET URL. Aborts and returns null on any
 * failure, non-200, or over-size body (streamed, so an oversize response can't
 * blow memory). A synthetic/dev host that isn't a real endpoint yields null and
 * the image simply renders as a placeholder. Copied from export.ts (PDF path).
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

/**
 * Resolve the bytes for the scene's image elements, keyed by the element's
 * fileId. Walks image elements → files[fileId].attachId → the doc's attachment
 * rows → a signed GET URL → downloaded bytes (bounded by count / per-image /
 * aggregate budgets). Best-effort: an unresolvable or oversize image is simply
 * omitted (rendered as a placeholder), never fatal — matching the PDF path.
 */
async function resolveSceneImages(
  docId: string,
  scene: { elements: Array<Record<string, unknown>>; files: Record<string, Record<string, unknown>> },
): Promise<Map<string, ResolvedSceneImage>> {
  const out = new Map<string, ResolvedSceneImage>()

  // fileId -> attachId, only for image elements actually present in the scene.
  const fileIdToAttach = new Map<string, string>()
  for (const el of scene.elements) {
    if (el.isDeleted === true || el.type !== 'image') continue
    const fileId = typeof el.fileId === 'string' ? el.fileId : ''
    if (!fileId || fileIdToAttach.has(fileId)) continue
    const ref = scene.files[fileId]
    const attachId = ref && typeof ref.attachId === 'string' ? ref.attachId : ''
    if (attachId) fileIdToAttach.set(fileId, attachId)
  }
  if (fileIdToAttach.size === 0) return out

  const store = getObjectStore()
  const ttl = config.attachments.readUrlTtlSeconds
  const { maxImageBytes, maxImageCount, maxImageTotalBytes } = config.boardExport

  // One query for the doc's attachment set, then O(1) membership (anti-enum).
  const byId = new Map<string, Awaited<ReturnType<typeof docAttachmentRepo.getById>>>()
  for (const a of await docAttachmentRepo.listByDoc(docId)) byId.set(a.attachId, a)

  let attempts = 0
  let totalBytes = 0
  for (const [fileId, attachId] of fileIdToAttach) {
    if (attempts >= maxImageCount) break
    const a = byId.get(attachId)
    if (!a || !a.mime.startsWith('image/')) continue
    attempts++
    if (typeof a.sizeBytes === 'number' && a.sizeBytes > 0 && totalBytes + a.sizeBytes > maxImageTotalBytes) {
      continue
    }
    const url = store.presignGet(a.objectKey, ttl)
    const bytes = await tryDownload(url, maxImageBytes)
    if (!bytes) continue
    const image = sanitizeSceneImage(bytes)
    if (!image) continue // corrupt/unsupported — drop like the PDF path
    if (totalBytes + image.bytes.byteLength > maxImageTotalBytes) continue
    totalBytes += image.bytes.byteLength
    out.set(fileId, image)
  }
  return out
}

boardExportRouter.get('/:docId/export', exportBoardHandler)

export async function exportBoardHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(req, res, req.params.docId!, 'reader')
  if (!guard) return
  if (!requireBoardDocType(res, guard.meta.doc_type)) return

  const format = parseFormat(firstQueryValue(req.query.format))
  if (!format) {
    res.status(400).json({ error: 'invalid_format' })
    return
  }

  // Read the LIVE authoritative scene (never the possibly-stale persisted row),
  // then decode with the same fail-closed primitive the version preview uses.
  const state = await readLiveDocState(guard.meta.document_name)
  let scene
  try {
    scene = decodeBoardSnapshot(state)
  } catch (err) {
    if (err instanceof BoardSnapshotInvalidError) {
      res.status(409).json({ error: 'board_snapshot_invalid' })
      return
    }
    throw err
  }

  const images = await resolveSceneImages(guard.meta.doc_id, scene)
  const svg = serializeSceneToSvg(scene, images, { maxDimension: config.boardExport.maxSvgDimension })

  const fileName = `${guard.meta.doc_id}.${format}`
  // nosniff on every export: the browser must honor the declared type and never
  // MIME-sniff the body into something executable.
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'no-store')

  if (format === 'svg') {
    // Serve SVG as an attachment, never inline. The body is fully escaped /
    // token-validated (no <script>/<style>/<foreignObject>, no scene-controlled
    // href), so it is not an active XSS today — but SVG-from-our-origin is
    // script-capable when rendered as a top-level document, and this codebase
    // already blocks image/svg+xml from inline attachment serving (env.ts
    // blockedMimes). Downloading rather than rendering keeps that posture and
    // means a future serializer regression can't become a stored-XSS vector.
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
    res.status(200).type(MIME.svg).send(svg)
    return
  }

  res.setHeader('Content-Disposition', `inline; filename="${fileName}"`)
  // Skia does not rasterize the SVG's data-URI <image> elements, so pass the
  // resolved image bytes + the shared layout so the PNG path composites them
  // onto the canvas directly (best-effort). The SVG output above keeps the
  // data-URI embed unchanged.
  //
  // Gate the raster behind the concurrency queue: it is synchronous, CPU/memory
  // -heavy Skia work, so a burst of concurrent `?format=png` GETs must shed load
  // (503) rather than pile up and OOM. Acquire before the raster, always release.
  try {
    await acquirePngSlot()
  } catch (err) {
    if (err instanceof BoardExportBusyError) {
      res.status(503).json({ error: 'export_busy' })
      return
    }
    throw err
  }
  try {
    const layout = computeSceneLayout(scene, { maxDimension: config.boardExport.maxSvgDimension })
    const png = await rasterizeSvgToPng(svg, {
      fitWidth: config.boardExport.pngWidth,
      maxPixels: config.boardExport.maxPngPixels,
      maxSourceImagePixels: config.boardExport.maxSourceImagePixels,
      composite: { elements: scene.elements, imagesByFileId: images, layout },
    })
    res.status(200).type(MIME.png).send(png)
  } finally {
    releasePngSlot()
  }
}
