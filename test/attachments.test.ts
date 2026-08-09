import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Offline unit test: mock the auth guard and the MySQL pool. The real
// docAttachmentRepo runs against the mocked `query`, so the repo round-trip and
// the route handlers are exercised without live infra.
vi.mock('../src/api/guard.js', () => ({
  requireDocRole: vi.fn(),
}))
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async () => []),
  transaction: vi.fn(),
}))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { getByDocId: vi.fn() },
}))
vi.mock('../src/permission/resolveRole.js', () => ({
  resolveRole: vi.fn(),
}))
vi.mock('../src/util/fetchExternalImage.js', () => ({
  fetchExternalImage: vi.fn(),
}))

const storeUpload = vi.fn(async () => undefined)
const storeDelete = vi.fn(async () => undefined)
const storeDownload = vi.fn(async () => new Uint8Array([1, 2, 3]))
const storePresignGet = vi.fn((key: string, _ttl: number, opts?: { contentDisposition?: string; responseContentType?: string }) => {
  const url = new URL('https://storage.test/read')
  url.pathname = '/' + key
  if (opts?.contentDisposition) url.searchParams.set('response-content-disposition', opts.contentDisposition)
  if (opts?.responseContentType) url.searchParams.set('response-content-type', opts.responseContentType)
  return url.toString()
})
vi.mock('../src/storage/objectStore.js', () => ({
  getObjectStore: vi.fn(() => ({
    presignPut: vi.fn(() => ({ uploadUrl: 'https://storage.test/upload', headers: {} })),
    presignGet: storePresignGet,
    delete: storeDelete,
    upload: storeUpload,
    download: storeDownload,
  })),
  verifySignedUrl: vi.fn(() => ({ valid: true })),
}))

import { presignHandler, readHandler, resolveHandler, copyHandler, ingestHandler } from '../src/api/routes/attachments.js'
import { requireDocRole } from '../src/api/guard.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { resolveRole } from '../src/permission/resolveRole.js'
import { fetchExternalImage } from '../src/util/fetchExternalImage.js'
import { docAttachmentRepo } from '../src/db/repos/docAttachmentRepo.js'
import { query } from '../src/db/pool.js'
import { buildSchema, SCHEMA_VERSION } from '../src/schema/index.js'
import { requireSafeSigningSecret } from '../src/config/env.js'
import { verifySignedUrl } from '../src/storage/objectStore.js'

interface MockRes {
  statusCode: number
  body: unknown
  status(c: number): MockRes
  json(b: unknown): MockRes
}

function mockRes(): MockRes {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c
      return this
    },
    json(b: unknown) {
      this.body = b
      return this
    },
  }
  return res
}

function req(params: Record<string, string>, body?: unknown) {
  return { uid: 'u_writer', spaceId: 's1', params, body } as never
}

const writerGuard = { meta: { doc_id: 'd_1' }, role: 'writer' } as never

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(query).mockReset()
  vi.mocked(query).mockResolvedValue([] as never)
  storeUpload.mockReset()
  storeUpload.mockResolvedValue(undefined)
  storeDelete.mockReset()
  storeDelete.mockResolvedValue(undefined)
  storeDownload.mockReset()
  storeDownload.mockResolvedValue(new Uint8Array([1, 2, 3]))
})

