/**
 * getOsClient — multi-node parsing (§ OPENSEARCH_NODE accepts a comma-separated
 * list). Isolated file: uses a mutable config mock so each test can vary the
 * OPENSEARCH_NODE value and re-import getOsClient with a fresh module cache.
 * Asserts the exact `nodes: string[]` handed to the OpenSearch Client, without
 * touching a live cluster.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { clientSpy } = vi.hoisted(() => ({ clientSpy: vi.fn() }))
vi.mock('@opensearch-project/opensearch', () => ({
  Client: clientSpy.mockImplementation(() => ({})),
}))

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    search: {
      opensearchNode: 'http://127.0.0.1:9200',
      opensearchIndex: 'octo-doc',
      opensearchUsername: '',
      opensearchPassword: '',
      opensearchTlsRejectUnauthorized: true,
      pageSizeMax: 50,
      maxVisibleTerms: 65536,
    },
  },
}))
vi.mock('../src/config/env.js', () => ({ config: mockConfig }))

beforeEach(() => {
  clientSpy.mockClear()
  vi.resetModules() // force a fresh getOsClient (its `client` is a module-scoped singleton)
  // Reset ALL mutable config defaults each test so a mid-test failure or a test
  // that mutates mockConfig without a manual restore does not leak into the
  // next test. Individual cases still override specific fields as needed.
  mockConfig.search.opensearchNode = 'http://127.0.0.1:9200'
  mockConfig.search.opensearchUsername = ''
  mockConfig.search.opensearchPassword = ''
  mockConfig.search.opensearchTlsRejectUnauthorized = true
})

async function callGetOsClient(): Promise<void> {
  const mod = await import('../src/search/osClient.js')
  mod.getOsClient()
}

describe('getOsClient — OPENSEARCH_NODE multi-node parsing', () => {
  it('single URL: nodes is [oneUrl]', async () => {
    mockConfig.search.opensearchNode = 'http://127.0.0.1:9200'
    await callGetOsClient()
    const opts = clientSpy.mock.calls[0][0]
    expect(opts.nodes).toEqual(['http://127.0.0.1:9200'])
    expect(opts).not.toHaveProperty('node')
  })

  it('comma-separated URLs: nodes is the parsed list, whitespace trimmed', async () => {
    mockConfig.search.opensearchNode = 'http://a:9200, http://b:9200 ,http://c:9200'
    await callGetOsClient()
    const opts = clientSpy.mock.calls[0][0]
    expect(opts.nodes).toEqual(['http://a:9200', 'http://b:9200', 'http://c:9200'])
  })

  it('trailing/empty commas are dropped (no empty-string node)', async () => {
    mockConfig.search.opensearchNode = 'http://a:9200,,http://b:9200,'
    await callGetOsClient()
    const opts = clientSpy.mock.calls[0][0]
    expect(opts.nodes).toEqual(['http://a:9200', 'http://b:9200'])
  })

  it('empty string throws (never construct a client with zero nodes)', async () => {
    mockConfig.search.opensearchNode = ''
    await expect(callGetOsClient()).rejects.toThrow(/at least one URL/)
    expect(clientSpy).not.toHaveBeenCalled()
  })

  it('all-empty (only commas/whitespace) also throws', async () => {
    mockConfig.search.opensearchNode = ' , ,, '
    await expect(callGetOsClient()).rejects.toThrow(/at least one URL/)
    expect(clientSpy).not.toHaveBeenCalled()
  })

  it('mixed http/https: TLS opt-out applies when any node is https', async () => {
    mockConfig.search.opensearchNode = 'http://a:9200,https://b:9200'
    mockConfig.search.opensearchTlsRejectUnauthorized = false
    await callGetOsClient()
    const opts = clientSpy.mock.calls[0][0]
    expect(opts.ssl).toEqual({ rejectUnauthorized: false })
  })

  it('all http: no ssl config even with opt-out set (ignored)', async () => {
    mockConfig.search.opensearchNode = 'http://a:9200,http://b:9200'
    mockConfig.search.opensearchTlsRejectUnauthorized = false
    await callGetOsClient()
    const opts = clientSpy.mock.calls[0][0]
    expect(opts).not.toHaveProperty('ssl')
  })
})
