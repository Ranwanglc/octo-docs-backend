import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import type { AddressInfo } from 'node:net'
import { Server, createServer as createHttpServer } from 'node:http'

// Integration test for the one-service/two-ports surface split
// (config.internalHttpPort + createApp({ surface })).
//
// It proves the property the whole feature rests on: when a deployment runs the
// two listeners, each one serves ONLY its own audience's routes and 404s the
// other's. The membership rule under test is deliberately conservative — a route
// is internal-only when EVERY caller is provably in-network:
//
//   internal: /internal/html   (the html service, shared internal token)
//   public:   everything else, INCLUDING /v1/bot/docs and the HMAC card-action
//             callback — both have callers that can live off our network (bot
//             token holders, octo-server), so moving them would hard-404 them.
//
// If a future refactor moves /v1/bot/docs or the card-action callback onto the
// internal surface, off-network callers break the moment the split is enabled;
// if it re-mounts /internal/html on the public app, the registration endpoint
// becomes internet-reachable through nginx again. Both regressions are what
// these assertions catch.
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
import { attachBindGuard } from '../src/api/bindGuard.js'
import { parseTcpPort } from '../src/config/env.js'
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

  it('KEEPS serving the bot surface: its clients are not all in-network', async () => {
    const res = await fetch(`${publicBase}/v1/bot/docs`, { headers: { authorization: 'Bearer x' } })
    // 401, not 404: verifyBot ran => /v1/bot/docs is still mounted here. This
    // prefix is published through the public gateway today (that is why it
    // exists), and off-network bot-token callers cannot be repointed, so enabling
    // the split must NOT move it.
    expect(res.status).toBe(401)
  })

  it('KEEPS serving the HMAC card-action callback: octo-server may be off-network', async () => {
    const res = await fetch(`${publicBase}${CARD_ACTION_DECIDE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    // 401 from the signature verify, not 404: the route is mounted and the HMAC
    // (not network position) is the authenticator. A 404 here would mean every
    // 同意/拒绝 tap breaks in a cross-network deployment.
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  it('does NOT serve the internal html registration surface', async () => {
    const res = await fetch(`${publicBase}/internal/html/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': 'whatever' },
      body: '{}',
    })
    expect(res.status).toBe(404) // unmounted, NOT 401: the token guard never runs here
  })

  it('answers /healthz', async () => {
    const res = await fetch(`${publicBase}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('keeps the signed attachment blob gateway on this surface only', async () => {
    // A signed-looking blob request (X-Method + X-Signature query params) is
    // claimed by the gateway on the public app, and must NOT be claimed on the
    // internal one — the browser talks to the blob origin directly.
    //
    // The public assertion is an exact 403 with the gateway's own body, NOT
    // `[200,403,404]`: 404 is also what an UNMOUNTED route returns, so accepting
    // it would let the very regression this test exists to catch (dropping
    // `servePublic &&` from the gateway mount) pass. ATTACHMENT_DRIVER defaults to
    // local-hmac, so the gateway is enabled here and rejects a bogus signature
    // with 403 `invalid_signature` — a body no unmounted path can produce.
    const path = '/attachments/blob/whatever?X-Method=GET&X-Signature=deadbeef'
    const pub = await fetch(`${publicBase}${path}`)
    expect(pub.status).toBe(403)
    expect(await pub.json()).toMatchObject({ error: 'invalid_signature' })

    const internal = await fetch(`${internalBase}${path}`)
    expect(internal.status).toBe(404) // gateway not mounted on the internal surface
  })
})

describe('surface split: internal listener', () => {
  it('serves the internal html registration surface (token guard answers)', async () => {
    const res = await fetch(`${internalBase}/internal/html/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': 'wrong' },
      body: '{}',
    })
    expect(res.status).toBe(401) // internal-token guard ran => mount exists
  })

  it('does NOT serve the human metadata API', async () => {
    const res = await fetch(`${internalBase}/api/v1/docs`, { headers: { authorization: 'Bearer x' } })
    expect(res.status).toBe(404) // unmounted, NOT 401: authMiddleware never runs here
  })

  it('does NOT serve the PPT surface', async () => {
    const res = await fetch(`${internalBase}/api/v1/ppt/docs`)
    expect(res.status).toBe(404)
  })

  it('does NOT serve the bot surface (it stayed public)', async () => {
    const res = await fetch(`${internalBase}/v1/bot/docs`, { headers: { authorization: 'Bearer x' } })
    expect(res.status).toBe(404) // unmounted, NOT 401: verifyBot never runs here
  })

  it('does NOT serve the card-action callback (it stayed public)', async () => {
    const res = await fetch(`${internalBase}${CARD_ACTION_DECIDE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(404) // unmounted, NOT 401 from the signature verify
  })

  it('answers /healthz so the listener stays independently probeable', async () => {
    const res = await fetch(`${internalBase}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('does NOT trust X-Forwarded-For (in-network callers cannot spoof the limiter key)', () => {
    // Headline security property of the split: the internal listener is not behind
    // nginx, so honouring XFF there would let any sibling container rotate its
    // apparent IP and walk past the per-IP rate limiter.
    const internalApp = createApp({ surface: 'internal' })
    expect(internalApp.get('trust proxy')).toBe(false)
    // An explicit override still wins, for a deployment that does front the
    // internal port with a mesh sidecar.
    expect(createApp({ surface: 'internal', trustProxy: 1 }).get('trust proxy')).toBe(1)
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
    expect(card.status).toBe(401)
  })
})

describe('boot-time port validation (config + src/index.ts wiring)', () => {
  // The port guards live in src/index.ts, which cannot be imported without a live
  // MySQL/Redis. These tests exercise the two pieces that are importable —
  // the strict env parser, and the "a failed second bind must not be swallowed"
  // Node semantics the index.ts error handler relies on.
  it('rejects a non-port INTERNAL_HTTP_PORT instead of silently changing the split state', () => {
    // num() would return -9090 / 0 here, leaving `internalHttpPort > 0` false: the
    // operator sets the variable, boot succeeds, and the split is silently OFF.
    // The hex/exponent/sign forms are worse than that: they coerce to a valid
    // number, so boot succeeds and binds a port the operator never wrote.
    for (const bad of ['-9090', '70000', '9090.5', 'nope', '0x2382', '9.09e3', '+9090', '90 90']) {
      expect(() => parseTcpPort('INTERNAL_HTTP_PORT', bad, 0)).toThrow(/INTERNAL_HTTP_PORT/)
    }
    // Unset / whitespace-only mean "not configured" and keep the documented
    // default, exactly as `INTERNAL_HTTP_PORT=` in an env file behaves. This is
    // the one intentionally non-strict case; every doc that describes the parser
    // says so rather than claiming whitespace aborts boot.
    expect(parseTcpPort('INTERNAL_HTTP_PORT', undefined, 0)).toBe(0)
    expect(parseTcpPort('INTERNAL_HTTP_PORT', '  ', 0)).toBe(0)
    // Plain decimals pass, with or without surrounding whitespace.
    expect(parseTcpPort('INTERNAL_HTTP_PORT', '0', 0)).toBe(0)
    expect(parseTcpPort('INTERNAL_HTTP_PORT', '9090', 0)).toBe(9090)
    expect(parseTcpPort('INTERNAL_HTTP_PORT', ' 9090 ', 0)).toBe(9090)
    expect(parseTcpPort('INTERNAL_HTTP_PORT', '65535', 0)).toBe(65535)
  })

  it('a second listener bind failure emits an error event (so the guard can exit(1))', async () => {
    // Proves the failure mode is observable via 'error' rather than only via the
    // deliberately non-fatal uncaughtException handler in src/index.ts.
    const blocker = createHttpServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const { port } = blocker.address() as AddressInfo
    const second = new Server(createApp({ surface: 'internal' }))
    const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
      second.on('error', resolve)
      second.listen(port, '127.0.0.1')
    })
    expect(err.code).toBe('EADDRINUSE')
    second.close()
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
  })
})

