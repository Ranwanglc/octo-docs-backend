/**
 * Attachment presign + read endpoints (§3.5).
 *   POST /api/v1/docs/{docId}/attachments/presign       (needs writer)
 *   GET  /api/v1/docs/{docId}/attachments/{attachId}     (needs reader)
 *
 * Flow (§3.5): the front-end requests a presigned upload URL, uploads the
 * binary directly to object storage (not through Hocuspocus), then the backend
 * registers a doc_attachment row. The Tiptap image node stores the `attach_id`
 * (or a controlled URL) — never base64 — so the Y.Doc stays small. At read time
 * the reference is exchanged for a freshly signed, time-limited GET URL.
 */
import { Router, type Router as ExpressRouter, type Request, type Response } from 'express'
import { requireDocRole } from '../guard.js'
import { newAttachId } from '../../util/ids.js'
import { config } from '../../config/env.js'
import { getObjectStore } from '../../storage/objectStore.js'
import { docAttachmentRepo, type DocAttachment } from '../../db/repos/docAttachmentRepo.js'
import { docMetaRepo } from '../../db/repos/docMetaRepo.js'
import { resolveRole } from '../../permission/resolveRole.js'
import { roleAtLeast } from '../../permission/role.js'
import { fetchExternalImage } from '../../util/fetchExternalImage.js'
import { LinkCardError } from '../../util/ssrfGuard.js'
import { sniffImageMime } from '../../import/docx/media.js'
import { sanitizeSvg, InvalidSvgError, MAX_SANITIZED_SVG_BYTES } from '../../util/sanitizeSvg.js'

export const attachmentsRouter: ExpressRouter = Router()

/** Allowed MIME entries from config (e.g. 'image/,application/pdf,text/plain'). */
function allowedMimeEntries(): string[] {
  return config.attachments.allowedMimePrefixes
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p !== '')
}

/** Base MIME with any '; charset=...' parameter stripped, lower-cased. */
function baseMime(mime: string): string {
  return mime.split(';')[0]!.trim().toLowerCase()
}

/**
 * An allowed entry ending in '/' is a PREFIX match ('image/' -> image/png); an
 * entry without a trailing slash is an EXACT match. Exact matching is what keeps
 * a forged 'text/plaintext' / 'text/plain-x' from slipping past a bare
 * 'text/plain' entry (which a startsWith check would wrongly admit, §3.5 S5).
 */
function mimeAllowed(mime: string): boolean {
  const base = baseMime(mime)
  return allowedMimeEntries().some((entry) =>
    entry.endsWith('/') ? base.startsWith(entry) : base === entry,
  )
}

/**
 * Size tier is chosen by the backend from the 'image/' prefix (the same single
 * source of truth as the allow-list), never trusted from the client: 'image/'
 * -> image tier, everything else -> file tier. Both tiers hard-cap. The tier is
 * a UX/abuse constraint, not a security boundary (the declared mime is forgeable
 * — §3.5 S4); the real defences are the denylist + Content-Disposition + nosniff.
 */
function maxSizeFor(mime: string): number {
  return baseMime(mime).startsWith('image/')
    ? config.attachments.maxImageSizeBytes
    : config.attachments.maxFileSizeBytes
}

/** Types safe to render inline; everything else is forced to download (§3.5). */
function isInlineType(mime: string): boolean {
  const base = baseMime(mime)
  return base.startsWith('image/') || base === 'application/pdf'
}

/** Exact-match MIME denylist from config (e.g. 'image/svg+xml'). */
function blockedMimes(): string[] {
  return config.attachments.blockedMimes
    .split(',')
    .map((m) => m.trim().toLowerCase())
    .filter((m) => m !== '')
}

/**
 * A blocked MIME takes precedence over the allowed-prefix check. SVG in
 * particular matches the 'image/' prefix yet can embed <script>, so serving it
 * from our origin is an XSS vector — reject it at presign time.
 */
function mimeBlocked(mime: string): boolean {
  // Drop any '; charset=...' parameters before comparing.
  return blockedMimes().includes(baseMime(mime))
}

