import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// Integration test for the bot-facing mount (§ v4.3): a real ephemeral Express
// server built from createApp(), exercised over HTTP. The doc-list repo is
// mocked so no MySQL is needed; everything up to and including the metadata
// handler's space scoping runs for real.
//
// It proves the wiring the design requires:
//   - /v1/bot/docs is guarded by verifyBot (bad token => 401),
//   - the bot path needs NO X-Space-Id header — the space is server-injected,
//   - a client-supplied X-Space-Id on the bot path is ignored (anti-spoof),
//   - the human /api/v1/docs chain is unchanged (still hard-400s without a space).
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: {
    listForUser: vi.fn(async () => ({ total: 0, items: [] })),
  },
}))

import { createApp } from '../src/api/app.js'
import { setOctoIdentity, type OctoIdentity, type OctoUser } from '../src/auth/octoIdentity.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'

const listForUser = vi.mocked(docMetaRepo.listForUser)

/** Identity stub: individual tests supply verifyToken / verifyBot behavior. */
function stub(overrides: Partial<OctoIdentity>): OctoIdentity {
  return {
    verifyToken: async () => null,
    verifyBot: async () => null,
    getUser: async (): Promise<OctoUser | null> => null,
    getUsers: async (): Promise<OctoUser[]> => [],
    isSpaceMember: async () => false,
    ...overrides,
  }
}

let server: Server
let base: string

beforeAll(async () => {
  const app = createApp()
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
})

beforeEach(() => {
  listForUser.mockClear()
  listForUser.mockResolvedValue({ total: 0, items: [] })
})

describe('bot mount /v1/bot/docs (§ v4.3)', () => {
  it('rejects the bot path with 401 when the bot token is invalid', async () => {
    setOctoIdentity(stub({ verifyBot: async () => null }))
    const res = await fetch(`${base}/v1/bot/docs`, { headers: { authorization: 'Bearer bad' } })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
    expect(listForUser).not.toHaveBeenCalled()
  })

  it('needs no X-Space-Id: the space is server-injected and reaches the handler', async () => {
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 'bot_1', spaceId: 's_bot' }) }))
    const res = await fetch(`${base}/v1/bot/docs`, { headers: { authorization: 'Bearer ok' } })
    expect(res.status).toBe(200) // NOT 400 space_required
    expect(listForUser).toHaveBeenCalledTimes(1)
    expect(listForUser.mock.calls[0]![0]).toMatchObject({ uid: 'bot_1', spaceId: 's_bot' })
  })

  it('ignores a client-supplied X-Space-Id on the bot path (anti-spoof)', async () => {
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 'bot_1', spaceId: 's_real' }) }))
    const res = await fetch(`${base}/v1/bot/docs`, {
      headers: { authorization: 'Bearer ok', 'X-Space-Id': 's_spoofed' },
    })
    expect(res.status).toBe(200)
    expect(listForUser.mock.calls[0]![0]).toMatchObject({ spaceId: 's_real' })
  })
})

describe('human mount /api/v1/docs stays unchanged', () => {
  it('still hard-400s space_required when X-Space-Id is missing', async () => {
    setOctoIdentity(stub({ verifyToken: async () => ({ uid: 'u_1' }) }))
    const res = await fetch(`${base}/api/v1/docs`, { headers: { token: 'user-tok' } })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'space_required' })
    expect(listForUser).not.toHaveBeenCalled()
  })

  it('scopes the list to the X-Space-Id header on the happy path', async () => {
    // A confirmed member of the queried space: isSpaceMember => true is what
    // opens the share_scope=anyone_in_space branch inside listForUser. The
    // stub's default `false` is the non-member case, covered below — which is
    // narrowed, not refused.
    setOctoIdentity(stub({ verifyToken: async () => ({ uid: 'u_1' }), isSpaceMember: async () => true }))
    const res = await fetch(`${base}/api/v1/docs`, {
      headers: { token: 'user-tok', 'X-Space-Id': 's_human' },
    })
    expect(res.status).toBe(200)
    expect(listForUser.mock.calls[0]![0]).toMatchObject({ uid: 'u_1', spaceId: 's_human' })
  })

  it('does NOT 404 a claimed space the caller is not a member of — it narrows the query instead', async () => {
    // Spoofed header: a valid session token plus an arbitrary space id. The list
    // route deliberately carries NO membership gate (see routes/docs.ts): space
    // membership is not what authorizes a list, the row predicate is. Refusing
    // here would 404 a legitimate cross-space owner / doc_member out of listing
    // their own docs, which the contract forbids (only-adds).
    //
    // The spoof buys nothing: isSpaceMember=false is pushed down, so listForUser
    // never opens the share_scope=anyone_in_space branch for s_someone_elses and
    // the caller sees strictly their own direct grants.
    setOctoIdentity(stub({ verifyToken: async () => ({ uid: 'u_1' }), isSpaceMember: async () => false }))
    const res = await fetch(`${base}/api/v1/docs`, {
      headers: { token: 'user-tok', 'X-Space-Id': 's_someone_elses' },
    })
    expect(res.status).toBe(200)
    expect(listForUser.mock.calls[0]![0]).toMatchObject({
      uid: 'u_1',
      spaceId: 's_someone_elses',
      isSpaceMember: false,
    })
  })
})
