import { describe, it, expect, vi, beforeEach } from 'vitest'

// Route-level test for POST /api/v1/docs/search (searchDocsHandler) — full-text
// search with permission DOWN-PUSH (P4, §5.3/§5.4/§6.4). MySQL computes the
// visibility CONSTRAINT (a small private/explicitly-granted doc_id set +
// isSpaceMember), which the handler pushes DOWN into the OpenSearch query as a
// filter; OS then does the full-text match AND pagination. There is NO per-hit
// MySQL re-check — hits are already within the constraint.
// We mock the OS client (searchDocs), the doc_meta repo (listVisibleDocIdSet), the
// octo identity, and the config gate, then call the exported handler directly (no
// live infra) — the same offline style as docsListAuthz.test.ts.
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    search: {
      enabled: true,
      opensearchNode: 'http://127.0.0.1:9200',
      opensearchIndex: 'octo-doc',
      opensearchUsername: '',
      opensearchPassword: '',
      pageSizeMax: 50,
    },
    webOrigin: '',
    docView: { retainCount: 200, retainDays: 90 },
  },
}))
vi.mock('../src/config/env.js', () => ({ config: mockConfig }))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { listVisibleDocIdSet: vi.fn() },
}))
const { searchDocsMock } = vi.hoisted(() => ({ searchDocsMock: vi.fn() }))
vi.mock('../src/search/osClient.js', async (importActual) => {
  // Keep the real VisibleTermsTooLargeError class (route uses instanceof) while
  // stubbing searchDocs itself.
  const actual = await importActual<typeof import('../src/search/osClient.js')>()
  return { ...actual, searchDocs: searchDocsMock }
})
const { isSpaceMemberMock } = vi.hoisted(() => ({ isSpaceMemberMock: vi.fn() }))
vi.mock('../src/auth/octoIdentity.js', () => ({
  getOctoIdentity: () => ({ isSpaceMember: isSpaceMemberMock }),
}))

import { searchDocsHandler } from '../src/api/routes/docs.js'
import { VisibleTermsTooLargeError, encodeSearchCursor, decodeSearchCursor } from '../src/search/osClient.js'
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
    status(c: number) { this.statusCode = c; return this },
    json(b: unknown) { this.body = b; return this },
  }
}
function req(extra: Record<string, unknown>) {
  return { uid: 'u_1', spaceId: 's_target', octoToken: 'tok', body: {}, ...extra } as never
}

beforeEach(() => {
  mockConfig.search.enabled = true
  vi.mocked(docMetaRepo.listVisibleDocIdSet).mockReset()
  vi.mocked(docMetaRepo.listVisibleDocIdSet).mockResolvedValue([])
  searchDocsMock.mockReset()
  searchDocsMock.mockResolvedValue({ total: 0, items: [], searchAfter: null })
  isSpaceMemberMock.mockReset()
  isSpaceMemberMock.mockResolvedValue(true)
})