/**
 * Reduce a client-supplied file name to a safe single path segment: strip any
 * directory components and reject '..' traversal so the object key can never
 * escape the `${docId}/${attachId}/` prefix.
 */
function sanitizeFileName(fileName: string): string {
  // Take the last path segment regardless of '/' or '\' separators.
  const base = fileName.split(/[/\\]/).pop() ?? ''
  // Drop leading dots so '..' / '...' collapse to a safe name; allow a normal
  // extension dot to remain (e.g. 'photo.png').
  const cleaned = base.replace(/^\.+/, '').trim()
  return cleaned === '' ? 'file' : cleaned
}

/**
 * Make a stored (already path-sanitized) file name safe to embed inside a
 * `Content-Disposition: attachment; filename="..."` value: drop the quote,
 * backslash and control characters that could break out of the quoted-string.
 */
function dispositionFileName(fileName: string): string {
  const cleaned = fileName.replace(/[\p{Cc}"\\]/gu, '').trim()
  return cleaned === '' ? 'file' : cleaned
}

/**
 * Mint a freshly signed, time-limited GET URL for a stored attachment. Non-inline
 * types (anything but image/ and application/pdf) carry a forced-download
 * Content-Disposition so a forged HTML/script payload declared as an allowed type
 * cannot render in the browser; the disposition is baked into the signed URL so
 * object storage replays it as the response header (§3.5). dispositionFileName
 * strips quote/backslash/control chars first, so the file name cannot break out
 * of the quoted-string or inject a CR-LF header. The served Content-Type is also
 * pinned to the registered `attachment.mime` — the value already vetted by the
 * denylist/allow-list at presign time — so the GET response can never echo the
 * attacker-controlled raw PUT header (stored XSS — XIN-726). The inline-vs-
 * download decision is likewise taken from that trusted registered mime. The
 * single read and batch resolve endpoints share this one path so they never drift.
 */
export function presignAttachmentReadUrl(attachment: DocAttachment, ttl: number): string {
  const contentDisposition = isInlineType(attachment.mime)
    ? undefined
    : `attachment; filename="${dispositionFileName(attachment.fileName)}"`
  return getObjectStore().presignGet(attachment.objectKey, ttl, {
    contentDisposition,
    responseContentType: attachment.mime,
  })
}

attachmentsRouter.post('/:docId/attachments/presign', presignHandler)

/**
 * SVG cannot use the generic direct-to-storage presign flow because the backend
 * would never see the active XML. This endpoint receives the raw SVG, sanitizes
 * it, uploads only the sanitized bytes, and then registers the attachment.
 */
attachmentsRouter.post('/:docId/attachments/svg', svgUploadHandler)

export async function svgUploadHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'writer', {
    isBot: req.botToken !== undefined,
    token: req.octoToken,
  })
  if (!guard) return

  const declaredLength = Number(req.headers['content-length'] ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SANITIZED_SVG_BYTES) {
    res.status(413).json({ error: 'size_too_large' })
    return
  }

  const chunks: Buffer[] = []
  let received = 0
  try {
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      received += bytes.length
      if (received > MAX_SANITIZED_SVG_BYTES) {
        res.status(413).json({ error: 'size_too_large' })
        return
      }
      chunks.push(bytes)
    }
  } catch {
    res.status(400).json({ error: 'upload_read_failed' })
    return
  }
  if (received === 0) {
    res.status(400).json({ error: 'invalid_svg' })
    return
  }

  let bytes: Buffer
  try {
    bytes = sanitizeSvg(Buffer.concat(chunks, received))
  } catch (err) {
    res.status(400).json({ error: err instanceof InvalidSvgError ? err.code : 'invalid_svg' })
    return
  }

  const docId = guard.meta.doc_id
  const attachId = newAttachId()
  const rawName = req.headers['x-file-name']
  let decodedName = 'image.svg'
  if (typeof rawName === 'string') {
    try { decodedName = decodeURIComponent(rawName) } catch { /* use safe fallback */ }
  }
  const safeName = sanitizeFileName(decodedName)
  const objectKey = `${docId}/${attachId}/${safeName}`
  const mime = 'image/svg+xml'

  try {
    await getObjectStore().upload(objectKey, mime, new Uint8Array(bytes))
    await docAttachmentRepo.register({
      attachId,
      docId,
      objectKey,
      mime,
      sizeBytes: bytes.length,
      fileName: safeName,
      createdBy: req.uid!,
    })
  } catch {
    res.status(502).json({ error: 'upload_failed' })
    return
  }

  const attachment = await docAttachmentRepo.getById(attachId)
  res.status(201).json({
    attachId,
    objectKey,
    mime,
    sizeBytes: bytes.length,
    fileName: safeName,
    url: attachment ? presignAttachmentReadUrl(attachment, config.attachments.readUrlTtlSeconds) : null,
  })
}

