import { describe, it, expect, vi, beforeEach } from 'vitest'

// Unit test for searchDocs (src/search/osClient.ts) — the visibility constraint
// down-push (§5.4) + OS pagination (§6.4). We mock the OpenSearch Client so no
// live cluster is needed and assert on the exact request body the module builds.
const { searchSpy } = vi.hoisted(() => ({ searchSpy: vi.fn() }))
vi.mock('@opensearch-project/opensearch', () => ({
  Client: vi.fn().mockImplementation(() => ({ search: searchSpy })),
}))
vi.mock('../src/config/env.js', () => ({
  config: {
    search: {
      opensearchNode: 'http://127.0.0.1:9200',
      opensearchIndex: 'octo-doc',
      opensearchUsername: '',
      opensearchPassword: '',
      pageSizeMax: 50,
      maxVisibleTerms: 65536,
    },
  },
}))

import { searchDocs, VisibleTermsTooLargeError, encodeSearchCursor, decodeSearchCursor } from '../src/search/osClient.js'

beforeEach(() => {
  searchSpy.mockReset()
})

function osResponse(hits: unknown[], total: number) {
  return { body: { hits: { total: { value: total }, hits } } }
}

// Build a hit whose `sort` tuple is [score, doc_id] (matching the query sort);
// the last hit's sort becomes the next page's search_after cursor.
function hit(docId: string, score: number, extra: Record<string, unknown> = {}) {
  return { _id: docId, _source: { doc_id: docId, ...extra }, sort: [score, docId] }
}

