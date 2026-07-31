/**
 * Regression test for the html registration -> search-reindex signal.
 *
 * PR #143 review (blocking): the html registration path
 * (docsRouter.post('/', createDocHandler) with docType='html') MUST enqueue an
 * index signal on successful upsertHtmlByOctoDocSlug, or a newly published html
 * doc never enters the doc-index topic (the Yjs store hook excludes html; a
 * later rename is the only fallback, which is not acceptable).
 *
 * Offline style mirrors docsRenameReindex.test.ts: mock the guard, the config
 * gate, the doc_meta repo, the grant helper, and the index-queue producer, then
 * drive the exported createDocHandler directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    search: { indexEnabled: true },
    // createDocHandler builds a shareUrl via buildDocShareUrl(config.webOrigin, ...);
    // an empty origin renders 'https:///d/...' which is fine for a unit test
    // that only asserts the enqueue side effect and 201.
    webOrigin: '',
  },
}))
vi.mock('../src/config/env.js', () => ({ config: mockConfig }))

vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: {
    upsertHtmlByOctoDocSlug: vi.fn(),
    create: vi.fn(async () => undefined),
    getByDocId: vi.fn(),
    grantOwnerHumanAdmin: vi.fn(async () => undefined),
    bumpPermissionEpoch: vi.fn(async () => undefined),
  },
  DocOwnershipError: class extends Error {},
}))

// grantBotOwnerAdmin lives in the same module as createDocHandler; it reads
// req.botOwnerUid — leaving that unset makes the helper a no-op.
const { enqueueDocIndexMock } = vi.hoisted(() => ({ enqueueDocIndexMock: vi.fn(async () => true) }))
vi.mock('../src/search/docIndexQueue.js', () => ({
  enqueueDocIndex: enqueueDocIndexMock,
  // Match the real gate: 4-seg (doc/sheet/whiteboard) + 5-seg (html) both accepted.
  isSearchIndexedDoc: (name: string) => {
    const segs = name.split(':')
    return segs.length === 4 || segs.length === 5
  },
}))

import { createDocHandler } from '../src/api/routes/docs.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'

interface MockRes {
  statusCode: number
  body: unknown
  status(c: number): MockRes
  json(b: unknown): MockRes
}

function mockRes(): MockRes {
  return {
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
}

function htmlCreateReq(slug: string, mountType: 'group' | 'thread' | 'space' = 'group'): unknown {
  return {
    uid: 'u_owner',
    spaceId: 's_1',
    botToken: 'bot_token',
    body: { docType: 'html', octoDocSlug: slug, mountType, title: 'hello' },
  }
}

describe('createDocHandler — html registration enqueues an index signal (PR #143 blocking)', () => {
  beforeEach(() => {
    enqueueDocIndexMock.mockClear()
    vi.mocked(docMetaRepo.upsertHtmlByOctoDocSlug).mockReset()
    mockConfig.search.indexEnabled = true
  })

  it('enqueues on a fresh html registration', async () => {
    vi.mocked(docMetaRepo.upsertHtmlByOctoDocSlug).mockResolvedValue({
      meta: {
        doc_id: 'd_html_1',
        document_name: 'octo:s_1:f_default:html:d_html_1',
        space_id: 's_1',
        folder_id: 'f_default',
        owner_id: 'u_owner',
        title: 'hello',
      },
      created: true,
    } as never)

    const res = mockRes()
    await createDocHandler(htmlCreateReq('slug-1') as never, res as never)

    expect(res.statusCode).toBe(201)
    expect(enqueueDocIndexMock).toHaveBeenCalledTimes(1)
    expect(enqueueDocIndexMock).toHaveBeenCalledWith('octo:s_1:f_default:html:d_html_1')
  })

  it('enqueues on the idempotent-recovery upsert path (created:false)', async () => {
    // A prior call already created the row; this call resolves to the same meta.
    // The enqueue must still fire so the indexer picks up any content change
    // that happened between the earlier registration and this recovery call.
    vi.mocked(docMetaRepo.upsertHtmlByOctoDocSlug).mockResolvedValue({
      meta: {
        doc_id: 'd_html_2',
        document_name: 'octo:s_1:f_default:html:d_html_2',
        space_id: 's_1',
        folder_id: 'f_default',
        owner_id: 'u_owner',
        title: 'hello',
      },
      created: false,
    } as never)

    const res = mockRes()
    await createDocHandler(htmlCreateReq('slug-2') as never, res as never)

    expect(res.statusCode).toBe(201)
    expect(enqueueDocIndexMock).toHaveBeenCalledTimes(1)
    expect(enqueueDocIndexMock).toHaveBeenCalledWith('octo:s_1:f_default:html:d_html_2')
  })

  it('does NOT enqueue when SEARCH_INDEX_ENABLED is off (gate honored)', async () => {
    mockConfig.search.indexEnabled = false
    vi.mocked(docMetaRepo.upsertHtmlByOctoDocSlug).mockResolvedValue({
      meta: {
        doc_id: 'd_html_3',
        document_name: 'octo:s_1:f_default:html:d_html_3',
        space_id: 's_1',
        folder_id: 'f_default',
        owner_id: 'u_owner',
        title: 'hello',
      },
      created: true,
    } as never)

    const res = mockRes()
    await createDocHandler(htmlCreateReq('slug-3') as never, res as never)

    expect(res.statusCode).toBe(201)
    expect(enqueueDocIndexMock).not.toHaveBeenCalled()
  })
})