export async function presignHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'writer', { isBot: req.botToken !== undefined, token: req.octoToken })
  if (!guard) return

  const { fileName, mime, sizeBytes } = req.body ?? {}

  if (typeof fileName !== 'string' || fileName === '') {
    res.status(400).json({ error: 'fileName required' })
    return
  }
  if (typeof mime !== 'string') {
    res.status(400).json({
      error: 'mime_not_allowed',
      detail: `mime must be one of (prefix or exact): ${allowedMimeEntries().join(', ')}`,
    })
    return
  }
  // Denylist takes precedence over the allow-list (§3.5): a dangerous type is
  // reported as mime_blocked even when it is not (or partially) allowed, so
  // SVG/HTML/script/executable types never read as a mere "not allowed" miss.
  if (mimeBlocked(mime)) {
    res.status(400).json({
      error: 'mime_blocked',
      detail: `mime is not permitted: ${blockedMimes().join(', ')}`,
    })
    return
  }
  if (!mimeAllowed(mime)) {
    res.status(400).json({
      error: 'mime_not_allowed',
      detail: `mime must be one of (prefix or exact): ${allowedMimeEntries().join(', ')}`,
    })
    return
  }
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    res.status(400).json({ error: 'sizeBytes must be a positive number' })
    return
  }
  // Tiered cap chosen by mime prefix (image vs file); both tiers hard-cap.
  const maxSize = maxSizeFor(mime)
  if (sizeBytes > maxSize) {
    res.status(400).json({
      error: 'size_too_large',
      detail: `sizeBytes exceeds max of ${maxSize}`,
    })
    return
  }

  const docId = guard.meta.doc_id
  const attachId = newAttachId()
  const safeName = sanitizeFileName(fileName)
  // attach_id is unique, so the key is collision-free even for duplicate names.
  const objectKey = `${docId}/${attachId}/${safeName}`

  await docAttachmentRepo.register({
    attachId,
    docId,
    objectKey,
    mime,
    sizeBytes,
    fileName: safeName,
    createdBy: req.uid!,
  })

  const ttl = config.attachments.uploadUrlTtlSeconds
  const presigned = getObjectStore().presignPut(objectKey, mime, ttl)

  res.status(200).json({
    attachId,
    objectKey,
    bucket: config.attachments.bucket,
    mime,
    sizeBytes,
    uploadUrl: presigned.uploadUrl,
    headers: presigned.headers,
    expiresInSec: ttl,
  })
}

/**
 * Read-time signed URL exchange (§3.5 step 5): look up the attachment, confirm
 * it belongs to this doc, and return a freshly signed time-limited GET URL.
 */
attachmentsRouter.get('/:docId/attachments/:attachId', readHandler)