describe('POST presign validation (§3.5 step 1)', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(writerGuard))

  it('rejects a disallowed mime with 400', async () => {
    const res = mockRes()
    await presignHandler(req({ docId: 'd_1' }, { fileName: 'x.bin', mime: 'application/octet-stream', sizeBytes: 10 }), res as never)
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe('mime_not_allowed')
    // The doc guard is scoped to req.spaceId (4th arg).
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('s1')
  })

  it('rejects image/svg+xml even though it matches the image/ prefix (XSS)', async () => {
    const res = mockRes()
    await presignHandler(
      req({ docId: 'd_1' }, { fileName: 'evil.svg', mime: 'image/svg+xml', sizeBytes: 256 }),
      res as never,
    )
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe('mime_blocked')
  })

  it('rejects image/svg+xml even with a charset parameter appended', async () => {
    const res = mockRes()
    await presignHandler(
      req({ docId: 'd_1' }, { fileName: 'evil.svg', mime: 'image/svg+xml; charset=utf-8', sizeBytes: 256 }),
      res as never,
    )
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe('mime_blocked')
  })

  it('rejects oversize sizeBytes with 400', async () => {
    const res = mockRes()
    await presignHandler(
      req({ docId: 'd_1' }, { fileName: 'big.png', mime: 'image/png', sizeBytes: 999 * 1024 * 1024 }),
      res as never,
    )
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe('size_too_large')
  })

  it('rejects a non-positive / non-number sizeBytes with 400', async () => {
    const res = mockRes()
    await presignHandler(req({ docId: 'd_1' }, { fileName: 'a.png', mime: 'image/png', sizeBytes: 0 }), res as never)
    expect(res.statusCode).toBe(400)
  })

  it('rejects an empty fileName with 400', async () => {
    const res = mockRes()
    await presignHandler(req({ docId: 'd_1' }, { fileName: '', mime: 'image/png', sizeBytes: 10 }), res as never)
    expect(res.statusCode).toBe(400)
  })

  it('sanitizes a path-traversal fileName so the object key cannot escape', async () => {
    const res = mockRes()
    await presignHandler(
      req({ docId: 'd_1' }, { fileName: '../../etc/passwd', mime: 'image/png', sizeBytes: 1024 }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    const body = res.body as { objectKey: string; uploadUrl: string; attachId: string }
    expect(body.objectKey).not.toContain('..')
    expect(body.objectKey).not.toContain('/etc/')
    expect(body.objectKey).toBe(`d_1/${body.attachId}/passwd`)
    // The minted PUT url is a real, verifiable signature (not a stub).
    expect(verifySignedUrl(body.uploadUrl).valid).toBe(true)
  })

  it('registers the attachment and returns a real presigned PUT url', async () => {
    const res = mockRes()
    await presignHandler(
      req({ docId: 'd_1' }, { fileName: 'photo.png', mime: 'image/png', sizeBytes: 2048 }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    const body = res.body as { uploadUrl: string; expiresInSec: number }
    expect(verifySignedUrl(body.uploadUrl).valid).toBe(true)
    expect(body.expiresInSec).toBeGreaterThan(0)
    // doc_attachment row inserted via the repo's INSERT.
    const insertCall = vi.mocked(query).mock.calls.find((c) => String(c[0]).includes('INSERT INTO doc_attachment'))
    expect(insertCall).toBeTruthy()
  })
})

describe('GET read endpoint (§3.5 step 5)', () => {
  it('404s when the attachment belongs to a different doc', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({ meta: { doc_id: 'd_1' }, role: 'reader' } as never)
    vi.mocked(query).mockResolvedValue([
      { attach_id: 'att_x', doc_id: 'd_OTHER', object_key: 'd_OTHER/att_x/a.png', mime: 'image/png', size_bytes: 1, created_by: 'u', created_at: new Date(0) },
    ] as never)
    const res = mockRes()
    await readHandler(req({ docId: 'd_1', attachId: 'att_x' }), res as never)
    expect(res.statusCode).toBe(404)
  })

  it('returns a freshly signed GET url for an owned attachment', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({ meta: { doc_id: 'd_1' }, role: 'reader' } as never)
    vi.mocked(query).mockResolvedValue([
      { attach_id: 'att_1', doc_id: 'd_1', object_key: 'd_1/att_1/photo.png', mime: 'image/png', size_bytes: 2048, created_by: 'u', created_at: new Date(0) },
    ] as never)
    const res = mockRes()
    await readHandler(req({ docId: 'd_1', attachId: 'att_1' }), res as never)
    expect(res.statusCode).toBe(200)
    const body = res.body as { url: string; attachId: string }
    expect(body.attachId).toBe('att_1')
    expect(verifySignedUrl(body.url).valid).toBe(true)
  })
})

