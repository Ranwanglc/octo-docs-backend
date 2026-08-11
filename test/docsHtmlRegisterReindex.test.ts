import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { search: { indexEnabled: true }, webOrigin: '' },
}))
vi.mock('../src/config/env.js', () => ({ config: mockConfig }))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { getByDocId: vi.fn(), rename: vi.fn(async () => undefined) },
  DocOwnershipError: class extends Error {},
  CanonicalHtmlDeletedError: class extends Error {},
  CanonicalHtmlArchivedError: class extends Error {},
  CanonicalHtmlLegacyConflictError: class extends Error {},
}))
const { enqueueDocIndexMock } = vi.hoisted(() => ({ enqueueDocIndexMock: vi.fn(async () => true) }))
vi.mock('../src/search/docIndexQueue.js', () => ({
  enqueueDocIndex: enqueueDocIndexMock,
  isSearchIndexedDoc: (name: string) => name.split(':').length === 5,
}))

import { publishHtmlHandler } from '../src/api/routes/docs.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'

function mockRes() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this },
    json(body: unknown) { this.body = body; return this },
  }
}

const meta = {
  doc_id: 'd_html_1', document_name: 'octo:s_1:f_default:html:d_html_1',
  space_id: 's_1', owner_id: 'u_owner', title: 'hello', doc_type: 'html', status: 1,
}

function req(body: Record<string, unknown> = {}) {
  return { uid: 'u_owner', spaceId: 's_1', botToken: 'bot', params: { docId: 'd_html_1' }, body } as never
}

describe('publishHtmlHandler — content-ready search reindex', () => {
  beforeEach(() => {
    enqueueDocIndexMock.mockClear()
    vi.mocked(docMetaRepo.rename).mockClear()
    vi.mocked(docMetaRepo.getByDocId).mockReset().mockResolvedValue(meta as never)
    mockConfig.search.indexEnabled = true
  })

  it('does not enqueue during registration; published notification enqueues by doc_id', async () => {
    const res = mockRes()
    await publishHtmlHandler(req(), res as never)
    expect(res.statusCode).toBe(200)
    expect(enqueueDocIndexMock).toHaveBeenCalledOnce()
    expect(enqueueDocIndexMock).toHaveBeenCalledWith(meta.document_name)
    expect(res.body).toMatchObject({ indexed: true })
  })

  it('is repeatable and each content-ready notification safely reindexes latest content', async () => {
    await publishHtmlHandler(req(), mockRes() as never)
    await publishHtmlHandler(req(), mockRes() as never)
    expect(enqueueDocIndexMock).toHaveBeenCalledTimes(2)
  })

  it('optionally synchronizes title before enqueueing', async () => {
    await publishHtmlHandler(req({ title: 'published title' }), mockRes() as never)
    expect(docMetaRepo.rename).toHaveBeenCalledWith('d_html_1', 'published title', 'u_owner')
    expect(enqueueDocIndexMock).toHaveBeenCalledOnce()
  })

  it('honors the search indexing gate', async () => {
    mockConfig.search.indexEnabled = false
    const res = mockRes()
    await publishHtmlHandler(req(), res as never)
    expect(res.statusCode).toBe(200)
    expect(enqueueDocIndexMock).not.toHaveBeenCalled()
    expect(res.body).toMatchObject({ indexed: false })
  })

  it('reports indexed false when the enabled queue rejects the enqueue', async () => {
    enqueueDocIndexMock.mockResolvedValueOnce(false)
    const res = mockRes()
    await publishHtmlHandler(req(), res as never)
    expect(enqueueDocIndexMock).toHaveBeenCalledOnce()
    expect(res.body).toMatchObject({ indexed: false })
  })
})