export async function readHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'reader', { isBot: req.botToken !== undefined, token: req.octoToken })
  if (!guard) return

  const attachment = await docAttachmentRepo.getById(req.params.attachId!)
  // Hide cross-doc references behind 404 (do not leak existence to other docs).
  if (!attachment || attachment.docId !== guard.meta.doc_id) {
    res.status(404).json({ error: 'not_found' })
    return
  }

  const ttl = config.attachments.readUrlTtlSeconds
  const url = presignAttachmentReadUrl(attachment, ttl)

  res.status(200).json({
    attachId: attachment.attachId,
    objectKey: attachment.objectKey,
    mime: attachment.mime,
    sizeBytes: attachment.sizeBytes,
    fileName: attachment.fileName,
    url,
    expiresInSec: ttl,
  })
}

/**
 * Read-only batch signed-URL resolve (§3.3, RES-1..3): given a list of attachIds,
 * return a freshly signed GET URL plus metadata for each one owned by this doc.
 * Export-to-markdown needs this because the file-attachment node carries no URL
 * at all and the image node's cached src may already be expired — at export time
 * the front-end exchanges the attachIds for fresh links. Nothing is embedded and
 * no binary is packaged; the links may expire and are re-fetched on demand.
 */
attachmentsRouter.post('/:docId/attachments/resolve', resolveHandler)

export async function resolveHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'reader', { isBot: req.botToken !== undefined, token: req.octoToken })
  if (!guard) return

  const { attachIds } = req.body ?? {}

  // RES-1 hard constraints: the body must be a non-empty array of strings.
  if (
    !Array.isArray(attachIds) ||
    attachIds.length === 0 ||
    attachIds.some((id) => typeof id !== 'string')
  ) {
    res.status(400).json({ error: 'invalid_body' })
    return
  }
  // RES-1 hard cap: reject over-cap requests outright — never silently truncate,
  // which would drop attachments and break the lossless-export guarantee.
  if (attachIds.length > config.attachments.maxResolveBatch) {
    res.status(400).json({ error: 'attachIds_too_many' })
    return
  }

  // Dedup while keeping first-seen order so the response is stable.
  const requested = [...new Set(attachIds as string[])]

  // RES-2 anti-enumeration: one query for this doc's whole set, then O(1)
  // membership checks. An id not in the set (cross-doc or non-existent) lands in
  // notFound with no existence leak, matching readHandler's cross-doc 404 stance.
  const owned = new Map<string, DocAttachment>()
  for (const attachment of await docAttachmentRepo.listByDoc(guard.meta.doc_id)) {
    owned.set(attachment.attachId, attachment)
  }

  const ttl = config.attachments.readUrlTtlSeconds
  const items: Array<{
    attachId: string
    url: string
    expiresInSec: number
    mime: string
    sizeBytes: number
    fileName: string
  }> = []
  const notFound: string[] = []

  for (const attachId of requested) {
    const attachment = owned.get(attachId)
    if (!attachment) {
      notFound.push(attachId)
      continue
    }
    // RES-3: same presign + Content-Disposition path as the single read endpoint.
    items.push({
      attachId: attachment.attachId,
      url: presignAttachmentReadUrl(attachment, ttl),
      expiresInSec: ttl,
      mime: attachment.mime,
      sizeBytes: attachment.sizeBytes,
      fileName: attachment.fileName,
    })
  }

  res.status(200).json({ items, notFound })
}

/**
 * Copy attachments FROM other docs INTO this doc (§ markdown-import image migration).
 *
 *   POST /:docId/attachments/copy   editor — server-to-server copy of already-stored
 *                                   attachments so a Markdown/PDF import that references
 *                                   another doc's images re-hosts them under the target doc.
 *
 * Why server-side: the client only holds a short-lived signed URL for the source image, so a
 * browser "download then re-upload" breaks as soon as that signature expires. The backend copies
 * the bytes store-to-store from the source object key, so it never depends on a signed URL and
 * never expires. Only attachments our own service already stores (a real doc_attachment row the
 * caller can read) are eligible — an external/foreign URL has no source ref and is simply not
 * sent to this endpoint.
 *
 * Security (default-deny, matches presign/resolve):
 *   - writer on the TARGET doc (this is a write) AND reader on the SOURCE doc (no copying bytes
 *     you cannot read). Cross-space sources 404 via requireDocRole's same-space gate — no leak.
 *   - the source attachment must actually belong to the claimed source doc (else 404, no leak).
 *   - the source mime is re-validated against the SAME allow/deny lists + size caps as a fresh
 *     upload, so a historically-stored but now-disallowed type (e.g. an SVG that predates the
 *     denylist) cannot be laundered into the new doc.
 *   - one bad source degrades to `notCopied` (best-effort) instead of sinking the whole import.
 */
