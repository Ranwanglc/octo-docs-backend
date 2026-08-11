/** HMAC-authenticated delete bridge for the HTML service. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Request, Response } from 'express'
import { config } from '../../config/env.js'
import { docMetaRepo, type DocMeta } from '../../db/repos/docMetaRepo.js'
import { resolveRole } from '../../permission/resolveRole.js'
import { refreshAndPublish } from '../../permission/epoch.js'

export const HTML_DELEGATED_DELETE_PATH = '/v1/internal/html-docs'
const MAX_SKEW_SECONDS = 300

export function verifyHtmlDelegationSignature(body: Buffer, method: string, path: string, timestamp: string, signature: string, secret: string, nowSeconds: number): boolean {
  if (Buffer.byteLength(secret, 'utf8') < 32 || !/^\d+$/.test(timestamp) || !/^v1=[0-9a-f]{64}$/.test(signature)) return false
  const sentAt = Number(timestamp)
  if (!Number.isSafeInteger(sentAt) || Math.abs(nowSeconds - sentAt) > MAX_SKEW_SECONDS) return false
  const bodyHash = createHash('sha256').update(body).digest('hex')
  const expected = createHmac('sha256', secret).update(['v1', method, path, timestamp, bodyHash].join('\n')).digest()
  const provided = Buffer.from(signature.slice(3), 'hex')
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

interface DeleteAssertion { slug: string; docId?: string; actorUid: string; superAdmin: boolean }
function parseAssertion(raw: Buffer): DeleteAssertion | null {
  let value: unknown
  try { value = JSON.parse(raw.toString('utf8')) } catch { return null }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (Object.keys(v).some((key) => !['slug', 'docId', 'actorUid', 'superAdmin'].includes(key))) return null
  if (typeof v.slug !== 'string' || v.slug === '' || v.slug.length > 255) return null
  if (v.docId !== undefined && (typeof v.docId !== 'string' || v.docId === '' || v.docId.length > 255)) return null
  if (typeof v.actorUid !== 'string' || v.actorUid === '' || v.actorUid.length > 255 || typeof v.superAdmin !== 'boolean') return null
  return v as unknown as DeleteAssertion
}
function validCanonical(meta: DocMeta, a: DeleteAssertion): boolean {
  return meta.html_idempotency_key_hash !== null && meta.doc_id === a.docId && meta.octo_doc_slug === a.docId && a.slug === a.docId
}

export async function htmlDelegatedDeleteHandler(req: Request, res: Response): Promise<void> {
  const secret = config.htmlDelegationSecret
  if (secret === '') { res.status(503).json({ error: 'delegation_unavailable' }); return }
  if (!Buffer.isBuffer(req.body)) { res.status(401).json({ error: 'invalid_signature' }); return }
  if (!verifyHtmlDelegationSignature(req.body, req.method, HTML_DELEGATED_DELETE_PATH, req.get('X-Octo-Timestamp') ?? '', req.get('X-Octo-Signature') ?? '', secret, Math.floor(Date.now() / 1000))) {
    res.status(401).json({ error: 'invalid_signature' }); return
  }
  const assertion = parseAssertion(req.body)
  if (!assertion) { res.status(400).json({ error: 'invalid_body' }); return }
  let meta: DocMeta
  if (assertion.docId !== undefined) {
    const found = await docMetaRepo.getByDocId(assertion.docId)
    if (!found) { res.status(404).json({ error: 'not_found' }); return }
    if (found.doc_type !== 'html') { res.status(400).json({ error: 'not_html' }); return }
    if (!validCanonical(found, assertion)) { res.status(409).json({ error: 'canonical_mismatch' }); return }
    meta = found
  } else {
    const matches = await docMetaRepo.findHtmlBySlug(assertion.slug)
    if (matches.length > 1) { res.status(409).json({ error: 'ambiguous_slug' }); return }
    if (matches.length === 0) {
      if (assertion.superAdmin) res.status(204).end()
      else res.status(404).json({ error: 'not_found' })
      return
    }
    meta = matches[0]!
    // Omitting docId is strictly a compatibility path for rows created before
    // canonical HTML registration. Never allow it to address a canonical row,
    // even when slug and doc_id happen to match.
    if (meta.html_idempotency_key_hash !== null) { res.status(409).json({ error: 'canonical_mismatch' }); return }
    if (meta.doc_type !== 'html') { res.status(400).json({ error: 'not_html' }); return }
  }
  if (meta.status === 2) { res.status(409).json({ error: 'archived' }); return }
  if (!assertion.superAdmin && await resolveRole(assertion.actorUid, meta.doc_id) !== 'admin') { res.status(403).json({ error: 'forbidden' }); return }
  if (meta.status === 0) { res.status(204).end(); return }
  if (meta.status !== 1) { res.status(409).json({ error: 'invalid_status' }); return }
  const deleted = await docMetaRepo.softDeleteActive(meta.doc_id)
  if (deleted) {
    await refreshAndPublish(deleted.documentName, deleted.permissionEpoch)
  } else {
    // The status may have changed after the initial authorization/status read.
    // A concurrent delete is idempotent, but archive (or any other state) is a
    // conflict rather than an unconditional success.
    const current = await docMetaRepo.getByDocId(meta.doc_id)
    if (current?.status === 0) { res.status(204).end(); return }
    if (current?.status === 2) { res.status(409).json({ error: 'archived' }); return }
    res.status(409).json({ error: 'invalid_status' }); return
  }
  res.status(204).end()
}