describe('searchDocs — visible-set down-push + search_after pagination', () => {
  it('pushes the visible doc_id set down as a terms filter (no share_scope branch)', async () => {
    searchSpy.mockResolvedValue(osResponse([], 0))
    await searchDocs({
      spaceId: 's1',
      query: 'hello',
      visibleDocIds: ['d1', 'd2'],
      size: 20,
    })
    const arg = searchSpy.mock.calls[0]![0] as {
      track_total_hits: boolean
      body: { size: number; query: { bool: { filter: Array<Record<string, unknown>> } } }
    }
    expect(arg.track_total_hits).toBe(true)
    expect(arg.body.size).toBe(20)
    const filter = arg.body.query.bool.filter
    expect(filter).toContainEqual({ term: { space_id: 's1' } })
    expect(filter).toContainEqual({ term: { status: 1 } })
    // Visibility is a single terms doc_id filter now — no bool.should/share_scope.
    expect(filter).toContainEqual({ terms: { doc_id: ['d1', 'd2'] } })
    expect(filter.find((f) => 'bool' in f)).toBeUndefined()
  })

  it('sorts by [_score desc, doc_id asc] so the keyset has a stable tiebreaker', async () => {
    searchSpy.mockResolvedValue(osResponse([], 0))
    await searchDocs({ spaceId: 's1', query: 'x', visibleDocIds: ['d1'], size: 20 })
    const arg = searchSpy.mock.calls[0]![0] as { body: { sort: unknown } }
    expect(arg.body.sort).toEqual([{ _score: 'desc' }, { doc_id: 'asc' }])
  })

  it('omits search_after on the first page and passes it through on a later page', async () => {
    searchSpy.mockResolvedValue(osResponse([], 0))
    await searchDocs({ spaceId: 's1', query: 'x', visibleDocIds: ['d1'], size: 20 })
    expect((searchSpy.mock.calls[0]![0] as { body: Record<string, unknown> }).body.search_after).toBeUndefined()

    searchSpy.mockClear()
    searchSpy.mockResolvedValue(osResponse([], 0))
    await searchDocs({ spaceId: 's1', query: 'x', visibleDocIds: ['d1'], size: 20, searchAfter: [1.5, 'd9'] })
    expect((searchSpy.mock.calls[0]![0] as { body: Record<string, unknown> }).body.search_after).toEqual([1.5, 'd9'])
  })

  it('requests HTML-encoded highlights (encoder:html) so body markup cannot become an XSS sink', async () => {
    searchSpy.mockResolvedValue(osResponse([], 0))
    await searchDocs({
      spaceId: 's1',
      query: 'x',
      visibleDocIds: ['d1'],
      size: 20,
    })
    const arg = searchSpy.mock.calls[0]![0] as { body: { highlight: { encoder: string } } }
    // Without encoder:'html', a document body containing HTML-like text would be
    // copied verbatim into the highlight fragment and could execute if the client
    // renders it as HTML. encoder:'html' makes OpenSearch encode the body first.
    expect(arg.body.highlight.encoder).toBe('html')
  })

  it('empty visible set => total=0, searchAfter=null WITHOUT calling OpenSearch', async () => {
    const res = await searchDocs({
      spaceId: 's1',
      query: 'x',
      visibleDocIds: [],
      size: 20,
    })
    expect(res).toEqual({ total: 0, items: [], searchAfter: null })
    expect(searchSpy).not.toHaveBeenCalled()
  })

  it('docType => terms doc_type filter branch is added', async () => {
    searchSpy.mockResolvedValue(osResponse([], 0))
    await searchDocs({
      spaceId: 's1',
      query: 'x',
      docType: ['doc', 'sheet'],
      visibleDocIds: ['d1'],
      size: 20,
    })
    const arg = searchSpy.mock.calls[0]![0] as { body: { query: { bool: { filter: Array<Record<string, unknown>> } } } }
    expect(arg.body.query.bool.filter).toContainEqual({ terms: { doc_type: ['doc', 'sheet'] } })
  })

  it('maps _source (title/doc_type/updated_at/space_id) + highlight, reads total from hits.total.value', async () => {
    searchSpy.mockResolvedValue(
      osResponse(
        [
          {
            _id: 'd1',
            _source: { doc_id: 'd1', title: 'Title One', doc_type: 'doc', updated_at: 1700, space_id: 's1' },
            highlight: { body: ['…frag…'] },
            sort: [2.5, 'd1'],
          },
          {
            _id: 'd2',
            _source: { doc_id: 'd2', title: 'Title Two', doc_type: 'sheet', updated_at: 1800 },
            sort: [1.2, 'd2'],
          },
        ],
        7,
      ),
    )
    const res = await searchDocs({
      spaceId: 's1',
      query: 'x',
      visibleDocIds: ['d1', 'd2'],
      size: 20,
    })
    expect(res.total).toBe(7)
    expect(res.items[0]).toEqual({ docId: 'd1', title: 'Title One', docType: 'doc', updatedAt: 1700, spaceId: 's1', highlight: '…frag…' })
    // d2's _source has no space_id → spaceId falls back to '' (defensive read).
    expect(res.items[1]).toEqual({ docId: 'd2', title: 'Title Two', docType: 'sheet', updatedAt: 1800, spaceId: '' })
    expect(res.items[1]!.highlight).toBeUndefined()
  })

  it('a full page returns the last hit sort as the next search_after; a short page returns null', async () => {
    // Full page (hits.length === size): more may follow → carry last hit's sort.
    searchSpy.mockResolvedValue(osResponse([hit('d1', 3.0), hit('d2', 2.0)], 9))
    const full = await searchDocs({ spaceId: 's1', query: 'x', visibleDocIds: ['d1', 'd2'], size: 2 })
    expect(full.searchAfter).toEqual([2.0, 'd2'])

    // Short page (hits.length < size): last page → null so the route omits nextCursor.
    searchSpy.mockResolvedValue(osResponse([hit('d1', 3.0)], 1))
    const short = await searchDocs({ spaceId: 's1', query: 'x', visibleDocIds: ['d1'], size: 2 })
    expect(short.searchAfter).toBeNull()
  })

  it('throws on OpenSearch error (route maps to 503)', async () => {
    searchSpy.mockRejectedValue(new Error('cluster down'))
    await expect(
      searchDocs({ spaceId: 's1', query: 'x', visibleDocIds: ['d1'], size: 20 }),
    ).rejects.toThrow('cluster down')
  })

  it('throws VisibleTermsTooLargeError (without hitting OS) when the visible set exceeds maxVisibleTerms', async () => {
    // maxVisibleTerms is 65536 in the mock; build one more than that.
    const tooMany = Array.from({ length: 65537 }, (_, i) => `d${i}`)
    await expect(
      searchDocs({ spaceId: 's1', query: 'x', visibleDocIds: tooMany, size: 20 }),
    ).rejects.toBeInstanceOf(VisibleTermsTooLargeError)
    // Guard trips BEFORE the OS round-trip — no oversized terms clause is sent.
    expect(searchSpy).not.toHaveBeenCalled()
  })

  it('allows a visible set exactly at the bound (boundary, does hit OS)', async () => {
    searchSpy.mockResolvedValue(osResponse([], 0))
    const atLimit = Array.from({ length: 65536 }, (_, i) => `d${i}`)
    await searchDocs({ spaceId: 's1', query: 'x', visibleDocIds: atLimit, size: 20 })
    expect(searchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('search cursor encode/decode (opaque base64url search_after)', () => {
  it('round-trips a sort tuple', () => {
    const cursor = encodeSearchCursor([3.14, 'd42'])
    expect(typeof cursor).toBe('string')
    expect(decodeSearchCursor(cursor)).toEqual([3.14, 'd42'])
  })

  it('missing/empty cursor decodes to null (=> first page)', () => {
    expect(decodeSearchCursor(undefined)).toBeNull()
    expect(decodeSearchCursor('')).toBeNull()
  })

  it('malformed cursor throws invalid_cursor (route maps to 400)', () => {
    expect(() => decodeSearchCursor('!!!not-base64-json')).toThrow('invalid_cursor')
    // Valid base64url JSON but wrong shape (payload not an array).
    expect(() => decodeSearchCursor(encodeCursorRaw({ a: 'nope' }))).toThrow('invalid_cursor')
    // Empty tuple is rejected (a valid search_after is never empty).
    expect(() => decodeSearchCursor(encodeCursorRaw({ a: [] }))).toThrow('invalid_cursor')
  })
})

// Encode an arbitrary payload the same way encodeSearchCursor does, to build
// deliberately-malformed cursors for the decode tests above.
function encodeCursorRaw(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}
