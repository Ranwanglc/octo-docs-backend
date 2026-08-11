import type { Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.OCTO_DOCS_HTML_REGISTRATION_TOKEN = 'html-registration-test-token'
  process.env.SEARCH_INDEX_ENABLED = 'true'
})

vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  DocOwnershipError: class DocOwnershipError extends Error {},
  docMetaRepo: {
    upsertHtmlByOctoDocSlug: vi.fn(),
  },
}))
vi.mock('../src/search/docIndexQueue.js', () => ({
  enqueueDocIndex: vi.fn(),
  isSearchIndexedDoc: vi.fn(() => true),
}))

import { createApp } from '../src/api/app.js'
import { config } from '../src/config/env.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { enqueueDocIndex } from '../src/search/docIndexQueue.js'

let server: Server
let base: string
const body = { octoDocSlug: 'published-page', spaceId: 'space-1', owner: 'user-1', title: 'Page' }
const headers = { 'content-type': 'application/json', 'x-internal-token': 'internal-test-token' }
const existing = {
  doc_id: 'd_existing', document_name: 'octo:space-1:f_default:html:d_existing',
  owner_id: 'user-1', space_id: 'space-1', title: 'Page', status: 1,
}

beforeAll(async () => {
  config.htmlRegistration.token = 'internal-test-token'
  const app = createApp()
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test address')
  base = `http://127.0.0.1:${address.port}`
})
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
})
beforeEach(() => vi.clearAllMocks())

describe('internal HTML lifecycle through createApp', () => {
  it.each([true, false])('parses JSON and enqueues create/idempotent update (created=%s)', async (created) => {
    config.search.indexEnabled = true
    vi.mocked(docMetaRepo.upsertHtmlByOctoDocSlug).mockResolvedValue({ meta: existing, created } as never)
    const response = await fetch(`${base}/internal/html/register`, {
      method: 'POST', headers, body: JSON.stringify(body),
    })
    expect(response.status).toBe(created ? 201 : 200)
    expect(await response.json()).toMatchObject({ owner: 'user-1', created })
    expect(enqueueDocIndex).toHaveBeenCalledWith(existing.document_name)
  })

  it('does not enqueue when search indexing is disabled', async () => {
    config.search.indexEnabled = false
    vi.mocked(docMetaRepo.upsertHtmlByOctoDocSlug).mockResolvedValue({ meta: existing, created: true } as never)
    const response = await fetch(`${base}/internal/html/register`, {
      method: 'POST', headers, body: JSON.stringify(body),
    })
    expect(response.status).toBe(201)
    expect(enqueueDocIndex).not.toHaveBeenCalled()
    config.search.indexEnabled = true
  })

  it('routes an unexpected async registration failure to central JSON 500', async () => {
    vi.mocked(docMetaRepo.upsertHtmlByOctoDocSlug).mockRejectedValue(new Error('database unavailable'))
    const response = await fetch(`${base}/internal/html/register`, {
      method: 'POST', headers, body: JSON.stringify(body),
    })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'internal_error' })
  })

  it('does not expose a DELETE lifecycle route', async () => {
    const response = await fetch(`${base}/internal/html`, {
      method: 'DELETE', headers, body: JSON.stringify(body),
    })
    expect([404, 405]).toContain(response.status)
  })
})