describe('POST /api/v1/docs/search — searchDocsHandler', () => {
  it('member: passes isSpaceMember=true to listVisibleDocIdSet so space-share is folded into the visible set, then pushes that set to OS', async () => {
    isSpaceMemberMock.mockResolvedValue(true)
    vi.mocked(docMetaRepo.listVisibleDocIdSet).mockResolvedValue(['d_priv1', 'd_priv2'])
    searchDocsMock.mockResolvedValue({
      total: 1,
      items: [
        { docId: 'd_priv1', title: 'One', docType: 'doc', updatedAt: 1000, spaceId: 's_target', highlight: '…hit…' },
      ],
      searchAfter: null,
    })
    const res = mockRes()
    await searchDocsHandler(req({ body: { q: 'hello' } }), res as never)

    expect(res.statusCode).toBe(200)
    // MySQL computed the full visible set for this caller + space, WITH the member flag.
    const listArg = vi.mocked(docMetaRepo.listVisibleDocIdSet).mock.calls[0]![0]
    expect(listArg).toMatchObject({ uid: 'u_1', spaceId: 's_target', isSpaceMember: true })
    // Only the resolved doc_id set is pushed to OS — no isSpaceMember/share_scope.
    const osArg = searchDocsMock.mock.calls[0]![0]
    expect(osArg).toMatchObject({
      spaceId: 's_target',
      query: 'hello',
      visibleDocIds: ['d_priv1', 'd_priv2'],
    })
    expect(osArg.isSpaceMember).toBeUndefined()

    const body = res.body as { total: number; items: Array<{ docId: string; title: string; docType: string; updatedAt: number; spaceId?: string; highlight?: string; role?: unknown; score?: unknown }> }
    expect(body.total).toBe(1)
    expect(body.items[0]).toMatchObject({ docId: 'd_priv1', title: 'One', docType: 'doc', updatedAt: 1000, spaceId: 's_target', highlight: '…hit…' })
    // §6.3: no role, no score in the response.
    expect(body.items[0]!.role).toBeUndefined()
    expect(body.items[0]!.score).toBeUndefined()
  })

  it('P1-1 fail-closed: does NOT widen the visible set to owned bots (search returns body highlights, so it must match the read guard, not owner=me list scope)', async () => {
    vi.mocked(docMetaRepo.listVisibleDocIdSet).mockResolvedValue([])
    const res = mockRes()
    // A caller who owns bots — the owner=me LIST view widens to them, but a
    // content-returning search endpoint must not.
    await searchDocsHandler(req({ uid: 'u_1', ownedBots: ['bot_a', 'bot_b'], body: { q: 'x' } }), res as never)
    const listArg = vi.mocked(docMetaRepo.listVisibleDocIdSet).mock.calls[0]![0]
    // ownedBots is never forwarded, so a bot-owned doc with no doc_member row for
    // the human stays out of the searchable set (parity with GET /content 403).
    expect((listArg as Record<string, unknown>).ownedBots).toBeUndefined()
  })

  it('P1-2 bounded: caps the visible-set query at maxVisibleTerms by passing limit, so an oversized set is rejected before a large terms clause is built', async () => {
    mockConfig.search.maxVisibleTerms = 50000
    const res = mockRes()
    await searchDocsHandler(req({ body: { q: 'x' } }), res as never)
    const listArg = vi.mocked(docMetaRepo.listVisibleDocIdSet).mock.calls[0]![0]
    // The route hands the bound down to the DB layer (which caps at limit+1),
    // so overflow is detected on a bounded scan rather than after streaming the
    // full set and allocating an N-element array on every keyset page.
    expect((listArg as Record<string, unknown>).limit).toBe(50000)
  })

  it('non-member: passes isSpaceMember=false to listVisibleDocIdSet (space-share excluded from the set)', async () => {
    isSpaceMemberMock.mockResolvedValue(false)
    vi.mocked(docMetaRepo.listVisibleDocIdSet).mockResolvedValue(['d_priv1'])
    searchDocsMock.mockResolvedValue({ total: 0, items: [], searchAfter: null })
    const res = mockRes()
    await searchDocsHandler(req({ body: { q: 'x' } }), res as never)

    expect(res.statusCode).toBe(200)
    const listArg = vi.mocked(docMetaRepo.listVisibleDocIdSet).mock.calls[0]![0]
    expect(listArg).toMatchObject({ isSpaceMember: false })
    const osArg = searchDocsMock.mock.calls[0]![0]
    expect(osArg.visibleDocIds).toEqual(['d_priv1'])
    expect(osArg.isSpaceMember).toBeUndefined()
  })

  it('empty visible set => the set pushed to OS is empty and total=0 (searchDocs short-circuits without hitting OS)', async () => {
    // The no-OS-call short-circuit lives INSIDE searchDocs (osClient), covered by
    // its own unit test (osClientSearch.test.ts). At the route level searchDocs is
    // mocked, so here we assert the route pushes the empty visible set down.
    isSpaceMemberMock.mockResolvedValue(false)
    vi.mocked(docMetaRepo.listVisibleDocIdSet).mockResolvedValue([])
    searchDocsMock.mockResolvedValue({ total: 0, items: [], searchAfter: null })
    const res = mockRes()
    await searchDocsHandler(req({ body: { q: 'x' } }), res as never)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ total: 0, items: [] })
    const osArg = searchDocsMock.mock.calls[0]![0]
    expect(osArg.visibleDocIds).toEqual([])
  })

  it('first page: no cursor => searchAfter undefined; nextCursor echoes searchDocs.searchAfter', async () => {
    isSpaceMemberMock.mockResolvedValue(true)
    vi.mocked(docMetaRepo.listVisibleDocIdSet).mockResolvedValue(['d1'])
    searchDocsMock.mockResolvedValue({ total: 42, items: [], searchAfter: [2.5, 'd1'] })
    const res = mockRes()
    await searchDocsHandler(req({ body: { q: 'x', pageSize: 10 } }), res as never)

    const osArg = searchDocsMock.mock.calls[0]![0]
    // No cursor on the first request => search_after is not passed down.
    expect(osArg.searchAfter).toBeUndefined()
    expect(osArg.size).toBe(10)
    const body = res.body as { total: number; nextCursor?: string }
    // total is taken straight from OS hits.total.value.
    expect(body.total).toBe(42)
    // A returned searchAfter is wrapped into an opaque nextCursor.
    expect(typeof body.nextCursor).toBe('string')
    expect(decodeSearchCursor(body.nextCursor)).toEqual([2.5, 'd1'])
  })

  it('later page: a valid cursor is decoded and passed to searchDocs as searchAfter', async () => {
    isSpaceMemberMock.mockResolvedValue(true)
    vi.mocked(docMetaRepo.listVisibleDocIdSet).mockResolvedValue(['d1'])
    searchDocsMock.mockResolvedValue({ total: 42, items: [], searchAfter: null })
    const cursor = encodeSearchCursor([1.1, 'd7'])
    const res = mockRes()
    await searchDocsHandler(req({ body: { q: 'x', cursor, pageSize: 10 } }), res as never)

    expect(res.statusCode).toBe(200)
    expect(searchDocsMock.mock.calls[0]![0].searchAfter).toEqual([1.1, 'd7'])
    // No further page => nextCursor omitted so the client stops.
    expect((res.body as { nextCursor?: string }).nextCursor).toBeUndefined()
  })

  it('malformed cursor => 400 invalid_cursor, never touches the DB or OS', async () => {
    const res = mockRes()
    await searchDocsHandler(req({ body: { q: 'x', cursor: '!!!not-valid' } }), res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_cursor' })
    expect(docMetaRepo.listVisibleDocIdSet).not.toHaveBeenCalled()
    expect(searchDocsMock).not.toHaveBeenCalled()
  })

  it('pageSize is clamped to config.search.pageSizeMax', async () => {
    isSpaceMemberMock.mockResolvedValue(true)
    vi.mocked(docMetaRepo.listVisibleDocIdSet).mockResolvedValue(['d1'])
    searchDocsMock.mockResolvedValue({ total: 0, items: [], searchAfter: null })
    const res = mockRes()
    await searchDocsHandler(req({ body: { q: 'x', pageSize: 9999 } }), res as never)
    expect(searchDocsMock.mock.calls[0]![0].size).toBe(mockConfig.search.pageSizeMax)
  })

  it('docType filter is passed to BOTH the MySQL constraint and OS', async () => {
    isSpaceMemberMock.mockResolvedValue(true)
    vi.mocked(docMetaRepo.listVisibleDocIdSet).mockResolvedValue(['d1'])
    searchDocsMock.mockResolvedValue({ total: 0, items: [], searchAfter: null })
    const res = mockRes()
    await searchDocsHandler(req({ body: { q: 'x', docType: ['doc', 'sheet'] } }), res as never)
    expect(res.statusCode).toBe(200)
    expect(vi.mocked(docMetaRepo.listVisibleDocIdSet).mock.calls[0]![0].docType).toEqual(['doc', 'sheet'])
    expect(searchDocsMock.mock.calls[0]![0].docType).toEqual(['doc', 'sheet'])
  })

  it('search disabled => 503, never touches OpenSearch or the DB', async () => {
    mockConfig.search.enabled = false
    const res = mockRes()
    await searchDocsHandler(req({ body: { q: 'x' } }), res as never)
    expect(res.statusCode).toBe(503)
    expect(searchDocsMock).not.toHaveBeenCalled()
    expect(docMetaRepo.listVisibleDocIdSet).not.toHaveBeenCalled()
  })

  it('missing q => 400', async () => {
    const res = mockRes()
    await searchDocsHandler(req({ body: {} }), res as never)
    expect(res.statusCode).toBe(400)
    expect(searchDocsMock).not.toHaveBeenCalled()
  })

  it('blank q => 400', async () => {
    const res = mockRes()
    await searchDocsHandler(req({ body: { q: '   ' } }), res as never)
    expect(res.statusCode).toBe(400)
  })

  it('OpenSearch error => 503 (never fail-open to returning everything)', async () => {
    isSpaceMemberMock.mockResolvedValue(true)
    vi.mocked(docMetaRepo.listVisibleDocIdSet).mockResolvedValue(['d1'])
    searchDocsMock.mockRejectedValue(new Error('opensearch unavailable'))
    const res = mockRes()
    await searchDocsHandler(req({ body: { q: 'x' } }), res as never)
    expect(res.statusCode).toBe(503)
    expect(res.body).toEqual({ error: 'search unavailable' })
  })

  it('visible set too large => 503 with a distinct terms_limit_exceeded reason', async () => {
    isSpaceMemberMock.mockResolvedValue(true)
    vi.mocked(docMetaRepo.listVisibleDocIdSet).mockResolvedValue(['d1'])
    searchDocsMock.mockRejectedValue(new VisibleTermsTooLargeError(70000, 65536))
    const res = mockRes()
    await searchDocsHandler(req({ body: { q: 'x' } }), res as never)
    expect(res.statusCode).toBe(503)
    // Distinct reason so a client narrows the query instead of blindly retrying.
    expect(res.body).toEqual({ error: 'search unavailable', reason: 'terms_limit_exceeded' })
  })
})
