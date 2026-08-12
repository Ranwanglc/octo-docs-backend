import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import type { AddressInfo } from 'node:net'
import { Server } from 'node:http'

// Integration test for the one-service/two-ports surface split
// (config.internalHttpPort + createApp({ surface })).
//
// It proves the property the whole feature rests on: when a deployment runs the
// two listeners, each one serves ONLY its own audience's routes and 404s the
// other's. If a future refactor accidentally re-mounts a bot/internal router on
// the public app, the internal API silently becomes internet-reachable through
// nginx again — that regression is exactly what these assertions catch.
//
// The repos are mocked so no MySQL/Redis is needed; only the mount wiring is
// under test (auth is asserted only as "the guard ran", not re-tested here).
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: {
    listForUser: vi.fn(async () => ({ total: 0, items: [] })),
    getByDocId: vi.fn(),
  },
  DocOwnershipError: class DocOwnershipError extends Error {},
}))
vi.mock('../src/permission/resolveRole.js', () => ({
  resolveRole: vi.fn(async () => 'reader'),
  resolveDocMetaByName: vi.fn(),
}))

import { createApp } from '../src/api/app.js'
import { CARD_ACTION_DECIDE_PATH } from '../src/api/routes/cardActionDecide.js'
import { setOctoIdentity, type OctoIdentity, type OctoUser } from '../src/auth/octoIdentity.js'

/** Identity stub that fails every verify: we only assert WHICH guard answered. */
function denyAllIdentity(): OctoIdentity {
  return {
    verifyToken: async () => null,
    verifyBot: async () => null,
    getUser: async (): Promise<OctoUser | null> => null,
    getUsers: async (): Promise<OctoUser[]> => [],
    isSpaceMember: async () => false,
  }
}

let publicServer: Server
let internalServer: Server
let allServer: Server
let publicBase: string
let internalBase: string
let allBase: string

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

beforeAll(async () => {
  setOctoIdentity(denyAllIdentity())
  // One app per surface, each on its own listener — mirroring src/index.ts, which
  // builds createApp({surface:'public'}) on HTTP_PORT and createApp({surface:
  // 'internal'}) on INTERNAL_HTTP_PORT from the same process.
  publicServer = new Server(createApp({ surface: 'public' }))
  internalServer = new Server(createApp({ surface: 'internal' }))
  allServer = new Server(createApp()) // default 'all': single-listener deployments
  publicBase = await listen(publicServer)
  internalBase = await listen(internalServer)
  allBase = await listen(allServer)
})

afterAll(async () => {
  for (const s of [publicServer, internalServer, allServer]) {
    await new Promise<void>((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())))
  }
})

describe('surface split: public listener', () => {
  it('serves the human metadata API (auth guard answers, so the mount exists)', async () => {
    const res = await fetch(`${publicBase}/api/v1/docs`, { headers: { authorization: 'Bearer x' } })
    expect(res.status).toBe(401) // authMiddleware ran => /api/v1/docs is mounted
  })

  it('serves the PPT contract surface with its enveloped shape', async () => {
    const res = await fetch(`${publicBase}/api/v1/ppt/nope`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'resource not found' } })
  })

  it('does NOT serve the bot surface', async () => {
    const res = await fetch(`${publicBase}/v1/bot/docs`, { headers: { authorization: 'Bearer x' } })
    expect(res.status).toBe(404) // unmounted, NOT 401: verifyBot never runs here
  })

  it('does NOT serve the internal html registration surface', async () => {
    const res = await fetch(`${publicBase}/internal/html/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': 'whatever' },
      body: '{}',
    })
    expect(res.status).toBe(404)
  })

  it('does NOT serve the HMAC card-action callback', async () => {
    const res = await fetch(`${publicBase}${CARD_ACTION_DECIDE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(404) // unmounted, NOT 401 from the signature verify
  })

  it('answers /healthz', async () => {
    const res = await fetch(`${publicBase}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('surface split: internal listener', () => {
  it('serves the bot surface (verifyBot answers, so the mount exists)', async () => {
    const res = await fetch(`${internalBase}/v1/bot/docs`, { headers: { authorization: 'Bearer x' } })
    expect(res.status).toBe(401) // verifyBot ran => /v1/bot/docs is mounted
  })

  it('serves the internal html registration surface (token guard answers)', async () => {
    const res = await fetch(`${internalBase}/internal/html/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': 'wrong' },
      body: '{}',
    })
    expect(res.status).toBe(401) // internal-token guard ran => mount exists
  })

  it('serves the HMAC card-action callback (signature verify answers)', async () => {
    const res = await fetch(`${internalBase}${CARD_ACTION_DECIDE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).not.toBe(404) // the HMAC verify answered, so it is mounted
  })

  it('does NOT serve the human metadata API', async () => {
    const res = await fetch(`${internalBase}/api/v1/docs`, { headers: { authorization: 'Bearer x' } })
    expect(res.status).toBe(404) // unmounted, NOT 401: authMiddleware never runs here
  })

  it('does NOT serve the PPT surface', async () => {
    const res = await fetch(`${internalBase}/api/v1/ppt/docs`)
    expect(res.status).toBe(404)
  })

  it('answers /healthz so the listener stays independently probeable', async () => {
    const res = await fetch(`${internalBase}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe("surface 'all' (default) keeps single-listener deployments unchanged", () => {
  it('serves BOTH the human and the bot surfaces on one listener', async () => {
    const human = await fetch(`${allBase}/api/v1/docs`, { headers: { authorization: 'Bearer x' } })
    const bot = await fetch(`${allBase}/v1/bot/docs`, { headers: { authorization: 'Bearer x' } })
    expect(human.status).toBe(401) // authMiddleware ran
    expect(bot.status).toBe(401) // verifyBot ran
  })

  it('serves the internal html + card-action surfaces too', async () => {
    const html = await fetch(`${allBase}/internal/html/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': 'wrong' },
      body: '{}',
    })
    const card = await fetch(`${allBase}${CARD_ACTION_DECIDE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(html.status).toBe(401)
    expect(card.status).not.toBe(404)
  })
})