attachmentsRouter.post('/:docId/attachments/copy', copyHandler)

interface CopySourceRef {
  docId: string
  attachId: string
}

export async function copyHandler(req: Request, res: Response): Promise<void> {
  // Copy WRITES into the target doc → writer role, default-deny.
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'writer')
  if (!guard) return
  const targetDocId = guard.meta.doc_id

  const { sources } = req.body ?? {}
  if (!Array.isArray(sources) || sources.length === 0) {
    res.status(400).json({ error: 'invalid_body' })
    return
  }
  if (sources.length > config.attachments.maxResolveBatch) {
    res.status(400).json({ error: 'sources_too_many' })
    return
  }
  // Shape-validate every entry up front so a single bad element is a 400, not a partial copy.
  const refs: CopySourceRef[] = []
  for (const s of sources) {
    if (
      typeof s !== 'object' || s === null ||
      typeof (s as CopySourceRef).docId !== 'string' || (s as CopySourceRef).docId === '' ||
      typeof (s as CopySourceRef).attachId !== 'string' || (s as CopySourceRef).attachId === ''
    ) {
      res.status(400).json({ error: 'invalid_body' })
      return
    }
    refs.push({ docId: (s as CopySourceRef).docId, attachId: (s as CopySourceRef).attachId })
  }

  // Dedup by source (docId+attachId) keeping first-seen order so a repeated image is copied once.
  const seen = new Set<string>()
  const unique: CopySourceRef[] = []
  for (const r of refs) {
    const k = `${r.docId}\u0000${r.attachId}`
    if (!seen.has(k)) { seen.add(k); unique.push(r) }
  }

  const ttl = config.attachments.readUrlTtlSeconds
  const mappings: Array<{
    sourceDocId: string
    sourceAttachId: string
    attachId: string
    url: string
    mime: string
    sizeBytes: number
    fileName: string
  }> = []
  const notCopied: Array<{ sourceDocId: string; sourceAttachId: string; reason: string }> = []

  for (const ref of unique) {
    const fail = (reason: string) =>
      notCopied.push({ sourceDocId: ref.docId, sourceAttachId: ref.attachId, reason })

    // Reader on the SOURCE doc: you may only copy bytes you are allowed to read. A cross-space
    // or missing source resolves to a guard failure below; we translate it into notCopied
    // (no existence leak) rather than aborting the whole batch.
    const srcMeta = await docMetaRepo.getByDocId(ref.docId)
    if (!srcMeta || srcMeta.status === 0 || srcMeta.space_id !== req.spaceId!) {
      fail('source_not_found')
      continue
    }
    const srcRole = await resolveRole(req.uid!, ref.docId)
    if (srcRole === 'none' || !roleAtLeast(srcRole, 'reader')) {
      fail('source_forbidden')
      continue
    }

    const src = await docAttachmentRepo.getById(ref.attachId)
    // The attachment must exist AND belong to the claimed source doc (no cross-doc smuggling).
    if (!src || src.docId !== ref.docId) {
      fail('source_not_found')
      continue
    }
    // Re-validate the source type against the CURRENT policy. SVG is the sole blocked MIME that
    // may be copied: it entered through the dedicated sanitizer endpoint and is sanitized again
    // by copyStoredObject below. All other blocked types remain denied.
    const sourceMime = baseMime(src.mime)
    if ((mimeBlocked(src.mime) && sourceMime !== 'image/svg+xml') || !mimeAllowed(src.mime)) {
      fail('mime_not_allowed')
      continue
    }
    if (src.sizeBytes > maxSizeFor(src.mime)) {
      fail('size_too_large')
      continue
    }

    try {
      const attachId = await copyStoredObject(src, targetDocId, req.uid!)
      const created = await docAttachmentRepo.getById(attachId)
      if (!created) { fail('copy_failed'); continue }
      mappings.push({
        sourceDocId: ref.docId,
        sourceAttachId: ref.attachId,
        attachId,
        url: presignAttachmentReadUrl(created, ttl),
        mime: created.mime,
        sizeBytes: created.sizeBytes,
        fileName: created.fileName,
      })
    } catch {
      fail('copy_failed')
    }
  }

  res.status(200).json({ mappings, notCopied })
}