// The guard that turns that 'error' event into an exit lives in its own module
// precisely so it can be tested without live MySQL/Redis (importing src/index.ts
// needs both). These tests exercise attachBindGuard itself, not Node's semantics.
describe('attachBindGuard: bind failures are fatal, post-bind socket errors are not', () => {
  /** Collects the guard's decisions instead of killing the test runner. */
  function spyHooks() {
    const exits: number[] = []
    const logs: string[] = []
    return {
      exits,
      logs,
      hooks: {
        exit: ((code: number) => {
          exits.push(code)
          // Real process.exit never returns; the guard `return`s right after it,
          // so a throwing stub is unnecessary and would mask the log assertion.
          return undefined as never
        }) as (code: number) => never,
        logError: (message: string) => {
          logs.push(message)
        },
      },
    }
  }

  it('exits(1) when the port is already taken (pre-listening error)', async () => {
    const blocker = createHttpServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const { port } = blocker.address() as AddressInfo

    const { exits, logs, hooks } = spyHooks()
    const guarded = createHttpServer()
    attachBindGuard(guarded, `test listener :${port}`, hooks)
    await new Promise<void>((resolve) => {
      guarded.on('error', () => resolve()) // our own listener just unblocks the await
      guarded.listen(port, '127.0.0.1')
    })

    expect(exits).toEqual([1])
    expect(logs[0]).toContain('failed to bind')
    guarded.close()
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
  })

  it('does NOT exit on an accept-level error after a successful bind, and keeps serving', async () => {
    // THE REGRESSION THIS FILE EXISTS FOR. `net.Server` routes accept failures to
    // the same 'error' event as bind failures, for the whole process lifetime:
    //   function onconnection(err) { if (err) self.emit('error', new ErrnoException(err, 'accept')) }
    // An unconditional process.exit(1) therefore kills a healthy, already-serving
    // node on FD exhaustion (EMFILE/ENFILE) and bypasses the graceful shutdown in
    // index.ts, so in-memory Yjs docs are never flushed. Before the split feature
    // there was no 'error' listener at all and such an error was non-fatal; that
    // posture must be preserved.
    const { exits, logs, hooks } = spyHooks()
    const app = createApp({ surface: 'all' })
    const server = new Server(app)
    attachBindGuard(server, 'test listener', hooks)
    const base = await listen(server)

    const emfile: NodeJS.ErrnoException = new Error('accept EMFILE')
    emfile.code = 'EMFILE'
    emfile.syscall = 'accept'
    server.emit('error', emfile) // exactly what net.js does on an accept failure

    expect(exits).toEqual([]) // still alive
    expect(logs.some((m) => m.includes('non-fatal, still serving'))).toBe(true)

    // And it really is still serving.
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  })

  it('is installed on BOTH listeners, so neither can half-serve', () => {
    // Guards against the asymmetry that shipped in the first revision: the public
    // listener's handler was registered outside the INTERNAL_HTTP_PORT block, so
    // it changed behaviour for every deployment including those with the flag off.
    // Both listeners must end up with exactly one guarded 'error' handler.
    for (const surface of ['public', 'internal'] as const) {
      const server = new Server(createApp({ surface }))
      const listeningBefore = server.listenerCount('listening')
      expect(server.listenerCount('error')).toBe(0)
      attachBindGuard(server, `test ${surface}`, spyHooks().hooks)
      expect(server.listenerCount('error')).toBe(1)
      // ...and exactly one added 'listening' hook (the bind/serve phase latch).
      expect(server.listenerCount('listening')).toBe(listeningBefore + 1)
    }
  })
})
