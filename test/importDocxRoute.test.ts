import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Request, Response } from 'express'

// Offline route test: mock the auth guard, the media/parse layer, and the
// object-store/repo deps so importDocxHandler runs without live infra
// (mirrors docsRoutes.test.ts / attachments.test.ts). We assert the handler
// maps guard/body/parse outcomes to the right status codes.
vi.mock('../src/api/guard.js', () => ({
  requireDocRole: vi.fn(),
}))
vi.mock('../src/import/docx/index.js', () => ({
  importDocxWithMedia: vi.fn(),
}))
vi.mock('../src/util/ids.js', () => ({ newAttachId: vi.fn(() => 'att_test') }))
vi.mock('../src/db/repos/docAttachmentRepo.js', () => ({
  docAttachmentRepo: {
    register: vi.fn(async () => undefined),
    getById: vi.fn(async (attachId: string) => attachId === 'att_test' ? { attachId, objectKey: 'd1/att_test/image.png', docId: 'd1' } : null),
    deleteById: vi.fn(async () => undefined),
  },
}))
const objectDelete = vi.fn(async () => undefined)
const objectUpload = vi.fn(async () => undefined)
vi.mock('../src/storage/objectStore.js', () => ({
  getObjectStore: vi.fn(() => ({
    presignPut: () => ({ uploadUrl: 'http://x', headers: {} }),
    delete: objectDelete,
    upload: objectUpload,
  })),
}))
vi.mock('../src/import/docx/importQueue.js', () => ({
  acquireDocxImportSlot: vi.fn(async () => undefined),
  releaseDocxImportSlot: vi.fn(),
  DocxImportBusyError: class DocxImportBusyError extends Error {},
}))
vi.mock('../src/collab/liveDocWrite.js', () => ({
  readLiveForEdit: vi.fn(),
}))
vi.mock('../src/api/services/editDocBody.js', () => ({
  editDocBody: vi.fn(),
}))

import { importDocxHandler } from '../src/api/routes/import.js'
import { requireDocRole } from '../src/api/guard.js'
import { importDocxWithMedia } from '../src/import/docx/index.js'
import { DocxUnsafeError } from '../src/import/docx/extract.js'
import {
  acquireDocxImportSlot,
  releaseDocxImportSlot,
  DocxImportBusyError,
} from '../src/import/docx/importQueue.js'
import { readLiveForEdit } from '../src/collab/liveDocWrite.js'
import { editDocBody } from '../src/api/services/editDocBody.js'
import { docAttachmentRepo } from '../src/db/repos/docAttachmentRepo.js'

const guard = vi.mocked(requireDocRole)
const parse = vi.mocked(importDocxWithMedia)
const acquire = vi.mocked(acquireDocxImportSlot)
const release = vi.mocked(releaseDocxImportSlot)