/**
 * Copy a stored attachment's bytes into the target doc and register a fresh row.
 * Reads source bytes via the server-side internal endpoint (store.download) then
 * writes them back with store.upload, so container deployments never hit the
 * public presigned URL from inside the container network. Never touches a
 * client-supplied URL — only object keys the DB already vouches for.
 */
export async function copyStoredObject(
  src: DocAttachment,
  targetDocId: string,
  uid: string,
): Promise<string> {
  const store = getObjectStore()
  const cap = maxSizeFor(src.mime)
  // Streaming download: aborts mid-stream past cap so a stale/understated
  // sizeBytes row can never cause the server to fully buffer an oversized object.
  const downloaded = await store.download(src.objectKey, { maxBytes: cap })
  let bytes: Buffer = Buffer.from(downloaded)
  // Re-sanitize copied SVG bytes so legacy objects that predate the sanitized upload endpoint
  // cannot bypass the current policy through cross-document copy.
  if (baseMime(src.mime) === 'image/svg+xml') {
    bytes = sanitizeSvg(bytes)
    if (bytes.length > cap) throw new Error('sanitized SVG exceeds size cap')
  }

  const attachId = newAttachId()
  // src.fileName was sanitized at its own register time; keep it (it is already a safe segment).
  const objectKey = `${targetDocId}/${attachId}/${src.fileName}`
  try {
    await store.upload(objectKey, src.mime, new Uint8Array(bytes))
    await docAttachmentRepo.register({
      attachId,
      docId: targetDocId,
      objectKey,
      mime: src.mime,
      sizeBytes: bytes.length,
      fileName: src.fileName,
      createdBy: uid,
    })
    return attachId
  } catch (err) {
    await Promise.allSettled([
      docAttachmentRepo.deleteById(attachId),
      store.delete(objectKey),
    ])
    throw err
  }
}

/** Compensate a successful copy when the enclosing document edit does not commit. */
export async function cleanupCopiedAttachment(attachId: string): Promise<void> {
  const attachment = await docAttachmentRepo.getById(attachId)
  if (!attachment) return
  await getObjectStore().delete(attachment.objectKey)
  await docAttachmentRepo.deleteById(attachId)
}

/**
 * Ingest EXTERNAL image URLs into this doc (§ markdown-import external-image re-hosting).
 *
 *   POST /:docId/attachments/ingest   editor — download a plain external image URL server-side
 *                                     (SSRF-guarded) and store it under this doc, so an imported
 *                                     document does not silently break when the external host
 *                                     later goes away. On any failure the caller keeps the
 *                                     original URL (best-effort), so a blocked/oversized/dead
 *                                     source never sinks the import.
 *
 * Security: writer on the target doc; every URL goes through the link-card SSRF guard
 * (loopback / private / link-local / CGNAT / metadata IPs refused, connect pinned to the
 * validated IP, http/https + port allowlist only); the downloaded bytes are validated by MAGIC
 * NUMBER (never the Content-Type header or the URL extension) and must be an allowed, non-blocked
 * image within the image size tier. This is deliberately image-only — arbitrary file ingestion
 * from a URL is a broader abuse surface we do not want here.
 */
attachmentsRouter.post('/:docId/attachments/ingest', ingestHandler)

