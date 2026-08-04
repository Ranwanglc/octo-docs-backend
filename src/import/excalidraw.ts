import { randomBytes } from 'node:crypto'
import { generateNKeysBetween } from 'fractional-indexing'
import { config } from '../config/env.js'
import { docAttachmentRepo } from '../db/repos/docAttachmentRepo.js'
import { getObjectStore } from '../storage/objectStore.js'
import { newAttachId } from '../util/ids.js'
import { sanitizeSvg } from '../util/sanitizeSvg.js'
import { sniffImageMime } from './docx/media.js'
import { isReservedEntryKey, isValidIndex, normalizeElement } from '../whiteboard/schema/index.js'

export class ExcalidrawImportError extends Error {
  constructor(readonly code: string, readonly status = 422) { super(code) }
}

export interface PreparedExcalidrawImport {
  elements: Array<Record<string, unknown>>
  files: Record<string, Record<string, unknown>>
  elementIdMap: Record<string, string>
  fileIdMap: Record<string, string>
  uploadedAttachments?: Array<{ attachId: string; objectKey: string }>
}

type Upload = (bytes: Buffer, mime: string, fileName: string) => Promise<string>

function freshId(prefix: string, used: Set<string>): string {
  let id: string
  do id = `${prefix}_${randomBytes(12).toString('hex')}`; while (used.has(id))
  used.add(id)
  return id
}

function byteSize(v: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(v)) } catch { throw new ExcalidrawImportError('invalid_excalidraw') }
}

function remapReferences(el: Record<string, unknown>, elementIds: Map<string, string>, fileIds: Map<string, string>): void {
  const mapElement = (v: unknown) => typeof v === 'string' ? (elementIds.get(v) ?? v) : v
  if (typeof el.frameId === 'string') el.frameId = mapElement(el.frameId)
  if (typeof el.containerId === 'string') el.containerId = mapElement(el.containerId)
  if (typeof el.fileId === 'string') el.fileId = fileIds.get(el.fileId) ?? el.fileId
  if (Array.isArray(el.boundElements)) {
    el.boundElements = el.boundElements.map((b) => b && typeof b === 'object'
      ? { ...(b as Record<string, unknown>), id: mapElement((b as Record<string, unknown>).id) }
      : b)
  }
  for (const field of ['startBinding', 'endBinding'] as const) {
    const binding = el[field]
    if (binding && typeof binding === 'object' && !Array.isArray(binding)) {
      const oldTarget = (binding as Record<string, unknown>).elementId
      // Bindings in a portable scene must target another imported element. Do
      // not accidentally bind to a same-named element already in the target.
      el[field] = typeof oldTarget === 'string' && elementIds.has(oldTarget)
        ? { ...(binding as Record<string, unknown>), elementId: elementIds.get(oldTarget) }
        : null
    }
  }
}

function remapGroups(el: Record<string, unknown>, groupIds: Map<string, string>): void {
  if (el.groupIds === undefined) return
  if (!Array.isArray(el.groupIds) || el.groupIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new ExcalidrawImportError('board_element_invalid')
  }
  el.groupIds = el.groupIds.map((id) => groupIds.get(id as string)!)
}

function assertNoInlineData(value: unknown, seen = new Set<object>()): void {
  if (typeof value === 'string' && /^data:[^,]*;base64,/i.test(value.trim())) {
    throw new ExcalidrawImportError('inline_data_forbidden')
  }
  if (!value || typeof value !== 'object') return
  if (seen.has(value as object)) throw new ExcalidrawImportError('invalid_excalidraw')
  seen.add(value as object)
  for (const child of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) {
    assertNoInlineData(child, seen)
  }
  seen.delete(value as object)
}

function decodeDataUrl(raw: string): { bytes: Buffer; mime: string } {
  const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(raw)
  if (!match || !match[1] || match[2] === undefined || match[2].length === 0 || match[2].length % 4 === 1) {
    throw new ExcalidrawImportError('invalid_embedded_file')
  }
  const bytes = Buffer.from(match[2], 'base64')
  if (bytes.length === 0 || bytes.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')) {
    throw new ExcalidrawImportError('invalid_embedded_file')
  }
  if (bytes.length > config.attachments.maxImageSizeBytes) throw new ExcalidrawImportError('embedded_file_too_large', 413)
  let mime = sniffImageMime(bytes)
  let clean: Buffer<ArrayBufferLike> = bytes
  // An SVG root is only a format candidate, not proof that the active XML is
  // safe. Sanitize every candidate before upload, including candidates already
  // identified by sniffImageMime.
  if (!mime || mime === 'image/svg+xml') {
    try { clean = sanitizeSvg(bytes); mime = 'image/svg+xml' } catch { throw new ExcalidrawImportError('invalid_embedded_file') }
  }
  if (match[1].toLowerCase() !== mime) {
    const jpegAlias = match[1].toLowerCase() === 'image/jpg' && mime === 'image/jpeg'
    if (!jpegAlias) throw new ExcalidrawImportError('embedded_file_mime_mismatch')
  }
  return { bytes: clean, mime }
}