interface MockRes {
  statusCode: number
  body: unknown
  status(c: number): MockRes
  json(b: unknown): MockRes
}
function mockRes(): MockRes {
  return {
    statusCode: 0,
    body: undefined,
    status(c: number) {
      this.statusCode = c
      return this
    },
    json(b: unknown) {
      this.body = b
      return this
    },
  }
}
/** Build a minimal Request; only the fields importDocxHandler reads are set. */
function req(body: unknown, headers: Record<string, string> = {}): Request {
  return {
    uid: 'u1',
    spaceId: 's1',
    params: { docId: 'd1' },
    body,
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request
}
/** Read a JSON body field without an `any` cast. */
function field(res: MockRes, key: string): unknown {
  return (res.body as Record<string, unknown> | undefined)?.[key]
}
async function run(res: MockRes, body: unknown): Promise<void> {
  await importDocxHandler(req(body), res as unknown as Response)
}

// requireDocRole resolves to a guard object (writer allowed) or undefined.
const guardOk = {
  meta: { doc_id: 'd1', document_name: 'octo:s:f:d1', doc_type: 'doc', permission_epoch: 0 },
} as unknown as Awaited<ReturnType<typeof requireDocRole>>

beforeEach(() => {
  vi.clearAllMocks()
})

describe('importDocxHandler — status mapping', () => {
  it('400 when the doc id param is not a plain string (type-confusion guard)', async () => {
    const res = mockRes()
    // A crafted request making params.docId an array must be rejected before the guard.
    await importDocxHandler(
      { uid: 'u1', spaceId: 's1', params: { docId: ['a', 'b'] }, body: Buffer.from('PK') } as unknown as Request,
      res as unknown as Response,
    )
    expect(res.statusCode).toBe(400)
    expect(field(res, 'error')).toBe('invalid_doc_id')
    expect(guard).not.toHaveBeenCalled()
  })

  it('stops at the guard (writer default-deny) without parsing', async () => {
    // requireDocRole returns falsy after already writing its own 403/404.
    guard.mockResolvedValue(undefined as unknown as typeof guardOk)
    const res = mockRes()
    await run(res, Buffer.from('PK'))
    expect(parse).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(0) // guard owns the response
  })

  it('rejects a non-document target before parsing or uploading media', async () => {
    guard.mockResolvedValue({
      meta: { ...guardOk.meta, doc_type: 'sheet' },
    } as typeof guardOk)
    const res = mockRes()
    await importDocxHandler(req(Buffer.from('PKzip'), { 'x-octo-import-apply': 'true' }), res as unknown as Response)
    expect(res.statusCode).toBe(409)
    expect(field(res, 'error')).toBe('unsupported_doc_type')
    expect(parse).not.toHaveBeenCalled()
    expect(docAttachmentRepo.register).not.toHaveBeenCalled()
  })

  it('400 when the body is not a Buffer (wrong/absent content-type)', async () => {
    guard.mockResolvedValue(guardOk)
    const res = mockRes()
    await run(res, {})
    expect(res.statusCode).toBe(400)
    expect(field(res, 'error')).toBe('invalid_body')
  })

  it('400 on an empty upload', async () => {
    guard.mockResolvedValue(guardOk)
    const res = mockRes()
    await run(res, Buffer.alloc(0))
    expect(res.statusCode).toBe(400)
    expect(field(res, 'error')).toBe('empty_upload')
  })

  it('maps a corrupt/not-a-zip DocxUnsafeError to 400', async () => {
    guard.mockResolvedValue(guardOk)
    parse.mockRejectedValue(new DocxUnsafeError('bad magic', 'not-a-zip'))
    const res = mockRes()
    await run(res, Buffer.from('not a zip'))
    expect(res.statusCode).toBe(400)
    expect(field(res, 'error')).toBe('import_unsafe')
    expect(field(res, 'reason')).toBe('not-a-zip')
  })

  it('maps an oversize/bomb DocxUnsafeError to 413', async () => {
    guard.mockResolvedValue(guardOk)
    parse.mockRejectedValue(new DocxUnsafeError('too big', 'total-too-large'))
    const res = mockRes()
    await run(res, Buffer.from('PKzip'))
    expect(res.statusCode).toBe(413)
    expect(field(res, 'error')).toBe('import_unsafe')
  })

  it('maps a generic parse failure to 422 without leaking the error', async () => {
    guard.mockResolvedValue(guardOk)
    parse.mockRejectedValue(new Error('boom at /secret/path'))
    const res = mockRes()
    await run(res, Buffer.from('PKzip'))
    expect(res.statusCode).toBe(422)
    expect(field(res, 'error')).toBe('import_failed')
    expect(JSON.stringify(res.body)).not.toContain('/secret/path')
  })

  it('maps a parse-deadline timeout DocxUnsafeError to 400', async () => {
    guard.mockResolvedValue(guardOk)
    parse.mockRejectedValue(new DocxUnsafeError('parse budget spent', 'timeout'))
    const res = mockRes()
    await run(res, Buffer.from('PKzip'))
    expect(res.statusCode).toBe(400)
    expect(field(res, 'error')).toBe('import_unsafe')
    expect(field(res, 'reason')).toBe('timeout')
  })

  it('returns 503 when the import queue is saturated, without parsing', async () => {
    guard.mockResolvedValue(guardOk)
    acquire.mockRejectedValueOnce(new DocxImportBusyError())
    const res = mockRes()
    await run(res, Buffer.from('PKzip'))
    expect(res.statusCode).toBe(503)
    expect(field(res, 'error')).toBe('import_busy')
    expect(parse).not.toHaveBeenCalled()
  })

  it('always releases the import slot (success and failure)', async () => {
    guard.mockResolvedValue(guardOk)
    parse.mockResolvedValue({ doc: { type: 'doc', content: [] }, warnings: [] })
    await run(mockRes(), Buffer.from('PKzip'))
    parse.mockRejectedValue(new Error('boom'))
    await run(mockRes(), Buffer.from('PKzip'))
    // Once per handled request that acquired a slot (both above).
    expect(release.mock.calls.length).toBe(2)
  })

  it('returns 200 with the parsed doc + warnings on success', async () => {
    guard.mockResolvedValue(guardOk)
    parse.mockResolvedValue({ doc: { type: 'doc', content: [] }, warnings: ['w1'] })
    const res = mockRes()
    await run(res, Buffer.from('PKzip'))
    expect(res.statusCode).toBe(200)
    expect((field(res, 'doc') as { type: string }).type).toBe('doc')
    expect(field(res, 'warnings')).toEqual(['w1'])
  })

  it('cleans DOCX-created attachments when atomic apply is rejected', async () => {
    guard.mockResolvedValue(guardOk)
    objectUpload.mockResolvedValue(undefined)
    parse.mockImplementation(async (_buffer, uploadCtx) => {
      const attachId = await uploadCtx!.upload({
        bytes: Buffer.from('png'), mime: 'image/png', fileName: 'image.png',
      })
      expect(attachId).toBe('att_test')
      return { doc: { type: 'doc', content: [{ type: 'image', attrs: { attachId } }] }, warnings: [] }
    })
    vi.mocked(readLiveForEdit).mockResolvedValue({ pmDoc: { childCount: 0 }, baseSV: new Uint8Array([1]) } as never)
    vi.mocked(editDocBody).mockResolvedValue({ ok: false, status: 412, error: 'base_version_stale' })
    const res = mockRes()
    await importDocxHandler(req(Buffer.from('PKzip'), { 'x-octo-import-apply': 'true' }), res as unknown as Response)
    expect(res.statusCode).toBe(412)
    expect(docAttachmentRepo.deleteById).toHaveBeenCalledWith('att_test')
    expect(objectDelete).toHaveBeenCalledWith('d1/att_test/image.png')
    vi.unstubAllGlobals()
  })

  it('atomically applies the parsed doc when the CLI apply header is present', async () => {
    guard.mockResolvedValue(guardOk)
    parse.mockResolvedValue({
      doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'large import' }] }] },
      warnings: ['w1'],
    })
    vi.mocked(readLiveForEdit).mockResolvedValue({
      pmDoc: { childCount: 0 },
      baseSV: new Uint8Array([1]),
    } as unknown as Awaited<ReturnType<typeof readLiveForEdit>>)
    vi.mocked(editDocBody).mockResolvedValue({
      ok: true,
      bytes: 42,
      baseVersion: 'BV_NEW==',
      newDocVersionSeq: 2,
    })
    const res = mockRes()
    await importDocxHandler(
      req(Buffer.from('PKzip'), { 'x-octo-import-apply': 'true' }),
      res as unknown as Response,
    )
    expect(res.statusCode).toBe(200)
    expect(field(res, 'doc')).toBeUndefined()
    expect(field(res, 'baseVersion')).toBe('BV_NEW==')
    expect(field(res, 'warnings')).toEqual(['w1'])
    expect(editDocBody).toHaveBeenCalledWith(
      expect.objectContaining({
        docId: 'd1',
        documentName: 'octo:s:f:d1',
        ops: [
          expect.objectContaining({
            type: 'insert',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'large import' }] }],
          }),
        ],
      }),
    )
  })
})