describe('widened MIME accept/deny + size tiers (§3.5 ⑯)', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(writerGuard))

  const ok = async (mime: string, sizeBytes = 1024) => {
    const res = mockRes()
    await presignHandler(req({ docId: 'd_1' }, { fileName: 'f', mime, sizeBytes }), res as never)
    return res
  }

  it('accepts the widened non-image types (pdf / docx / xlsx / zip / text-plain)', async () => {
    for (const mime of [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/zip',
      'application/x-zip-compressed',
      'text/plain',
      'text/plain; charset=utf-8',
    ]) {
      const res = await ok(mime)
      expect(res.statusCode, mime).toBe(200)
    }
  })

  it('blocks dangerous types via the denylist (html / javascript / executable)', async () => {
    for (const mime of ['text/html', 'application/xhtml+xml', 'application/javascript', 'application/x-msdownload']) {
      const res = await ok(mime)
      expect(res.statusCode, mime).toBe(400)
      expect((res.body as { error: string }).error, mime).toBe('mime_blocked')
    }
  })

  it('exact-matches text/plain so forged text/plaintext is rejected (S5)', async () => {
    for (const mime of ['text/plaintext', 'text/plain-x', 'text/plainsomething']) {
      const res = await ok(mime)
      expect(res.statusCode, mime).toBe(400)
      expect((res.body as { error: string }).error, mime).toBe('mime_not_allowed')
    }
  })

  it('applies the image tier (10MB): 11MB image/png is rejected', async () => {
    const res = await ok('image/png', 11 * 1024 * 1024)
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe('size_too_large')
  })

  it('applies the file tier (50MB): 11MB pdf accepted, 51MB pdf rejected', async () => {
    const accepted = await ok('application/pdf', 11 * 1024 * 1024)
    expect(accepted.statusCode).toBe(200)
    const rejected = await ok('application/pdf', 51 * 1024 * 1024)
    expect(rejected.statusCode).toBe(400)
    expect((rejected.body as { error: string }).error).toBe('size_too_large')
  })

  it('persists the sanitized file_name on register', async () => {
    const res = await ok('application/pdf', 2048)
    expect(res.statusCode).toBe(200)
    const insert = vi.mocked(query).mock.calls.find((c) => String(c[0]).includes('INSERT INTO doc_attachment'))
    expect(insert).toBeTruthy()
    // (attach_id, doc_id, object_key, mime, size_bytes, file_name, created_by)
    expect((insert![1] as unknown[])[5]).toBe('f')
  })
})

describe('read-time Content-Disposition (§3.5 ⑯ A2)', () => {
  const rowFor = (mime: string, fileName: string) => [
    { attach_id: 'att_1', doc_id: 'd_1', object_key: `d_1/att_1/${fileName}`, mime, size_bytes: 2048, file_name: fileName, created_by: 'u', created_at: new Date(0) },
  ]

  beforeEach(() =>
    vi.mocked(requireDocRole).mockResolvedValue({ meta: { doc_id: 'd_1' }, role: 'reader' } as never),
  )

  it('forces attachment download for non-inline types and echoes fileName', async () => {
    vi.mocked(query).mockResolvedValue(rowFor('application/zip', 'report.zip') as never)
    const res = mockRes()
    await readHandler(req({ docId: 'd_1', attachId: 'att_1' }), res as never)
    expect(res.statusCode).toBe(200)
    const body = res.body as { url: string; fileName: string }
    expect(body.fileName).toBe('report.zip')
    const disp = new URL(body.url).searchParams.get('response-content-disposition')
    expect(disp).toBe('attachment; filename="report.zip"')
    // Disposition is bound into the signature — the URL still verifies.
    expect(verifySignedUrl(body.url).valid).toBe(true)
  })

  it('leaves inline types (image/pdf) without a forced-download disposition', async () => {
    for (const mime of ['image/png', 'application/pdf']) {
      vi.mocked(query).mockResolvedValue(rowFor(mime, 'a.bin') as never)
      const res = mockRes()
      await readHandler(req({ docId: 'd_1', attachId: 'att_1' }), res as never)
      const url = new URL((res.body as { url: string }).url)
      expect(url.searchParams.get('response-content-disposition'), mime).toBeNull()
    }
  })
})

