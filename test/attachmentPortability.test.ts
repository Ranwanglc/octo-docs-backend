import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'

vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/collab/liveDocWrite.js', () => ({ readLiveForEdit: vi.fn() }))
vi.mock('../src/api/services/editDocBody.js', () => ({ editDocBody: vi.fn() }))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({ docMetaRepo: { getByDocId: vi.fn() } }))
vi.mock('../src/permission/resolveRole.js', () => ({ resolveRole: vi.fn() }))
vi.mock('../src/api/routes/attachments.js', () => ({ copyStoredObject: vi.fn(), cleanupCopiedAttachment: vi.fn() }))
vi.mock('../src/db/repos/docAttachmentRepo.js', () => ({
  docAttachmentRepo: { getById: vi.fn() },
}))

import { importMarkdownHandler } from '../src/api/routes/import.js'
import { requireDocRole } from '../src/api/guard.js'
import { readLiveForEdit } from '../src/collab/liveDocWrite.js'
import { editDocBody } from '../src/api/services/editDocBody.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { docAttachmentRepo } from '../src/db/repos/docAttachmentRepo.js'
import { resolveRole } from '../src/permission/resolveRole.js'
import { cleanupCopiedAttachment, copyStoredObject } from '../src/api/routes/attachments.js'

function response(): Response & { statusCode: number; body?: Record<string, unknown> } {
  return { statusCode: 0, status(n: number) { this.statusCode = n; return this }, json(body: Record<string, unknown>) { this.body = body; return this } } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireDocRole).mockResolvedValue({ meta: { doc_id: 'd_target', document_name: 'octo:s1:f:d_target', doc_type: 'doc', space_id: 's1', permission_epoch: 1 } } as never)
  vi.mocked(readLiveForEdit).mockResolvedValue({ pmDoc: { childCount: 0 }, baseSV: 'base' } as never)
  vi.mocked(editDocBody).mockResolvedValue({ ok: true, bytes: 1, baseVersion: 'v', newDocVersionSeq: 2 } as never)
  vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({ doc_id: 'd_source', space_id: 's1', status: 1 } as never)
  vi.mocked(resolveRole).mockResolvedValue('reader')
  vi.mocked(docAttachmentRepo.getById).mockImplementation(async (id: string) => id === 'att_new' ? ({ attachId: 'att_new', docId: 'd_target' } as never) : ({ attachId: 'att_old', docId: 'd_source', objectKey: 'd_source/att_old/a.png', mime: 'image/png', sizeBytes: 3, fileName: 'a.png' } as never))
  vi.mocked(copyStoredObject).mockResolvedValue('att_new')
})

describe('authoritative Markdown attachment migration', () => {
  it('copies by stable marker and never persists the source signed URL', async () => {
    const md = '![a](https://store/file/d_source/att_old/a.png?X-Amz-Signature=secret#octo-attachment%3Ad_source%3Aatt_old)'
    const req = { uid: 'u1', spaceId: 's1', params: { docId: 'd_target' }, body: Buffer.from(md), botToken: 'bot', header: (n: string) => n === 'x-octo-import-apply' ? 'true' : undefined } as unknown as Request
    const res = response()
    await importMarkdownHandler(req, res)
    expect(res.statusCode).toBe(200)
    expect(copyStoredObject).toHaveBeenCalledOnce()
    const call = vi.mocked(editDocBody).mock.calls[0]![0] as { ops: Array<{ content: Array<{ attrs: Record<string, unknown> }> }> }
    expect(call.ops[0]!.content[0]!.attrs).toMatchObject({ attachId: 'att_new' })
    expect(call.ops[0]!.content[0]!.attrs).not.toHaveProperty('src')
  })


  it('reuses one target copy for repeated references to the same source attachment', async () => {
    const url = 'https://store/file/d_source/att_old/a.png#octo-attachment%3Ad_source%3Aatt_old'
    const req = { uid: 'u1', spaceId: 's1', params: { docId: 'd_target' }, body: Buffer.from(`![a](${url})

![b](${url})`), botToken: 'bot', header: (n: string) => n === 'x-octo-import-apply' ? 'true' : undefined } as unknown as Request
    const res = response()
    await importMarkdownHandler(req, res)
    expect(res.statusCode).toBe(200)
    expect(copyStoredObject).toHaveBeenCalledOnce()
    const payload = vi.mocked(editDocBody).mock.calls[0]![0] as { ops: Array<{ content: unknown[] }> }
    expect(JSON.stringify(payload.ops[0]!.content).match(/att_new/g)).toHaveLength(2)
  })

  it.each([
    ['denied source access', () => vi.mocked(resolveRole).mockResolvedValue('none')],
    ['copy failure', () => vi.mocked(copyStoredObject).mockRejectedValue(new Error('storage unavailable'))],
  ])('strips source credentials after %s', async (_name, arrange) => {
    arrange()
    const signed = 'https://store/file/d_source/att_old/a.png?X-Amz-Signature=secret#octo-attachment%3Ad_source%3Aatt_old'
    const req = { uid: 'u1', spaceId: 's1', params: { docId: 'd_target' }, body: Buffer.from(`![a](${signed})`), botToken: 'bot', header: (n: string) => n === 'x-octo-import-apply' ? 'true' : undefined } as unknown as Request
    const res = response()
    await importMarkdownHandler(req, res)
    expect(res.statusCode).toBe(200)
    const payload = vi.mocked(editDocBody).mock.calls[0]![0] as { ops: Array<{ content: unknown[] }> }
    expect(JSON.stringify(payload.ops[0]!.content)).not.toContain('X-Amz-Signature')
    expect(JSON.stringify(payload.ops[0]!.content)).not.toContain('att_old')
  })

  it('removes copied attachments when the optimistic document edit fails', async () => {
    vi.mocked(editDocBody).mockResolvedValue({ ok: false, status: 409, error: 'version_conflict' } as never)
    const md = '![a](https://store/file/d_source/att_old/a.png#octo-attachment%3Ad_source%3Aatt_old)'
    const req = { uid: 'u1', spaceId: 's1', params: { docId: 'd_target' }, body: Buffer.from(md), botToken: 'bot', header: (n: string) => n === 'x-octo-import-apply' ? 'true' : undefined } as unknown as Request
    const res = response()
    await importMarkdownHandler(req, res)
    expect(res.statusCode).toBe(409)
    expect(cleanupCopiedAttachment).toHaveBeenCalledWith('att_new')
  })
})
