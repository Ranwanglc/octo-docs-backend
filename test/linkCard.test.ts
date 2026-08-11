import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/util/ogFetch.js', () => ({ fetchOgCard: vi.fn() }))

const redisStore = { get: vi.fn(), set: vi.fn() }
vi.mock('../src/db/redis.js', () => ({
  getRedis: () => redisStore,
  rkey: (...parts: string[]) => ['octo-docs', ...parts].join(':'),
}))

import { linkCardHandler } from '../src/api/routes/linkCard.js'
import { requireDocRole } from '../src/api/guard.js'
import { fetchOgCard } from '../src/util/ogFetch.js'
import { LinkCardError } from '../src/util/ssrfGuard.js'

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
function req(body?: unknown) {
  return { uid: 'u_reader', spaceId: 's1', params: { docId: 'd_1' }, body } as never
}

const readerGuard = { meta: { doc_id: 'd_1' }, role: 'reader' } as never
const sampleCard = {
  url: 'https://example.com/',
  title: 'T',
  description: 'D',
  image: '',
  siteName: 'Example',
  fetchedAt: '2026-01-01T00:00:00.000Z',
}

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset().mockResolvedValue(readerGuard)
  vi.mocked(fetchOgCard).mockReset()
  redisStore.get.mockReset().mockResolvedValue(null)
  redisStore.set.mockReset().mockResolvedValue('OK')
})

describe('POST /link-card (§3.5 ⑰)', () => {
  it('returns 400 url_required when url is missing/blank', async () => {
    const res = mockRes()
    await linkCardHandler(req({ url: '   ' }), res as never)
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe('url_required')
    expect(vi.mocked(fetchOgCard)).not.toHaveBeenCalled()
  })

  it('fetches, returns 200, and writes the success cache', async () => {
    vi.mocked(fetchOgCard).mockResolvedValue(sampleCard)
    const res = mockRes()
    await linkCardHandler(req({ url: 'https://example.com/' }), res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual(sampleCard)
    expect(vi.mocked(fetchOgCard)).toHaveBeenCalledOnce()
    // The doc guard is scoped to req.spaceId (4th arg).
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('reader')
    // Cached under the og:v1:<sha256> namespace with the success TTL.
    const [key, value, mode, ttl] = redisStore.set.mock.calls[0]!
    expect(String(key)).toMatch(/^octo-docs:og:v1:[0-9a-f]{64}$/)
    expect(JSON.parse(String(value))).toEqual(sampleCard)
    expect(mode).toBe('EX')
    expect(ttl).toBe(24 * 60 * 60)
  })

  it('serves a cache hit without making an outbound fetch', async () => {
    redisStore.get.mockResolvedValue(JSON.stringify(sampleCard))
    const res = mockRes()
    await linkCardHandler(req({ url: 'https://example.com/' }), res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual(sampleCard)
    expect(vi.mocked(fetchOgCard)).not.toHaveBeenCalled()
  })

  it('maps a thrown LinkCardError to its status and negative-caches it', async () => {
    vi.mocked(fetchOgCard).mockRejectedValue(new LinkCardError('ssrf_blocked', 'internal'))
    const res = mockRes()
    await linkCardHandler(req({ url: 'http://10.0.0.5/' }), res as never)
    expect(res.statusCode).toBe(403)
    expect((res.body as { error: string }).error).toBe('ssrf_blocked')
    // Short negative TTL.
    const [, value, , ttl] = redisStore.set.mock.calls[0]!
    expect(JSON.parse(String(value))).toEqual({ error: 'ssrf_blocked', status: 403 })
    expect(ttl).toBe(300)
  })

  it('replays a cached failure with its original status', async () => {
    redisStore.get.mockResolvedValue(JSON.stringify({ error: 'fetch_failed', status: 502 }))
    const res = mockRes()
    await linkCardHandler(req({ url: 'https://down.example/' }), res as never)
    expect(res.statusCode).toBe(502)
    expect((res.body as { error: string }).error).toBe('fetch_failed')
    expect(vi.mocked(fetchOgCard)).not.toHaveBeenCalled()
  })

  it('maps an unexpected (non-LinkCard) error to fetch_failed/502', async () => {
    vi.mocked(fetchOgCard).mockRejectedValue(new Error('boom'))
    const res = mockRes()
    await linkCardHandler(req({ url: 'https://example.com/' }), res as never)
    expect(res.statusCode).toBe(502)
    expect((res.body as { error: string }).error).toBe('fetch_failed')
  })
})