describe('importDocxHandler — imported image attachment ownership', () => {
  it('strips a foreign image attachId before atomic apply and keeps its src', async () => {
    guard.mockResolvedValue(guardOk)
    parse.mockResolvedValue({
      doc: {
        type: 'doc',
        content: [
          {
            type: 'image',
            attrs: { attachId: 'att_from_another_doc', src: 'https://cdn.example.com/image.png' },
          },
        ],
      },
      warnings: [],
    })
    vi.mocked(readLiveForEdit).mockResolvedValue({
      pmDoc: { childCount: 0 },
      baseSV: new Uint8Array([1]),
    } as unknown as Awaited<ReturnType<typeof readLiveForEdit>>)
    vi.mocked(editDocBody).mockResolvedValue({
      ok: true,
      bytes: 42,
      baseVersion: 'BV_NEW==',
      newDocVersionSeq: 2,
    })

    const res = mockRes()
    await importDocxHandler(
      req(Buffer.from('PKzip'), { 'x-octo-import-apply': 'true' }),
      res as unknown as Response,
    )

    expect(res.statusCode).toBe(200)
    expect(field(res, 'warnings')).toEqual(['docs.import.foreignImageAttachmentsSkipped:1'])
    expect(editDocBody).toHaveBeenCalledWith(
      expect.objectContaining({
        ops: [
          expect.objectContaining({
            content: [{ type: 'image', attrs: { src: 'https://cdn.example.com/image.png' } }],
          }),
        ],
      }),
    )
  })
})