export async function uploadExcalidrawAttachment(docId: string, uid: string, bytes: Buffer, mime: string, fileName: string): Promise<string> {
  const attachId = newAttachId()
  const safeName = fileName.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 96) || 'image'
  const objectKey = `${docId}/${attachId}/${safeName}`
  try {
    const signal = AbortSignal.timeout(config.docxImport.timeoutMs)
    await getObjectStore().upload(objectKey, mime, new Uint8Array(bytes), { signal })
  } catch {
    throw new ExcalidrawImportError('upload_failed', 502)
  }
  try {
    await docAttachmentRepo.register({ attachId, docId, objectKey, mime, sizeBytes: bytes.length, fileName: safeName, createdBy: uid })
  } catch (err) {
    await getObjectStore().delete(objectKey).catch(() => {})
    throw err
  }
  return attachId
}

export async function cleanupExcalidrawAttachments(uploads: Array<{ attachId: string; objectKey: string }>): Promise<void> {
  await Promise.allSettled(uploads.map(async ({ attachId, objectKey }) => {
    await Promise.allSettled([
      docAttachmentRepo.deleteById(attachId),
      getObjectStore().delete(objectKey),
    ])
  }))
}

/** Delete persisted files removed by a committed replace-mode board import. */
export async function cleanupReplacedExcalidrawAttachments(
  docId: string,
  files: Record<string, Record<string, unknown>>,
): Promise<void> {
  const attachIds = new Set<string>()
  for (const file of Object.values(files)) {
    if (typeof file.attachId === 'string' && file.attachId.length > 0) attachIds.add(file.attachId)
  }
  await Promise.allSettled([...attachIds].map(async (attachId) => {
    const attachment = await docAttachmentRepo.getById(attachId)
    // Attachment ids are durable capabilities. Only delete rows authoritatively
    // owned by the board that just committed the replacement.
    if (!attachment || attachment.docId !== docId) return
    // Keep the row as a retry cursor when object deletion fails.
    await getObjectStore().delete(attachment.objectKey)
    await docAttachmentRepo.deleteById(attachId)
  }))
}

