import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// Integration test for the bot invite-accept route (docs #61): a real ephemeral
// Express server built from createApp(), exercised over HTTP. The DB layer
// (transaction + the three invite/member repos) and the epoch publisher are
// mocked so no MySQL/Redis is needed; the routing, verifyBot identity injection
// and the shared accept transaction (acceptInviteForUid) all run for real.
//
// It covers acceptance criterion #5:
//   - a bot bearer token accepts on the bot chain and lands in doc_member
//     (role/source=invite) using the uid verifyBot injected — success path,
//   - the human /api/v1/docs accept route is UNCHANGED and still works through
//     the same transaction (no regression),
//   - an invalid/expired invite is rejected 410 for the bot, and an invalid bot
//     token is rejected 401 by verifyBot before the accept service is touched.
// vi.mock factories are hoisted above the module body, so the spies they close
// over must be created via vi.hoisted (also hoisted) rather than plain consts.
const { getForUpdateTx, upsertFromInviteTx } = vi.hoisted(() => ({
  getForUpdateTx: vi.fn(),
  upsertFromInviteTx: vi.fn(async () => {}),
}))

vi.mock('../src/db/pool.js', () => ({
  // acceptInviteForUid runs its body inside transaction(fn); drive fn with a
  // fake tx whose query answers only the two doc_meta reads the flow makes
  // (the member/invite writes go through the mocked repos below).
  transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      query: async (sql: string) => {
        if (/SELECT/i.test(sql) && /document_name/i.test(sql)) {
          return [{ doc_id: 'd1', document_name: 'Doc', owner_id: 'owner', status: 1 }]
        }
        if (/SELECT/i.test(sql) && /permission_epoch/i.test(sql)) {
          return [{ permission_epoch: 1 }]
        }
        return []
      },
    }),
  ),
  query: vi.fn(async () => []),
  getPool: vi.fn(() => ({})),
  closePool: vi.fn(async () => {}),
}))

// Invite lock read — swappable per test (valid row vs. null for invalid/expired).
vi.mock('../src/db/repos/docInviteRepo.js', () => ({
  docInviteRepo: {
    getForUpdateTx,
    setStatusTx: vi.fn(async () => {}),
    incrementUsedCountTx: vi.fn(async () => {}),
  },
  INVITE_STATUS_ACTIVE: 1,
  INVITE_STATUS_REVOKED: 0,
  INVITE_STATUS_EXHAUSTED: 2,
  INVITE_STATUS_EXPIRED: 3,
}))

vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: {
    // fresh member on first accept -> undefined role -> branch "first"
    getRoleTx: vi.fn(async () => undefined),
    upsertFromInviteTx,
  },
}))

vi.mock('../src/db/repos/docInviteRedemptionRepo.js', () => ({
  docInviteRedemptionRepo: {
    existsTx: vi.fn(async () => false),
    insertTx: vi.fn(async () => {}),
  },
}))

vi.mock('../src/permission/epoch.js', () => ({
  refreshAndPublish: vi.fn(async () => {}),
}))

import { createApp } from '../src/api/app.js'
import { setOctoIdentity, type OctoIdentity, type OctoUser } from '../src/auth/octoIdentity.js'

/** Identity stub: individual tests supply verifyToken / verifyBot behavior. */
function stub(overrides: Partial<OctoIdentity>): OctoIdentity {
  return {
    verifyToken: async () => null,
    verifyBot: async () => null,
    getUser: async (): Promise<OctoUser | null> => null,
    getUsers: async (): Promise<OctoUser[]> => [],
    ...overrides,
  }
}

/** An active, non-expired, unlimited-use writer invite. */
function validInvite() {
  return {
    invite_token: 'tok123',
    doc_id: 'd1',
    role: 3, // writer (ordered code 3)
    max_uses: 0,
    used_count: 0,
    status: 1, // ACTIVE
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
    created_by: 'creator',
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
  getForUpdateTx.mockReset()
  upsertFromInviteTx.mockClear()
})

describe('bot invite accept /v1/bot/docs/invites/:token/accept (docs #61)', () => {
  it('a bot token accepts and lands in doc_member as source=invite with the bot uid', async () => {
    getForUpdateTx.mockResolvedValue(validInvite())
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 'bot_1', spaceId: 's_bot' }) }))

    const res = await fetch(`${base}/v1/bot/docs/invites/tok123/accept`, {
      method: 'POST',
      headers: { authorization: 'Bearer bot-tok' },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ docId: 'd1', documentName: 'Doc', role: 'writer' })

    // The member row is written for the verifyBot-injected uid, from the invite
    // (source=invite is baked into upsertFromInviteTx), with the invite's role.
    expect(upsertFromInviteTx).toHaveBeenCalledTimes(1)
    expect(upsertFromInviteTx.mock.calls[0]![1]).toMatchObject({
      docId: 'd1',
      uid: 'bot_1',
      roleNum: 3,
      inviteToken: 'tok123',
    })
  })

  it('rejects the bot with 410 when the invite is invalid/expired (revoked/gone token)', async () => {
    getForUpdateTx.mockResolvedValue(null) // no active invite row
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 'bot_1', spaceId: 's_bot' }) }))

    const res = await fetch(`${base}/v1/bot/docs/invites/gone/accept`, {
      method: 'POST',
      headers: { authorization: 'Bearer bot-tok' },
    })

    expect(res.status).toBe(410)
    expect(await res.json()).toEqual({ error: 'invite_invalid' })
    expect(upsertFromInviteTx).not.toHaveBeenCalled()
  })

  it('rejects an invalid bot token with 401 (verifyBot) before touching the accept service', async () => {
    getForUpdateTx.mockResolvedValue(validInvite())
    setOctoIdentity(stub({ verifyBot: async () => null }))

    const res = await fetch(`${base}/v1/bot/docs/invites/tok123/accept`, {
      method: 'POST',
      headers: { authorization: 'Bearer bad' },
    })

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
    expect(getForUpdateTx).not.toHaveBeenCalled()
    expect(upsertFromInviteTx).not.toHaveBeenCalled()
  })
})

describe('human invite accept /api/v1/docs/invites/:token/accept stays unchanged', () => {
  it('still accepts via the octo session token path and lands the human uid', async () => {
    getForUpdateTx.mockResolvedValue(validInvite())
    setOctoIdentity(stub({ verifyToken: async () => ({ uid: 'u_1' }) }))

    const res = await fetch(`${base}/api/v1/docs/invites/tok123/accept`, {
      method: 'POST',
      headers: { token: 'user-tok' },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ docId: 'd1', documentName: 'Doc', role: 'writer' })
    expect(upsertFromInviteTx.mock.calls[0]![1]).toMatchObject({ uid: 'u_1', roleNum: 2 })
  })

  it('still returns 401 login_required when the session token is invalid', async () => {
    getForUpdateTx.mockResolvedValue(validInvite())
    setOctoIdentity(stub({ verifyToken: async () => null }))

    const res = await fetch(`${base}/api/v1/docs/invites/tok123/accept`, {
      method: 'POST',
      headers: { token: 'bad' },
    })

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'login_required' })
    expect(upsertFromInviteTx).not.toHaveBeenCalled()
  })
})
