import { createHash, createHmac } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'

vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: {
    getByDocId: vi.fn(),
    findHtmlBySlug: vi.fn(),
    softDelete: vi.fn(),
    softDeleteActive: vi.fn(),
  },
}))
vi.mock('../src/permission/resolveRole.js', () => ({ resolveRole: vi.fn() }))
vi.mock('../src/permission/epoch.js', () => ({ refreshAndPublish: vi.fn() }))

import { config, resolveHtmlDelegationSecret } from '../src/config/env.js'
import { docMetaRepo, type DocMeta } from '../src/db/repos/docMetaRepo.js'
import { resolveRole } from '../src/permission/resolveRole.js'
import { refreshAndPublish } from '../src/permission/epoch.js'
import { createApp } from '../src/api/app.js'
import {
  HTML_DELEGATED_DELETE_PATH,
  htmlDelegatedDeleteHandler,
  verifyHtmlDelegationSignature,
} from '../src/api/routes/htmlDelegatedDelete.js'

const SECRET = '*'.repeat(32)
const NOW = 1_700_000_000
const canonical = (extra: Partial<DocMeta> = {}): DocMeta => ({
  doc_id: 'd1', document_name: 'octo:s:f:html:d1', title: 'x', owner_id: 'owner', space_id: 's', folder_id: 'f',
  doc_type: 'html', octo_doc_slug: 'd1', html_idempotency_key_hash: Buffer.alloc(32, 1), status: 1,
  permission_epoch: 4, share_scope: 0, share_role: 1, created_at: new Date(), updated_at: new Date(),
  created_by: 'owner', updated_by: '', ...extra,
})

function signed(raw: Buffer, timestamp = String(NOW), secret = SECRET): string {
  const digest = createHash('sha256').update(raw).digest('hex')
  const message = ['v1', 'DELETE', HTML_DELEGATED_DELETE_PATH, timestamp, digest].join('\n')
  return `v1=${createHmac('sha256', secret).update(message).digest('hex')}`
}
function req(body: object, options: { timestamp?: string; signature?: string; raw?: Buffer } = {}): Request {
  const raw = options.raw ?? Buffer.from(JSON.stringify(body))
  return {
    method: 'DELETE', path: HTML_DELEGATED_DELETE_PATH, body: raw,
    get(name: string) {
      if (name.toLowerCase() === 'x-octo-timestamp') return options.timestamp ?? String(NOW)
      if (name.toLowerCase() === 'x-octo-signature') return options.signature ?? signed(raw, options.timestamp)
      return undefined
    },
  } as unknown as Request
}
function res() {
  return {
    statusCode: 200, payload: undefined as unknown,
    status(code: number) { this.statusCode = code; return this },
    json(value: unknown) { this.payload = value; return this },
    end() { return this },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  config.htmlDelegationSecret = SECRET
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000)
  vi.mocked(resolveRole).mockResolvedValue('admin')
  vi.mocked(docMetaRepo.softDeleteActive).mockResolvedValue({ documentName: 'octo:s:f:html:d1', permissionEpoch: 5 })
})
afterEach(() => vi.restoreAllMocks())