export async function prepareExcalidrawImport(input: {
  scene: unknown
  existingElements: Array<Record<string, unknown>>
  existingFiles: Record<string, Record<string, unknown>>
  docId: string
  uid: string
  upload?: Upload
}): Promise<PreparedExcalidrawImport> {
  if (!input.scene || typeof input.scene !== 'object' || Array.isArray(input.scene)) throw new ExcalidrawImportError('invalid_excalidraw', 400)
  const scene = input.scene as Record<string, unknown>
  if (scene.type !== 'excalidraw' || scene.version !== 2) throw new ExcalidrawImportError('invalid_excalidraw')
  if (!Array.isArray(scene.elements) || !scene.files || typeof scene.files !== 'object' || Array.isArray(scene.files)) {
    throw new ExcalidrawImportError('invalid_excalidraw', 400)
  }
  const rawFiles = scene.files as Record<string, unknown>
  if (scene.elements.length + Object.keys(rawFiles).length > config.boardSceneWrite.maxElements) throw new ExcalidrawImportError('too_many_elements', 413)

  const usedElementIds = new Set(input.existingElements.map((e) => e.id).filter((v): v is string => typeof v === 'string'))
  const usedFileIds = new Set(Object.keys(input.existingFiles))
  const importedElementIds = new Set<string>()
  const importedFileIds = new Set<string>()
  const elementIds = new Map<string, string>()
  const fileIds = new Map<string, string>()
  // Group ids are scene-local in Excalidraw. Namespace every imported group,
  // not only known collisions, because the target may contain group ids on any
  // existing element and group membership must remain consistent internally.
  const usedGroupIds = new Set<string>()
  for (const el of input.existingElements) {
    if (Array.isArray(el.groupIds)) {
      for (const id of el.groupIds) if (typeof id === 'string') usedGroupIds.add(id)
    }
  }
  const groupIds = new Map<string, string>()

  for (const raw of scene.elements) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof (raw as Record<string, unknown>).id !== 'string' || !(raw as Record<string, unknown>).id) throw new ExcalidrawImportError('board_element_invalid')
    const id = (raw as Record<string, unknown>).id as string
    if (importedElementIds.has(id)) throw new ExcalidrawImportError('duplicate_element_id')
    importedElementIds.add(id)
    const mapped = usedElementIds.has(id) ? freshId('el', usedElementIds) : (usedElementIds.add(id), id)
    elementIds.set(id, mapped)
    const groups = (raw as Record<string, unknown>).groupIds
    if (groups !== undefined) {
      if (!Array.isArray(groups) || groups.some((groupId) => typeof groupId !== 'string' || groupId.length === 0)) {
        throw new ExcalidrawImportError('board_element_invalid')
      }
      for (const groupId of groups as string[]) {
        if (!groupIds.has(groupId)) groupIds.set(groupId, freshId('group', usedGroupIds))
      }
    }
  }
  for (const fid of Object.keys(rawFiles)) {
    if (!fid || isReservedEntryKey(fid) || importedFileIds.has(fid)) throw new ExcalidrawImportError('board_file_invalid')
    importedFileIds.add(fid)
    const mapped = usedFileIds.has(fid) ? freshId('file', usedFileIds) : (usedFileIds.add(fid), fid)
    fileIds.set(fid, mapped)
  }

  // Decode/sniff/sanitize every file while still in the pure validation phase.
  // No attachment row/object is written until the complete element set below
  // has normalized successfully and passed the no-inline-data assertion.
  const stagedFiles = new Map<string, { bytes: Buffer; mime: string; createdAt?: number }>()
  for (const [oldFid, raw] of Object.entries(rawFiles)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || byteSize(raw) > config.boardSceneWrite.maxElementContentBytes) throw new ExcalidrawImportError('board_file_invalid')
    const source = raw as Record<string, unknown>
    if (typeof source.dataURL !== 'string') throw new ExcalidrawImportError('invalid_embedded_file')
    const { bytes, mime } = decodeDataUrl(source.dataURL)
    stagedFiles.set(oldFid, {
      bytes,
      mime,
      ...(typeof source.created === 'number' && Number.isFinite(source.created) ? { createdAt: source.created } : {}),
    })
  }

  const maxIndex = input.existingElements.map((e) => e.index).filter(isValidIndex).sort().at(-1) ?? null
  const indices = generateNKeysBetween(maxIndex, null, scene.elements.length)
  const allImportedIds = new Set(elementIds.values())
  const allFileIds = new Set(fileIds.values())
  const elements = scene.elements.map((raw, i) => {
    if (byteSize(raw) > config.boardSceneWrite.maxElementContentBytes) throw new ExcalidrawImportError('element_too_large', 413)
    const out = { ...(raw as Record<string, unknown>), id: elementIds.get((raw as Record<string, unknown>).id as string)!, index: indices[i] }
    remapReferences(out, elementIds, fileIds)
    remapGroups(out, groupIds)
    const normalized = normalizeElement(out, { elementIds: allImportedIds, fileIds: allFileIds })
    if (!normalized) throw new ExcalidrawImportError('board_element_invalid')
    assertNoInlineData(normalized)
    return normalized as Record<string, unknown>
  })
  assertNoInlineData(elements)

  // Policy: validate every files entry above, but upload/store only files that
  // a surviving imported image references. Stale unreferenced Excalidraw files
  // do not create orphan attachment rows or consume object storage.
  const referencedFileIds = new Set(
    elements.map((el) => el.fileId).filter((id): id is string => typeof id === 'string'),
  )
  const upload = input.upload ?? ((bytes, mime, name) => uploadExcalidrawAttachment(input.docId, input.uid, bytes, mime, name))
  const files: Record<string, Record<string, unknown>> = Object.create(null)
  const uploadedAttachments: Array<{ attachId: string; objectKey: string }> = []
  try {
    for (const [oldFid, staged] of stagedFiles) {
      const mappedFid = fileIds.get(oldFid)!
      if (!referencedFileIds.has(mappedFid)) continue
      const ext = staged.mime === 'image/jpeg' ? 'jpg' : staged.mime === 'image/svg+xml' ? 'svg' : staged.mime.split('/')[1]!
      const attachId = await upload(staged.bytes, staged.mime, `${mappedFid}.${ext}`)
      if (!input.upload) {
        const attachment = await docAttachmentRepo.getById(attachId)
        if (attachment) uploadedAttachments.push({ attachId, objectKey: attachment.objectKey })
      }
      files[mappedFid] = {
        attachId,
        mimeType: staged.mime,
        status: 'saved',
        ...(staged.createdAt !== undefined ? { createdAt: staged.createdAt } : {}),
      }
    }
  } catch (err) {
    await cleanupExcalidrawAttachments(uploadedAttachments)
    throw err
  }
  assertNoInlineData({ elements, files })
  return { elements, files, elementIdMap: Object.fromEntries(elementIds), fileIdMap: Object.fromEntries(fileIds), uploadedAttachments }
}
