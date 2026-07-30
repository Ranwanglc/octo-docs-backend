import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// Integration check: exercises the REAL outbound path (real global.fetch, real
// TCP round-trip, real JSON serialization) against a live mock of octo-server's
// POST /v1/internal/notify. Only the DB (docMemberRepo) and identity lookup are
// stubbed; config points serverBaseUrl at the live mock server. This proves the
// exact wire request octo-server's docs-notify producer will receive.

// Captured requests from the live server.
type CapturedBody = {
  targets: string[]
  payload?: unknown
  card?: unknown
  docs_card: Record<string, string>
}
const captured: Array<{ headers: Record<string, string | string[] | undefined>; body: CapturedBody }> = []
let server: Server
let baseUrl = ''

vi.mock('../src/config/env.js', () => ({
  config: {
    // serverBaseUrl is patched to the live mock in beforeAll (see below).
    octoIdentity: { get serverBaseUrl() { return baseUrl } },
    notify: { docsToken: 'itok-integration', service: 'docs-service' },
  },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  ROLE_ADMIN: 4,
  docMemberRepo: {
    list: vi.fn(async () => [
      { doc_id: 'doc-1', uid: 'u-admin', role: 4 },
      { doc_id: 'doc-1', uid: 'u-owner', role: 4 },
    ]),
  },
}))
vi.mock('../src/auth/octoIdentity.js', () => ({
  getOctoIdentity: () => ({ getUser: vi.fn(async () => ({ uid: 'u-req', name: '小明' })) }),
}))

import { notifyDocAccessRequested } from '../src/api/services/docsNotify.js'

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/internal/notify') {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        const body = JSON.parse(raw)
        captured.push({ headers: req.headers, body })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        // Echo the single target back as delivered, like octo-server on success.
        res.end(JSON.stringify({ delivered: [body.targets[0]], filtered: {} }))
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('docsNotify integration (real HTTP round-trip)', () => {
  it('delivers to both approvers with the exact contract wire shape', async () => {
    const delivered = await notifyDocAccessRequested({
      docId: 'doc-1',
      requestId: 'req-1',
      spaceId: 'space-1',
      ownerId: 'u-owner',
      title: 'Q3 计划',
      requesterUid: 'u-req',
      reason: '需要编辑权限',
    })

    expect(delivered).toBe(2)
    expect(captured).toHaveLength(2)

    // Every request carried the internal token and the structured docs_card.
    for (const c of captured) {
      expect(c.headers['x-internal-token']).toBe('itok-integration')
      expect(c.headers['content-type']).toContain('application/json')
      expect(c.body.targets).toHaveLength(1)
      expect(c.body.payload).toBeUndefined()
      expect(c.body.card).toBeUndefined()
      expect(c.body.docs_card).toMatchObject({
        doc_id: 'doc-1',
        kind: 'access_requested',
        title: 'Q3 计划',
        actor_name: '小明',
        actor_uid: 'u-req',
        excerpt: '需要编辑权限',
      })
      expect(c.body.docs_card.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    }
    const recipients = captured.map((c) => c.body.targets[0]).sort()
    expect(recipients).toEqual(['u-admin', 'u-owner'])
  })
})