describe('HTML delegated delete HMAC', () => {
  it('requires at least 32 bytes for every configured delegation secret', () => {
    expect(resolveHtmlDelegationSecret('')).toBe('')
    expect(() => resolveHtmlDelegationSecret('too-short')).toThrow(/at least 32 bytes/)
    expect(resolveHtmlDelegationSecret(SECRET)).toBe(SECRET)
  })

  it('binds exact body, method and path and rejects invalid, expired, or malformed signatures in constant-time verifier', () => {
    const raw = Buffer.from('{"slug":"d1","docId":"d1","actorUid":"u","superAdmin":false}')
    const sig = signed(raw)
    expect(verifyHtmlDelegationSignature(raw, 'DELETE', HTML_DELEGATED_DELETE_PATH, String(NOW), sig, SECRET, NOW)).toBe(true)
    expect(verifyHtmlDelegationSignature(Buffer.from(`${raw} `), 'DELETE', HTML_DELEGATED_DELETE_PATH, String(NOW), sig, SECRET, NOW)).toBe(false)
    expect(verifyHtmlDelegationSignature(raw, 'POST', HTML_DELEGATED_DELETE_PATH, String(NOW), sig, SECRET, NOW)).toBe(false)
    expect(verifyHtmlDelegationSignature(raw, 'DELETE', '/other', String(NOW), sig, SECRET, NOW)).toBe(false)
    expect(verifyHtmlDelegationSignature(raw, 'DELETE', HTML_DELEGATED_DELETE_PATH, String(NOW - 301), signed(raw, String(NOW - 301)), SECRET, NOW)).toBe(false)
    expect(verifyHtmlDelegationSignature(raw, 'DELETE', HTML_DELEGATED_DELETE_PATH, String(NOW), 'bad', SECRET, NOW)).toBe(false)
  })

  it('fails closed when the secret is absent and ordinary auth headers cannot bypass HMAC', async () => {
    config.htmlDelegationSecret = ''
    const response = res()
    const request = req({ slug: 'd1', docId: 'd1', actorUid: 'u', superAdmin: false }, { signature: 'bad' })
    ;(request as unknown as { headers: object }).headers = { authorization: 'Bearer human', 'x-bot-token': 'bot' }
    await htmlDelegatedDeleteHandler(request, response as unknown as Response)
    expect(response.statusCode).toBe(503)
    expect(docMetaRepo.getByDocId).not.toHaveBeenCalled()

    config.htmlDelegationSecret = SECRET
    const bypass = res()
    await htmlDelegatedDeleteHandler(request, bypass as unknown as Response)
    expect(bypass.statusCode).toBe(401)
    expect(docMetaRepo.getByDocId).not.toHaveBeenCalled()
  })

  it('rejects expired signatures and exact-body mutation before parsing or DB access', async () => {
    const body = { slug: 'd1', docId: 'd1', actorUid: 'u', superAdmin: true }
    const raw = Buffer.from(JSON.stringify(body))
    const expiredAt = String(NOW - 301)
    const expired = res()
    await htmlDelegatedDeleteHandler(req(body, { timestamp: expiredAt, signature: signed(raw, expiredAt), raw }), expired as unknown as Response)
    expect(expired.statusCode).toBe(401)

    const mutated = Buffer.from(`${raw.toString('utf8')} `)
    const changed = res()
    await htmlDelegatedDeleteHandler(req(body, { raw: mutated, signature: signed(raw) }), changed as unknown as Response)
    expect(changed.statusCode).toBe(401)
    expect(docMetaRepo.getByDocId).not.toHaveBeenCalled()
  })
})