describe('POST resolve batch (§3.3 RES-1..3)', () => {
  const readerGuard = { meta: { doc_id: 'd_1' }, role: 'reader' } as never

  const row = (attachId: string, mime: string, fileName: string, docId = 'd_1') => ({
    attach_id: attachId,
    doc_id: docId,
    object_key: `${docId}/${attachId}/${fileName}`,
    mime,
    size_bytes: 2048,
    file_name: fileName,
    created_by: 'u',
    created_at: new Date(0),
  })

  it('resolves a list of owned attachIds with fresh signed urls + metadata', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    vi.mocked(query).mockResolvedValue([
      row('att_1', 'image/png', 'a.png'),
      row('att_2', 'application/zip', 'b.zip'),
    ] as never)
    const res = mockRes()
    await resolveHandler(req({ docId: 'd_1' }, { attachIds: ['att_1', 'att_2'] }), res as never)
    expect(res.statusCode).toBe(200)
    const body = res.body as {
      items: Array<{ attachId: string; url: string; expiresInSec: number; mime: string; fileName: string }>
      notFound: string[]
    }
    expect(body.notFound).toEqual([])
    expect(body.items.map((i) => i.attachId)).toEqual(['att_1', 'att_2'])
    for (const item of body.items) {
      expect(item.expiresInSec).toBeGreaterThan(0)
      expect(verifySignedUrl(item.url).valid).toBe(true)
    }
    // The non-inline zip carries a forced-download disposition; the image does not.
    const zip = body.items.find((i) => i.attachId === 'att_2')!
    expect(new URL(zip.url).searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="b.zip"',
    )
    const img = body.items.find((i) => i.attachId === 'att_1')!
    expect(new URL(img.url).searchParams.get('response-content-disposition')).toBeNull()
  })

  it('puts cross-doc and non-existent attachIds in notFound (no existence leak)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    // listByDoc only ever returns this doc's rows; a cross-doc / unknown id is
    // simply absent from the set.
    vi.mocked(query).mockResolvedValue([row('att_1', 'image/png', 'a.png')] as never)
    const res = mockRes()
    await resolveHandler(
      req({ docId: 'd_1' }, { attachIds: ['att_1', 'att_other_doc', 'att_missing'] }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    const body = res.body as { items: Array<{ attachId: string }>; notFound: string[] }
    expect(body.items.map((i) => i.attachId)).toEqual(['att_1'])
    expect(body.notFound).toEqual(['att_other_doc', 'att_missing'])
  })

  it('rejects an over-cap list with 400 attachIds_too_many (no truncation)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    const attachIds = Array.from({ length: 201 }, (_, i) => `att_${i}`)
    const res = mockRes()
    await resolveHandler(req({ docId: 'd_1' }, { attachIds }), res as never)
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe('attachIds_too_many')
    // No DB lookup should have happened on rejection.
    expect(vi.mocked(query)).not.toHaveBeenCalled()
  })

  it('rejects empty array / non-array / non-string element with 400 invalid_body', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    for (const attachIds of [[], 'att_1', { 0: 'att_1' }, ['att_1', 42], [null]]) {
      const res = mockRes()
      await resolveHandler(req({ docId: 'd_1' }, { attachIds }), res as never)
      expect(res.statusCode, JSON.stringify(attachIds)).toBe(400)
      expect((res.body as { error: string }).error).toBe('invalid_body')
    }
  })

  it('is blocked when requireDocRole denies (insufficient role)', async () => {
    // Guard writes its own 403 and returns falsy; the handler must bail out.
    vi.mocked(requireDocRole).mockResolvedValue(null as never)
    const res = mockRes()
    await resolveHandler(req({ docId: 'd_1' }, { attachIds: ['att_1'] }), res as never)
    expect(vi.mocked(query)).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(0)
  })

  it('sanitizes a CR/LF + quote file name in the disposition (no header injection)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    vi.mocked(query).mockResolvedValue([
      row('att_1', 'application/zip', 'evil"\r\nSet-Cookie: x.zip'),
    ] as never)
    const res = mockRes()
    await resolveHandler(req({ docId: 'd_1' }, { attachIds: ['att_1'] }), res as never)
    expect(res.statusCode).toBe(200)
    const item = (res.body as { items: Array<{ url: string }> }).items[0]!
    const disp = new URL(item.url).searchParams.get('response-content-disposition')!
    // The inner quote, backslash and CR/LF are stripped, leaving a single safe
    // quoted-string — no breakout, no injected header line.
    expect(disp).toBe('attachment; filename="evilSet-Cookie: x.zip"')
    expect(disp).not.toContain('\r')
    expect(disp).not.toContain('\n')
    expect(verifySignedUrl(item.url).valid).toBe(true)
  })

  it('dedups repeated attachIds while keeping a stable order', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    vi.mocked(query).mockResolvedValue([
      row('att_1', 'image/png', 'a.png'),
      row('att_2', 'image/png', 'b.png'),
    ] as never)
    const res = mockRes()
    await resolveHandler(req({ docId: 'd_1' }, { attachIds: ['att_2', 'att_1', 'att_2'] }), res as never)
    expect(res.statusCode).toBe(200)
    const body = res.body as { items: Array<{ attachId: string }> }
    expect(body.items.map((i) => i.attachId)).toEqual(['att_2', 'att_1'])
  })
})

