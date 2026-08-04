import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/db/repos/docAttachmentRepo.js', () => ({
  docAttachmentRepo: { register: vi.fn(), getById: vi.fn() },
}))
const objectUpload = vi.fn(async () => undefined)
vi.mock('../src/storage/objectStore.js', () => ({
  getObjectStore: () => ({
    presignPut: () => ({ uploadUrl: 'https://storage.test/upload', headers: {} }),
    presignGet: () => 'https://storage.test/read',
    upload: objectUpload,
  }),
}))

import { svgUploadHandler } from '../src/api/routes/attachments.js'
import { requireDocRole } from '../src/api/guard.js'
import { docAttachmentRepo } from '../src/db/repos/docAttachmentRepo.js'

interface MockRes {
  statusCode: number
  body: unknown
  status(code: number): MockRes
  json(body: unknown): MockRes
}

function response(): MockRes {
  return {
    statusCode: 0,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

function request(svg: string, headers: Record<string, string> = {}) {
  const stream = Readable.from([Buffer.from(svg)]) as Readable & Record<string, unknown>
  stream.uid = 'u_writer'
  stream.spaceId = 's1'
  stream.params = { docId: 'd_1' }
  stream.headers = headers
  return stream as never
}

beforeEach(() => {
  vi.restoreAllMocks()
  objectUpload.mockReset()
  objectUpload.mockResolvedValue(undefined)
  vi.mocked(requireDocRole).mockResolvedValue({ meta: { doc_id: 'd_1' }, role: 'writer' } as never)
  vi.mocked(docAttachmentRepo.register).mockResolvedValue(undefined as never)
  vi.mocked(docAttachmentRepo.getById).mockImplementation(async (attachId: string) => ({
    attachId,
    docId: 'd_1',
    objectKey: `d_1/${attachId}/logo.svg`,
    mime: 'image/svg+xml',
    sizeBytes: 1,
    fileName: 'logo.svg',
    createdBy: 'u_writer',
    createdAt: new Date(0),
  }))
})

describe('POST sanitized SVG attachment', () => {
  it('uploads only sanitized bytes and registers the sanitized size', async () => {
    let uploaded: Uint8Array | undefined
    objectUpload.mockImplementation(async (_key: string, _mime: string, body: Uint8Array) => {
      uploaded = body
    })
    const res = response()
    await svgUploadHandler(request(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><path d="M0 0h1v1z"/></svg>',
      { 'x-file-name': encodeURIComponent('../../logo.svg') },
    ), res as never)

    expect(res.statusCode).toBe(201)
    const uploadedText = Buffer.from(uploaded!).toString('utf8')
    expect(uploadedText).toContain('<path')
    expect(uploadedText).not.toMatch(/script|onload/i)
    expect(docAttachmentRepo.register).toHaveBeenCalledWith(expect.objectContaining({
      docId: 'd_1', mime: 'image/svg+xml', fileName: 'logo.svg', sizeBytes: Buffer.byteLength(uploadedText),
    }))
  })

  it('rejects active XML without touching storage', async () => {
    const res = response()
    await svgUploadHandler(request(
      '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>',
    ), res as never)

    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_svg' })
    expect(objectUpload).not.toHaveBeenCalled()
    expect(docAttachmentRepo.register).not.toHaveBeenCalled()
  })
})
