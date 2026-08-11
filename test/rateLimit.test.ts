import { describe, it, expect, beforeEach } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// Wiring test for the per-IP rate limiter (§8.4). Proves the limiter is mounted
// on BOTH REST chains and that /healthz is exempt. A tiny per-IP budget is
// injected so the limit is reachable in a handful of requests; the limiter runs
// ahead of auth/verifyBot, so unauthenticated requests still count toward it and
// the Nth request is rejected with 429 before any handler runs.
import { createApp } from '../src/api/app.js'
import { setOctoIdentity, type OctoIdentity, type OctoUser } from '../src/auth/octoIdentity.js'

function stub(overrides: Partial<OctoIdentity>): OctoIdentity {
  return {
    verifyToken: async () => null,
    verifyBot: async () => null,
    getUser: async (): Promise<OctoUser | null> => null,
    getUsers: async (): Promise<OctoUser[]> => [],
    ...overrides,
  }
}

async function withServer(app: ReturnType<typeof createApp>, fn: (base: string) => Promise<void>): Promise<void> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  try {
    const { port } = server.address() as AddressInfo
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  }
}

beforeEach(() => {
  // Both identities reject, so every non-health request 401s — but the limiter
  // runs first, so requests are counted regardless of the auth outcome.
  setOctoIdentity(stub({}))
})

describe('rate limiter (§8.4)', () => {
  it('throttles the human /api/v1/docs chain per IP', async () => {
    const app = createApp({ rateLimit: { windowMs: 60_000, max: 2 } })
    await withServer(app, async (base) => {
      const first = await fetch(`${base}/api/v1/docs`, { headers: { token: 'x' } })
      const second = await fetch(`${base}/api/v1/docs`, { headers: { token: 'x' } })
      const third = await fetch(`${base}/api/v1/docs`, { headers: { token: 'x' } })
      expect(first.status).not.toBe(429)
      expect(second.status).not.toBe(429)
      expect(third.status).toBe(429)
      expect(await third.json()).toEqual({ error: 'rate_limited' })
    })
  })

  it('throttles the bot /v1/bot/docs chain per IP', async () => {
    const app = createApp({ rateLimit: { windowMs: 60_000, max: 2 } })
    await withServer(app, async (base) => {
      const first = await fetch(`${base}/v1/bot/docs`, { headers: { authorization: 'Bearer x' } })
      const second = await fetch(`${base}/v1/bot/docs`, { headers: { authorization: 'Bearer x' } })
      const third = await fetch(`${base}/v1/bot/docs`, { headers: { authorization: 'Bearer x' } })
      expect(first.status).not.toBe(429)
      expect(second.status).not.toBe(429)
      expect(third.status).toBe(429)
    })
  })

  it('throttles the internal HTML registration chain per IP', async () => {
    const app = createApp({ rateLimit: { windowMs: 60_000, max: 2 } })
    await withServer(app, async (base) => {
      const options = { method: 'POST', headers: { 'x-internal-token': 'wrong' } }
      const first = await fetch(`${base}/internal/html/register`, options)
      const second = await fetch(`${base}/internal/html/register`, options)
      const third = await fetch(`${base}/internal/html/register`, options)
      expect(first.status).toBe(401)
      expect(second.status).toBe(401)
      expect(third.status).toBe(429)
      expect(await third.json()).toEqual({ error: 'rate_limited' })
    })
  })

  it('never throttles /healthz', async () => {
    const app = createApp({ rateLimit: { windowMs: 60_000, max: 2 } })
    await withServer(app, async (base) => {
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${base}/healthz`)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
      }
    })
  })

  it('keys per real client IP behind a proxy (X-Forwarded-For), not the proxy address', async () => {
    // trustProxy=1 => req.ip is taken from X-Forwarded-For (one nginx hop), so
    // two different upstream clients get independent budgets instead of sharing
    // one bucket keyed on the proxy socket address.
    const app = createApp({ rateLimit: { windowMs: 60_000, max: 2 }, trustProxy: 1 })
    await withServer(app, async (base) => {
      const clientA = { 'X-Forwarded-For': '203.0.113.10' }
      const clientB = { 'X-Forwarded-For': '203.0.113.20' }
      // Client A exhausts its own budget.
      expect((await fetch(`${base}/api/v1/docs`, { headers: clientA })).status).not.toBe(429)
      expect((await fetch(`${base}/api/v1/docs`, { headers: clientA })).status).not.toBe(429)
      expect((await fetch(`${base}/api/v1/docs`, { headers: clientA })).status).toBe(429)
      // Client B is unaffected — a separate bucket, proving keying is per client IP.
      expect((await fetch(`${base}/api/v1/docs`, { headers: clientB })).status).not.toBe(429)
    })
  })
})
