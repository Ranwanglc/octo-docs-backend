import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'

vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/collab/liveDocWrite.js', () => ({ readLiveForEdit: vi.fn() }))
vi.mock('../src/api/services/editDocBody.js', () => ({ editDocBody: vi.fn() }))

import { importMarkdownHandler } from '../src/api/routes/import.js'
import { requireDocRole } from '../src/api/guard.js'
import { exportMarkdown, type PmNode } from '../src/export/markdown.js'

interface MockRes {
  statusCode: number
  body: Record<string, unknown> | undefined
  status(code: number): MockRes
  json(body: Record<string, unknown>): MockRes
}
function res(): MockRes {
  return {
    statusCode: 0,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}
function req(body: unknown): Request {
  return {
    uid: 'human_u1',
    spaceId: 's1',
    params: { docId: 'd1' },
    body,
    header: () => undefined,
  } as unknown as Request
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireDocRole).mockResolvedValue({
    meta: { doc_id: 'd1', document_name: 'octo:s1:f:d1', permission_epoch: 1 },
  } as unknown as Awaited<ReturnType<typeof requireDocRole>>)
})

describe('human Markdown import route', () => {
  it('uses writer authorization and returns the shared PM schema plus warnings', async () => {
    const response = res()
    await importMarkdownHandler(req(Buffer.from('![local](./missing.png)\n\n# 标题')), response as unknown as Response)

    expect(requireDocRole).toHaveBeenCalledWith(
      expect.objectContaining({ uid: 'human_u1', params: { docId: 'd1' } }),
      response,
      'd1',
      'writer',
    )
    expect(response.statusCode).toBe(200)
    expect(response.body?.doc).toMatchObject({ type: 'doc', content: expect.any(Array) })
    expect(response.body?.warnings).toEqual(expect.arrayContaining([expect.stringContaining('localImagesSkipped')]))
  })

  it('round-trips exported emoji through the authoritative route and preserves unknown shortcodes', async () => {
    const source: PmNode = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'emoji', attrs: { name: 'smile' } },
          { type: 'text', text: ' :not_a_real_emoji:' },
        ],
      }],
    }
    const response = res()

    await importMarkdownHandler(
      req(Buffer.from(exportMarkdown(source))),
      response as unknown as Response,
    )

    expect(response.statusCode).toBe(200)
    expect(response.body?.doc).toEqual({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'emoji', attrs: { name: 'smile' } },
          { type: 'text', text: ' :not_a_real_emoji:' },
        ],
      }],
    })
  })

  it('rejects malformed UTF-8 rather than silently inserting replacement characters', async () => {
    const response = res()
    await importMarkdownHandler(req(Buffer.from([0xc3, 0x28])), response as unknown as Response)
    expect(response.statusCode).toBe(400)
    expect(response.body).toEqual({ error: 'invalid_utf8' })
  })
})