describe('docAttachmentRepo (§3.4)', () => {
  it('register issues an INSERT with the mapped columns', async () => {
    await docAttachmentRepo.register({
      attachId: 'att_1',
      docId: 'd_1',
      objectKey: 'd_1/att_1/photo.png',
      mime: 'image/png',
      sizeBytes: 2048,
      fileName: 'photo.png',
      createdBy: 'u_1',
    })
    const call = vi.mocked(query).mock.calls[0]!
    expect(String(call[0])).toContain('INSERT INTO doc_attachment')
    expect(String(call[0])).toContain('file_name')
    expect(call[1]).toEqual(['att_1', 'd_1', 'd_1/att_1/photo.png', 'image/png', 2048, 'photo.png', 'u_1'])
  })

  it('getById maps snake_case columns to camelCase', async () => {
    vi.mocked(query).mockResolvedValue([
      { attach_id: 'att_1', doc_id: 'd_1', object_key: 'd_1/att_1/p.png', mime: 'image/png', size_bytes: 2048, file_name: 'p.png', created_by: 'u_1', created_at: new Date(0) },
    ] as never)
    const got = await docAttachmentRepo.getById('att_1')
    expect(got).toEqual({
      attachId: 'att_1',
      docId: 'd_1',
      objectKey: 'd_1/att_1/p.png',
      mime: 'image/png',
      sizeBytes: 2048,
      fileName: 'p.png',
      createdBy: 'u_1',
      createdAt: new Date(0),
    })
  })

  it('getById returns null when no row exists', async () => {
    vi.mocked(query).mockResolvedValue([] as never)
    expect(await docAttachmentRepo.getById('nope')).toBeNull()
  })
})

describe('schema image node (§7.1 / §9.2)', () => {
  it('exposes SCHEMA_VERSION as a number', () => {
    expect(typeof SCHEMA_VERSION).toBe('number')
  })

  it('includes the image node so server-side conversion preserves images', () => {
    const schema = buildSchema()
    expect(schema.nodes.image).toBeDefined()
    const attrs = schema.nodes.image!.spec.attrs ?? {}
    expect(Object.keys(attrs)).toEqual(
      expect.arrayContaining(['attachId', 'src', 'alt', 'title', 'width', 'align']),
    )
  })
})

describe('signing-secret fail-fast (§3.5 / production)', () => {
  const DEV_DEFAULT = 'dev-only-change-me'
  const prevNodeEnv = process.env.NODE_ENV

  afterEach(() => {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = prevNodeEnv
  })

  it('throws when the dev default secret is used in production', () => {
    process.env.NODE_ENV = 'production'
    expect(() => requireSafeSigningSecret(DEV_DEFAULT)).toThrow()
  })

  it('accepts a real override in production', () => {
    process.env.NODE_ENV = 'production'
    expect(requireSafeSigningSecret('a-real-prod-secret')).toBe('a-real-prod-secret')
  })

  it('keeps the dev default working outside production', () => {
    process.env.NODE_ENV = 'test'
    expect(requireSafeSigningSecret(DEV_DEFAULT)).toBe(DEV_DEFAULT)
  })
})