export async function ingestHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'writer')
  if (!guard) return
  const targetDocId = guard.meta.doc_id

  const { urls } = req.body ?? {}
  if (!Array.isArray(urls) || urls.length === 0) {
    res.status(400).json({ error: 'invalid_body' })
    return
  }
  if (urls.length > config.attachments.maxResolveBatch) {
    res.status(400).json({ error: 'urls_too_many' })
    return
  }
  // De-dupe + shape check: every entry must be a non-empty http(s) string.
  const seen = new Set<string>()
  const unique: string[] = []
  for (const u of urls) {
    if (typeof u !== 'string' || u === '') {
      res.status(400).json({ error: 'invalid_body' })
      return
    }
    if (!seen.has(u)) { seen.add(u); unique.push(u) }
  }

  const ttl = config.attachments.readUrlTtlSeconds
  const maxImage = config.attachments.maxImageSizeBytes
  const mappings: Array<{ sourceUrl: string; attachId: string; url: string; mime: string; sizeBytes: number }> = []
  const notIngested: Array<{ sourceUrl: string; reason: string }> = []

  for (const sourceUrl of unique) {
    try {
      const fetched = await fetchExternalImage(sourceUrl, maxImage)
      let bytes = fetched.bytes
      // Magic-number/content sniff: the declared Content-Type and URL extension are advisory only.
      // Raster formats use their binary magic. A real SVG root is parsed and sanitized before it
      // can reach storage; active/malformed XML fails closed as not_an_image.
      let mime = sniffImageMime(bytes)
      // sniffImageMime deliberately recognizes an SVG *candidate* because SVG
      // has no binary magic. Candidate recognition is never a sanitation
      // boundary: every SVG must still pass the active-XML sanitizer here.
      if (!mime || mime === 'image/svg+xml') {
        try {
          bytes = sanitizeSvg(bytes)
          mime = 'image/svg+xml'
        } catch {
          notIngested.push({ sourceUrl, reason: 'not_an_image' })
          continue
        }
      }
      if ((mimeBlocked(mime) && mime !== 'image/svg+xml') || !mimeAllowed(mime)) {
        notIngested.push({ sourceUrl, reason: 'mime_not_allowed' })
        continue
      }
      if (bytes.length > maxImage) { notIngested.push({ sourceUrl, reason: 'size_too_large' }); continue }

      const attachId = newAttachId()
      const fileName = safeImageFileName(sourceUrl, mime)
      const objectKey = `${targetDocId}/${attachId}/${fileName}`
      await docAttachmentRepo.register({
        attachId, docId: targetDocId, objectKey, mime, sizeBytes: bytes.length, fileName, createdBy: req.uid!,
      })
      const store = getObjectStore()
      try {
        await store.upload(objectKey, mime, new Uint8Array(bytes))
      } catch { notIngested.push({ sourceUrl, reason: 'store_failed' }); continue }
      const created = await docAttachmentRepo.getById(attachId)
      if (!created) { notIngested.push({ sourceUrl, reason: 'store_failed' }); continue }
      mappings.push({ sourceUrl, attachId, url: presignAttachmentReadUrl(created, ttl), mime, sizeBytes: bytes.length })
    } catch (err) {
      // SSRF-blocked / oversized / dead host / bad scheme all land here; keep the original URL.
      const reason = err instanceof LinkCardError ? err.code : 'fetch_failed'
      notIngested.push({ sourceUrl, reason })
    }
  }

  res.status(200).json({ mappings, notIngested })
}

/** A safe object-key file segment for an ingested image: basename from the URL path, sanitized,
 * with an extension coerced from the sniffed mime. Never uses a client-controlled path. */
function safeImageFileName(sourceUrl: string, mime: string): string {
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/svg+xml' ? 'svg' : mime.split('/')[1] || 'img'
  let base = 'image'
  try {
    const p = new URL(sourceUrl).pathname.split('/').filter(Boolean).pop() || ''
    const cleaned = p.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
    if (cleaned) base = cleaned
  } catch {
    /* keep default */
  }
  return `${base}.${ext}`
}
