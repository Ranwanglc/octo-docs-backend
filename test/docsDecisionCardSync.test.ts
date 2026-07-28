import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Offline unit tests for the access-decision card-sync service (task
// docs-access-decision-card-sync). config, docAccessNotifyCardRepo and
// global.fetch are mocked so we assert, without any DB or octo-server:
//   - config gating (missing internal token => no-op, no fetch)
//   - empty ledger => early return, no HTTP
//   - card-callback path (deciderCardHandledExternally:true) skips the decider's
//     own card; REST path (omitted/false) terminalizes the decider's card too
//   - happy path: every sibling mutated in place, each marked terminalized
//   - mutate failure => re-notify fallback for that card
//   - best-effort: a repo/HTTP failure never throws out of syncDecisionCards
vi.mock('../src/config/env.js', () => ({
  config: {
    octoIdentity: { serverBaseUrl: 'http://octo-server:8080' },
    notify: { docsToken: '', service: 'docs-service' },
    cardDisplayTimeZone: 'Asia/Shanghai',
  },
}))
// The decider's display name is resolved once per decision and forwarded to every
// sibling card. Mock the identity module so these tests stay offline and the fetch
// assertions below count only card mutate / notify calls (the name resolution
// itself is covered by decisionDisplay.test.ts).
const { getUser } = vi.hoisted(() => ({ getUser: vi.fn() }))
vi.mock('../src/auth/octoIdentity.js', () => ({ getOctoIdentity: () => ({ getUser }) }))
vi.mock('../src/db/repos/docAccessNotifyCardRepo.js', () => ({
  NOTIFY_CARD_STATUS_ACTIVE: 1,
  NOTIFY_CARD_STATUS_TERMINALIZED: 2,
  docAccessNotifyCardRepo: {
    listByRequest: vi.fn(async () => []),
    markTerminalized: vi.fn(async () => {}),
  },
}))

import { syncDecisionCards } from '../src/api/services/docsDecisionCardSync.js'
import { config } from '../src/config/env.js'
import { docAccessNotifyCardRepo } from '../src/db/repos/docAccessNotifyCardRepo.js'

const cfg = config as unknown as { notify: { docsToken: string; service: string } }
const repo = docAccessNotifyCardRepo as unknown as {
  listByRequest: ReturnType<typeof vi.fn>
  markTerminalized: ReturnType<typeof vi.fn>
}

function row(recipientUid: string) {
  return {
    request_id: 'req-1',
    recipient_uid: recipientUid,
    channel_id: `ch-${recipientUid}`,
    channel_type: 1,
    message_id: `m-${recipientUid}`,
    client_msg_no: '',
    status: 1,
    created_at: new Date(),
    updated_at: new Date(),
  }
}

function baseParams() {
  return {
    requestId: 'req-1',
    spaceId: 'space-1',
    docId: 'doc-1',
    title: 'Test Doc',
    deciderUid: 'u-owner',
    denied: false,
  }
}

/** Parse the JSON body of the Nth fetch call. */
function bodyOf(fetchMock: ReturnType<typeof vi.fn>, i: number): Record<string, string> {
  return JSON.parse(fetchMock.mock.calls[i][1].body as string) as Record<string, string>
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  cfg.notify.docsToken = 'internal-token'
  repo.listByRequest.mockReset().mockResolvedValue([])
  repo.markTerminalized.mockReset().mockResolvedValue(undefined)
  getUser.mockReset().mockResolvedValue({ uid: 'u-owner', name: '决策人' })
  fetchMock = vi.fn(async () => ({ ok: true, status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('syncDecisionCards', () => {
  it('is a no-op when the internal token is not configured', async () => {
    cfg.notify.docsToken = ''
    await syncDecisionCards(baseParams())
    expect(repo.listByRequest).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns early with no HTTP when the ledger is empty', async () => {
    repo.listByRequest.mockResolvedValue([])
    await syncDecisionCards(baseParams())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('card-callback path skips the decider own card (finalizer handled it)', async () => {
    repo.listByRequest.mockResolvedValue([row('u-owner'), row('u-admin1'), row('u-admin2')])
    await syncDecisionCards({ ...baseParams(), deciderUid: 'u-owner', deciderCardHandledExternally: true })
    // Only the two non-decider siblings are mutated.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const targets = [bodyOf(fetchMock, 0).message_id, bodyOf(fetchMock, 1).message_id].sort()
    expect(targets).toEqual(['m-u-admin1', 'm-u-admin2'])
  })

  it('REST path terminalizes the decider own card too (no finalizer)', async () => {
    repo.listByRequest.mockResolvedValue([row('u-owner'), row('u-admin1'), row('u-admin2')])
    // deciderCardHandledExternally omitted => REST path
    await syncDecisionCards({ ...baseParams(), deciderUid: 'u-owner' })
    // All three cards, INCLUDING the decider's own, are mutated.
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const targets = [
      bodyOf(fetchMock, 0).message_id,
      bodyOf(fetchMock, 1).message_id,
      bodyOf(fetchMock, 2).message_id,
    ].sort()
    expect(targets).toEqual(['m-u-admin1', 'm-u-admin2', 'm-u-owner'])
  })

  it('happy path mutates in place and marks each card terminalized', async () => {
    repo.listByRequest.mockResolvedValue([row('u-admin1'), row('u-admin2')])
    await syncDecisionCards({ ...baseParams(), deciderCardHandledExternally: true })
    // All calls hit the in-place mutate endpoint (not the re-notify fallback).
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toContain('/v1/internal/cards/mutate')
      expect(call[1].headers['X-Internal-Token']).toBe('internal-token')
    }
    expect(repo.markTerminalized).toHaveBeenCalledTimes(2)
  })

  it('forwards the decider identity so sibling cards name the real approver', async () => {
    repo.listByRequest.mockResolvedValue([row('u-admin1'), row('u-admin2')])
    await syncDecisionCards({ ...baseParams(), deciderCardHandledExternally: true })
    // Resolved ONCE for the decider, then reused for every sibling card.
    expect(getUser).toHaveBeenCalledTimes(1)
    expect(getUser.mock.calls[0][0]).toBe('u-owner')
    for (let i = 0; i < fetchMock.mock.calls.length; i++) {
      const body = bodyOf(fetchMock, i)
      expect(body.operator_name).toBe('决策人')
      expect(body.decided_at_display).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    }
  })

  it('still mutates when the decider name cannot be resolved (server keeps generic copy)', async () => {
    getUser.mockResolvedValue(null)
    repo.listByRequest.mockResolvedValue([row('u-admin1')])
    await syncDecisionCards({ ...baseParams(), deciderCardHandledExternally: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(bodyOf(fetchMock, 0).operator_name).toBe('')
    expect(repo.markTerminalized).toHaveBeenCalledTimes(1)
  })

  it('renders the AUTHORITATIVE decision time, not the sync clock', async () => {
    // 2026-07-24 15:35 Asia/Shanghai == 07:35 UTC. Passing the decision time
    // keeps every sibling card on the same minute as the clicked card, which a
    // new Date() at sync time cannot guarantee near a minute boundary.
    const decidedAtSeconds = Math.floor(new Date('2026-07-24T07:35:00.000Z').getTime() / 1000)
    repo.listByRequest.mockResolvedValue([row('u-admin1'), row('u-admin2')])
    await syncDecisionCards({
      ...baseParams(),
      deciderCardHandledExternally: true,
      decidedAtSeconds,
    })
    for (let i = 0; i < fetchMock.mock.calls.length; i++) {
      expect(bodyOf(fetchMock, i).decided_at_display).toBe('2026-07-24 15:35')
    }
  })

  it('reuses a pre-resolved decider name without a second identity lookup', async () => {
    repo.listByRequest.mockResolvedValue([row('u-admin1')])
    await syncDecisionCards({
      ...baseParams(),
      deciderCardHandledExternally: true,
      deciderName: '张三',
    })
    expect(getUser).not.toHaveBeenCalled()
    expect(bodyOf(fetchMock, 0).operator_name).toBe('张三')
  })

  it('carries the decider identity onto the re-notify fallback too', async () => {
    repo.listByRequest.mockResolvedValue([row('u-admin1')])
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/v1/internal/cards/mutate')) return { ok: false, status: 500 }
      return { ok: true, status: 200 }
    })
    await syncDecisionCards({
      ...baseParams(),
      deciderCardHandledExternally: true,
      deciderName: '张三',
      decidedAtSeconds: Math.floor(new Date('2026-07-24T07:35:00.000Z').getTime() / 1000),
    })
    const notifyIdx = fetchMock.mock.calls.findIndex((c) =>
      (c[0] as string).includes('/v1/internal/notify'),
    )
    expect(notifyIdx).toBeGreaterThanOrEqual(0)
    const card = (bodyOf(fetchMock, notifyIdx) as unknown as { docs_card: Record<string, string> })
      .docs_card
    // A card that lands on the fallback must not be the odd one out with a
    // generic label and no time.
    expect(card.actor_name).toBe('张三')
    expect(card.updated_at).toBe('2026-07-24 15:35')
  })

  it('falls back to a fresh terminal card when a mutate fails', async () => {
    repo.listByRequest.mockResolvedValue([row('u-admin1')])
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/v1/internal/cards/mutate')) return { ok: false, status: 500 }
      return { ok: true, status: 200 }
    })
    await syncDecisionCards({ ...baseParams(), deciderCardHandledExternally: true })
    const paths = fetchMock.mock.calls.map((c) => c[0] as string)
    expect(paths.some((p) => p.includes('/v1/internal/cards/mutate'))).toBe(true)
    expect(paths.some((p) => p.includes('/v1/internal/notify'))).toBe(true)
    // A failed mutate must NOT be audited as terminalized.
    expect(repo.markTerminalized).not.toHaveBeenCalled()
  })

  it('carries the deny reason onto the terminal card when denied', async () => {
    repo.listByRequest.mockResolvedValue([row('u-admin1')])
    await syncDecisionCards({
      ...baseParams(),
      denied: true,
      denyReason: '权限不足',
      deciderCardHandledExternally: true,
    })
    expect(bodyOf(fetchMock, 0).deny_reason).toBe('权限不足')
  })

  it('never throws even when the ledger lookup fails (best-effort)', async () => {
    repo.listByRequest.mockRejectedValue(new Error('db down'))
    await expect(syncDecisionCards(baseParams())).resolves.toBeUndefined()
  })
})