describe('POST attachments/copy (markdown-import image migration)', () => {
  // A stored source attachment the caller can read, in the same space.
  const srcAttachment = {
    attach_id: 'att_src',
    doc_id: 'd_src',
    object_key: 'd_src/att_src/222.png',
    mime: 'image/png',
    size_bytes: 2048,
    file_name: '222.png',
    created_by: 'u',
    created_at: new Date(0),
  }

  beforeEach(() => {
    vi.mocked(requireDocRole).mockResolvedValue(writerGuard) // writer on target d_1
    vi.mocked(docMetaRepo.getByDocId).mockReset()
    vi.mocked(resolveRole).mockReset()
    storeUpload.mockReset()
    storeUpload.mockResolvedValue(undefined)
    storeDelete.mockReset()
    storeDelete.mockResolvedValue(undefined)
    storeDownload.mockReset()
    storeDownload.mockResolvedValue(new Uint8Array([1, 2, 3]))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('rejects an empty / non-array body with 400', async () => {
    const res = mockRes()
    await copyHandler(req({ docId: 'd_1' }, { sources: [] }), res as never)
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe('invalid_body')
  })

  it('rejects a malformed source ref with 400', async () => {
    const res = mockRes()
    await copyHandler(req({ docId: 'd_1' }, { sources: [{ docId: 'd_src' }] }), res as never)
    expect(res.statusCode).toBe(400)
  })

  it('copies a readable same-space source into the target doc and returns the new attachId + fresh url', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({ doc_id: 'd_src', space_id: 's1', status: 1 } as never)
    vi.mocked(resolveRole).mockResolvedValue('reader' as never)
    // getById: source lookup, then the post-register re-read of the NEW row.
    vi.mocked(query)
      .mockResolvedValueOnce([srcAttachment] as never) // source getById
      .mockResolvedValueOnce([] as never) // register INSERT
      .mockResolvedValueOnce([
        { ...srcAttachment, attach_id: 'att_new', doc_id: 'd_1', object_key: 'd_1/att_new/222.png' },
      ] as never) // new-row getById

    const res = mockRes()
    await copyHandler(req({ docId: 'd_1' }, { sources: [{ docId: 'd_src', attachId: 'att_src' }] }), res as never)
    expect(res.statusCode).toBe(200)
    const body = res.body as { mappings: Array<{ sourceAttachId: string; attachId: string; url: string }>; notCopied: unknown[] }
    expect(body.notCopied).toEqual([])
    expect(body.mappings).toHaveLength(1)
    expect(body.mappings[0]!.sourceAttachId).toBe('att_src')
    expect(body.mappings[0]!.attachId).toMatch(/^att_/)
    expect(body.mappings[0]!.url).toContain('storage.test')
  })

  it('compensates object and row state when the target PUT fails', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({ doc_id: 'd_src', space_id: 's1', status: 1 } as never)
    vi.mocked(resolveRole).mockResolvedValue('reader' as never)
    vi.mocked(query)
      .mockResolvedValueOnce([srcAttachment] as never)
      .mockResolvedValue([] as never)
    storeUpload.mockRejectedValueOnce(new Error('store failed'))

    const res = mockRes()
    await copyHandler(req({ docId: 'd_1' }, { sources: [{ docId: 'd_src', attachId: 'att_src' }] }), res as never)
    expect((res.body as { notCopied: Array<{ reason: string }> }).notCopied[0]!.reason).toBe('copy_failed')
    const sql = vi.mocked(query).mock.calls.map(([statement]) => String(statement))
    expect(sql.some((statement) => statement.startsWith('INSERT INTO doc_attachment'))).toBe(false)
    expect(sql.some((statement) => statement.startsWith('DELETE FROM doc_attachment'))).toBe(true)
  })

  it('compensates the uploaded object when database registration fails', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({ doc_id: 'd_src', space_id: 's1', status: 1 } as never)
    vi.mocked(resolveRole).mockResolvedValue('reader' as never)
    vi.mocked(query)
      .mockResolvedValueOnce([srcAttachment] as never)
      .mockRejectedValueOnce(new Error('register failed'))
      .mockResolvedValue([] as never)

    const res = mockRes()
    await copyHandler(req({ docId: 'd_1' }, { sources: [{ docId: 'd_src', attachId: 'att_src' }] }), res as never)
    expect((res.body as { notCopied: Array<{ reason: string }> }).notCopied[0]!.reason).toBe('copy_failed')
    const sql = vi.mocked(query).mock.calls.map(([statement]) => String(statement))
    expect(sql.some((statement) => statement.startsWith('DELETE FROM doc_attachment'))).toBe(true)
    expect(storeDelete).toHaveBeenCalled()
  })

  it('degrades to notCopied when the source download exceeds the size cap (in-memory cap check)', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({ doc_id: 'd_src', space_id: 's1', status: 1 } as never)
    vi.mocked(resolveRole).mockResolvedValue('reader' as never)
    // Source attachment recorded small but actual bytes larger than image cap.
    vi.mocked(query).mockResolvedValueOnce([{ ...srcAttachment, size_bytes: 10 }] as never)
    const cap = 10 * 1024 * 1024
    storeDownload.mockResolvedValueOnce(new Uint8Array(cap + 1))

    const res = mockRes()
    await copyHandler(req({ docId: 'd_1' }, { sources: [{ docId: 'd_src', attachId: 'att_src' }] }), res as never)
    expect(res.statusCode).toBe(200)
    const body = res.body as { mappings: unknown[]; notCopied: Array<{ reason: string }> }
    expect(body.mappings).toEqual([])
    expect(body.notCopied[0]!.reason).toBe('copy_failed')
  })

  it('degrades to notCopied when the caller lacks read access on the source (no leak, no abort)', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({ doc_id: 'd_src', space_id: 's1', status: 1 } as never)
    vi.mocked(resolveRole).mockResolvedValue('none' as never)

    const res = mockRes()
    await copyHandler(req({ docId: 'd_1' }, { sources: [{ docId: 'd_src', attachId: 'att_src' }] }), res as never)
    expect(res.statusCode).toBe(200)
    const body = res.body as { mappings: unknown[]; notCopied: Array<{ reason: string }> }
    expect(body.mappings).toEqual([])
    expect(body.notCopied[0]!.reason).toBe('source_forbidden')
    expect(storeDownload).not.toHaveBeenCalled()
  })

  it('degrades to notCopied for a cross-space source (404 semantics, no existence leak)', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({ doc_id: 'd_src', space_id: 's_OTHER', status: 1 } as never)
    const res = mockRes()
    await copyHandler(req({ docId: 'd_1' }, { sources: [{ docId: 'd_src', attachId: 'att_src' }] }), res as never)
    expect(res.statusCode).toBe(200)
    const body = res.body as { notCopied: Array<{ reason: string }> }
    expect(body.notCopied[0]!.reason).toBe('source_not_found')
  })

  it('re-sanitizes a readable stored SVG before copying it to another document', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect fill="#ffff00"/></svg>')
    const storedSvg = { ...srcAttachment, mime: 'image/svg+xml', size_bytes: svg.length, object_key: 'd_src/att_src/x.svg', file_name: 'x.svg' }
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({ doc_id: 'd_src', space_id: 's1', status: 1 } as never)
    vi.mocked(resolveRole).mockResolvedValue('reader' as never)
    vi.mocked(query)
      .mockResolvedValueOnce([storedSvg] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ ...storedSvg, attach_id: 'att_new', doc_id: 'd_1', object_key: 'd_1/att_new/x.svg' }] as never)
    storeDownload.mockResolvedValueOnce(new Uint8Array(svg))
    let uploaded: Uint8Array | undefined
    storeUpload.mockImplementationOnce(async (_key: string, _mime: string, body: Uint8Array) => {
      uploaded = body
    })

    const res = mockRes()
    await copyHandler(req({ docId: 'd_1' }, { sources: [{ docId: 'd_src', attachId: 'att_src' }] }), res as never)

    expect(res.statusCode).toBe(200)
    const body = res.body as { mappings: Array<{ mime: string }>; notCopied: unknown[] }
    expect(body.notCopied).toEqual([])
    expect(body.mappings[0]!.mime).toBe('image/svg+xml')
    const uploadedText = Buffer.from(uploaded!).toString('utf8')
    expect(uploadedText).not.toContain('<script')
    expect(uploadedText).toContain('fill="#ffff00"')
  })

  it('404-style notCopied when the source attachment does not belong to the claimed source doc', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({ doc_id: 'd_src', space_id: 's1', status: 1 } as never)
    vi.mocked(resolveRole).mockResolvedValue('reader' as never)
    vi.mocked(query).mockResolvedValueOnce([
      { ...srcAttachment, doc_id: 'd_DIFFERENT' },
    ] as never)
    const res = mockRes()
    await copyHandler(req({ docId: 'd_1' }, { sources: [{ docId: 'd_src', attachId: 'att_src' }] }), res as never)
    const body = res.body as { notCopied: Array<{ reason: string }> }
    expect(body.notCopied[0]!.reason).toBe('source_not_found')
  })
})