describe('HTML delegated delete authorization and identity', () => {
  it('re-authorizes a signed actor as current admin and deletes + refreshes exactly once', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(canonical())
    const response = res()
    await htmlDelegatedDeleteHandler(req({ slug: 'd1', docId: 'd1', actorUid: 'admin', superAdmin: false }), response as unknown as Response)
    expect(resolveRole).toHaveBeenCalledWith('admin', 'd1')
    expect(docMetaRepo.softDeleteActive).toHaveBeenCalledTimes(1)
    expect(refreshAndPublish).toHaveBeenCalledWith('octo:s:f:html:d1', 5)
    expect(response.statusCode).toBe(204)
  })

  it('forbids non-admin but permits a signed superAdmin without doc-role lookup', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(canonical())
    vi.mocked(resolveRole).mockResolvedValue('writer')
    const denied = res()
    await htmlDelegatedDeleteHandler(req({ slug: 'd1', docId: 'd1', actorUid: 'writer', superAdmin: false }), denied as unknown as Response)
    expect(denied.statusCode).toBe(403)
    vi.clearAllMocks()
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(canonical())
    vi.mocked(docMetaRepo.softDeleteActive).mockResolvedValue({ documentName: 'n', permissionEpoch: 8 })
    const allowed = res()
    await htmlDelegatedDeleteHandler(req({ slug: 'd1', docId: 'd1', actorUid: 'root', superAdmin: true }), allowed as unknown as Response)
    expect(resolveRole).not.toHaveBeenCalled()
    expect(allowed.statusCode).toBe(204)
  })

  it('rejects canonical mismatches, non-HTML and archived rows', async () => {
    for (const [row, status] of [
      [canonical({ octo_doc_slug: 'other' }), 409],
      [canonical({ html_idempotency_key_hash: null }), 409],
      [canonical({ doc_type: 'doc' }), 400],
      [canonical({ status: 2 }), 409],
    ] as const) {
      vi.mocked(docMetaRepo.getByDocId).mockResolvedValueOnce(row)
      const response = res()
      await htmlDelegatedDeleteHandler(req({ slug: 'd1', docId: 'd1', actorUid: 'u', superAdmin: true }), response as unknown as Response)
      expect(response.statusCode).toBe(status)
    }
    expect(docMetaRepo.softDeleteActive).not.toHaveBeenCalled()
  })

  it('returns idempotent 204 for the same deleted canonical target without epoch bump', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(canonical({ status: 0 }))
    const response = res()
    await htmlDelegatedDeleteHandler(req({ slug: 'd1', docId: 'd1', actorUid: 'u', superAdmin: true }), response as unknown as Response)
    expect(response.statusCode).toBe(204)
    expect(docMetaRepo.softDeleteActive).not.toHaveBeenCalled()
    expect(refreshAndPublish).not.toHaveBeenCalled()
  })

  it('resolves legacy slug safely: ambiguity conflicts, one row authorizes, absent is only idempotent for superAdmin', async () => {
    const legacy = canonical({ doc_id: 'legacy', octo_doc_slug: 'old', html_idempotency_key_hash: null })
    vi.mocked(docMetaRepo.findHtmlBySlug).mockResolvedValueOnce([legacy, canonical({ doc_id: 'other' })])
    const ambiguous = res()
    await htmlDelegatedDeleteHandler(req({ slug: 'old', actorUid: 'u', superAdmin: true }), ambiguous as unknown as Response)
    expect(ambiguous.statusCode).toBe(409)
    expect(docMetaRepo.softDeleteActive).not.toHaveBeenCalled()

    vi.mocked(docMetaRepo.findHtmlBySlug).mockResolvedValueOnce([])
    const absentUser = res()
    await htmlDelegatedDeleteHandler(req({ slug: 'missing', actorUid: 'u', superAdmin: false }), absentUser as unknown as Response)
    expect(absentUser.statusCode).toBe(404)
    vi.mocked(docMetaRepo.findHtmlBySlug).mockResolvedValueOnce([])
    const absentRoot = res()
    await htmlDelegatedDeleteHandler(req({ slug: 'missing', actorUid: 'root', superAdmin: true }), absentRoot as unknown as Response)
    expect(absentRoot.statusCode).toBe(204)

    vi.mocked(docMetaRepo.findHtmlBySlug).mockResolvedValueOnce([legacy])
    vi.mocked(resolveRole).mockResolvedValue('admin')
    const one = res()
    await htmlDelegatedDeleteHandler(req({ slug: 'old', actorUid: 'admin', superAdmin: false }), one as unknown as Response)
    expect(resolveRole).toHaveBeenCalledWith('admin', 'legacy')
    expect(one.statusCode).toBe(204)
  })

  it('rejects every canonical row reached through the docId-omitted legacy branch', async () => {
    vi.mocked(docMetaRepo.findHtmlBySlug).mockResolvedValueOnce([canonical()])
    const response = res()
    await htmlDelegatedDeleteHandler(req({ slug: 'd1', actorUid: 'root', superAdmin: true }), response as unknown as Response)
    expect(response.statusCode).toBe(409)
    expect(response.payload).toEqual({ error: 'canonical_mismatch' })
    expect(resolveRole).not.toHaveBeenCalled()
    expect(docMetaRepo.softDeleteActive).not.toHaveBeenCalled()
  })

  it.each([
    [0, 204, undefined],
    [2, 409, { error: 'archived' }],
    [3, 409, { error: 'invalid_status' }],
  ] as const)('rechecks a soft-delete CAS miss at status %s', async (status, expectedStatus, expectedPayload) => {
    vi.mocked(docMetaRepo.getByDocId)
      .mockResolvedValueOnce(canonical())
      .mockResolvedValueOnce(canonical({ status }))
    vi.mocked(docMetaRepo.softDeleteActive).mockResolvedValueOnce(null)
    const response = res()
    await htmlDelegatedDeleteHandler(req({ slug: 'd1', docId: 'd1', actorUid: 'root', superAdmin: true }), response as unknown as Response)
    expect(docMetaRepo.getByDocId).toHaveBeenCalledTimes(2)
    expect(response.statusCode).toBe(expectedStatus)
    expect(response.payload).toEqual(expectedPayload)
    expect(refreshAndPublish).not.toHaveBeenCalled()
  })

  it('rejects a legacy slug that resolves to a non-HTML row', async () => {
    vi.mocked(docMetaRepo.findHtmlBySlug).mockResolvedValueOnce([canonical({ doc_type: 'html_ppt', html_idempotency_key_hash: null })])
    const response = res()
    await htmlDelegatedDeleteHandler(req({ slug: 'd1', actorUid: 'root', superAdmin: true }), response as unknown as Response)
    expect(response.statusCode).toBe(400)
    expect(docMetaRepo.softDeleteActive).not.toHaveBeenCalled()
  })
})

describe('DELETE /v1/internal/html-docs real Express mount', () => {
  let server: Server
  let base: string

  beforeEach(async () => {
    const app = createApp({ rateLimit: { max: 100, windowMs: 60_000 } })
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  })

  it('captures exact JSON bytes before global parsing and enforces the 4 KiB cap', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(canonical())
    const raw = Buffer.from(JSON.stringify({ slug: 'd1', docId: 'd1', actorUid: 'root', superAdmin: true }))
    const ok = await fetch(`${base}${HTML_DELEGATED_DELETE_PATH}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', 'x-octo-timestamp': String(NOW), 'x-octo-signature': signed(raw) },
      body: raw,
    })
    expect(ok.status).toBe(204)
    const tooLarge = Buffer.alloc(4097, 0x20)
    const rejected = await fetch(`${base}${HTML_DELEGATED_DELETE_PATH}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', 'x-octo-timestamp': String(NOW), 'x-octo-signature': signed(tooLarge) },
      body: tooLarge,
    })
    expect(rejected.status).toBe(413)
  })
})