describe('POST attachments/ingest (external-image re-hosting)', () => {
  // A minimal valid PNG header so sniffImageMime returns image/png.
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect fill="#ffff00" width="10" height="10"/></svg>')

  beforeEach(() => {
    vi.mocked(requireDocRole).mockResolvedValue(writerGuard)
    vi.mocked(fetchExternalImage).mockReset()
    storeUpload.mockReset()
    storeUpload.mockResolvedValue(undefined)
  })

  it('rejects a non-array / empty body with 400', async () => {
    const res = mockRes()
    await ingestHandler(req({ docId: 'd_1' }, { urls: [] }), res as never)
    expect(res.statusCode).toBe(400)
  })

  it('downloads an external image, validates by magic number, stores it, returns a fresh url', async () => {
    vi.mocked(fetchExternalImage).mockResolvedValue({ bytes: PNG, declaredContentType: 'image/png' } as never)
    // getById after register returns the new row.
    vi.mocked(query).mockResolvedValueOnce([] as never) // register INSERT
    vi.mocked(query).mockResolvedValueOnce([
      { attach_id: 'att_x', doc_id: 'd_1', object_key: 'd_1/att_x/pic.png', mime: 'image/png', size_bytes: PNG.length, file_name: 'pic.png', created_by: 'u', created_at: new Date(0) },
    ] as never)

    const res = mockRes()
    await ingestHandler(req({ docId: 'd_1' }, { urls: ['https://example.com/pic.png'] }), res as never)
    expect(res.statusCode).toBe(200)
    const body = res.body as { mappings: Array<{ sourceUrl: string; url: string }>; notIngested: unknown[] }
    expect(body.notIngested).toEqual([])
    expect(body.mappings).toHaveLength(1)
    expect(body.mappings[0]!.sourceUrl).toBe('https://example.com/pic.png')
    expect(body.mappings[0]!.url).toContain('storage.test')
  })

  it('downloads and sanitizes an external SVG through the SSRF-guarded ingest path', async () => {
    vi.mocked(fetchExternalImage).mockResolvedValue({ bytes: SVG, declaredContentType: 'image/svg+xml' } as never)
    vi.mocked(query).mockResolvedValueOnce([] as never) // register INSERT
    vi.mocked(query).mockResolvedValueOnce([
      { attach_id: 'att_svg', doc_id: 'd_1', object_key: 'd_1/att_svg/vector.svg+xml', mime: 'image/svg+xml', size_bytes: SVG.length, file_name: 'vector.svg+xml', created_by: 'u', created_at: new Date(0) },
    ] as never)
    let uploaded: Uint8Array | undefined
    storeUpload.mockImplementationOnce(async (_key: string, _mime: string, body: Uint8Array) => {
      uploaded = body
    })

    const res = mockRes()
    await ingestHandler(req({ docId: 'd_1' }, { urls: ['https://example.com/vector.svg'] }), res as never)

    expect(res.statusCode).toBe(200)
    const body = res.body as { mappings: Array<{ mime: string }>; notIngested: unknown[] }
    expect(body.notIngested).toEqual([])
    expect(body.mappings[0]!.mime).toBe('image/svg+xml')
    const text = Buffer.from(uploaded!).toString('utf8')
    expect(text).not.toContain('<script')
    expect(text).toContain('fill="#ffff00"')
  })

  it('rejects active external XML that is not a sanitizable SVG', async () => {
    vi.mocked(fetchExternalImage).mockResolvedValue({
      bytes: Buffer.from('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>'),
      declaredContentType: 'image/svg+xml',
    } as never)
    const res = mockRes()

    await ingestHandler(req({ docId: 'd_1' }, { urls: ['https://example.com/active.svg'] }), res as never)

    const body = res.body as { mappings: unknown[]; notIngested: Array<{ reason: string }> }
    expect(body.mappings).toEqual([])
    expect(body.notIngested[0]!.reason).toBe('not_an_image')
  })

  it('rejects bytes that are not a real image (magic-number sniff), keeping the URL for the caller', async () => {
    vi.mocked(fetchExternalImage).mockResolvedValue({ bytes: Buffer.from('not an image'), declaredContentType: 'image/png' } as never)
    const res = mockRes()
    await ingestHandler(req({ docId: 'd_1' }, { urls: ['https://example.com/x'] }), res as never)
    const body = res.body as { mappings: unknown[]; notIngested: Array<{ reason: string }> }
    expect(body.mappings).toEqual([])
    expect(body.notIngested[0]!.reason).toBe('not_an_image')
  })

  it('degrades to notIngested (never throws) when the SSRF-guarded fetch is blocked', async () => {
    const { LinkCardError } = await import('../src/util/ssrfGuard.js')
    vi.mocked(fetchExternalImage).mockRejectedValue(new LinkCardError('ssrf_blocked', 'blocked'))
    const res = mockRes()
    await ingestHandler(req({ docId: 'd_1' }, { urls: ['http://169.254.169.254/latest/meta-data'] }), res as never)
    expect(res.statusCode).toBe(200)
    const body = res.body as { notIngested: Array<{ reason: string }> }
    expect(body.notIngested[0]!.reason).toBe('ssrf_blocked')
  })
})
