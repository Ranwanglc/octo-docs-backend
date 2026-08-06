import { describe, it, expect, vi, beforeEach } from 'vitest'

// grantRequestWithBots fans an approval out to the requester + each carried bot
// via the shared grantForwardAccess core, isolating per-bot failures. We mock
// grantForward so we assert the fan-out, isolation, and self-collision skip
// without touching the DB.
vi.mock('../src/api/services/grantForward.js', () => ({
  grantForwardAccess: vi.fn(async () => ({ finalRole: 'writer', changed: true })),
}))
vi.mock('../src/api/services/botGrantAudit.js', () => ({
  logBotGrantFailure: vi.fn(),
}))

import { grantRequestWithBots } from '../src/api/services/grantRequestWithBots.js'
import { grantForwardAccess } from '../src/api/services/grantForward.js'
import { logBotGrantFailure } from '../src/api/services/botGrantAudit.js'

const base = {
  docId: 'd_1',
  requestId: 'req_1',
  documentName: 'dn-1',
  uid: 'u_req',
  roleNum: 2,
  grantedBy: 'u_admin',
}

beforeEach(() => {
  vi.mocked(grantForwardAccess).mockReset()
  vi.mocked(grantForwardAccess).mockResolvedValue({ finalRole: 'writer', changed: true })
})

describe('grantRequestWithBots', () => {
  it('grants the requester then each bot at the same role', async () => {
    const out = await grantRequestWithBots({ ...base, botUids: ['bot_a', 'bot_b'] })
    expect(out).toEqual({ requesterRole: 'writer', botsSucceeded: ['bot_a', 'bot_b'], botsFailed: [] })
    expect(vi.mocked(grantForwardAccess)).toHaveBeenCalledTimes(3)
    for (const uid of ['u_req', 'bot_a', 'bot_b']) {
      expect(vi.mocked(grantForwardAccess)).toHaveBeenCalledWith(expect.objectContaining({ uid, roleNum: 2 }))
    }
  })

  it('isolates a per-bot failure: others still granted, request result carries failed', async () => {
    vi.mocked(grantForwardAccess).mockImplementation(async (p: { uid: string }) => {
      if (p.uid === 'bot_bad') throw new Error('boom')
      return { finalRole: 'writer', changed: true }
    })
    const out = await grantRequestWithBots({ ...base, botUids: ['bot_a', 'bot_bad', 'bot_c'] })
    expect(out.botsSucceeded).toEqual(['bot_a', 'bot_c'])
    expect(out.botsFailed).toEqual(['bot_bad'])
    expect(vi.mocked(logBotGrantFailure)).toHaveBeenCalledWith({
      docId: 'd_1',
      requestId: 'req_1',
      botUid: 'bot_bad',
      error: expect.objectContaining({ message: 'boom' }),
    })
  })

  it('a failing REQUESTER grant propagates (primary op, not swallowed)', async () => {
    vi.mocked(grantForwardAccess).mockImplementation(async (p: { uid: string }) => {
      if (p.uid === 'u_req') throw new Error('requester grant failed')
      return { finalRole: 'writer', changed: true }
    })
    await expect(grantRequestWithBots({ ...base, botUids: ['bot_a'] })).rejects.toThrow('requester grant failed')
  })

  it('skips a bot uid equal to the requester (no double-count)', async () => {
    const out = await grantRequestWithBots({ ...base, botUids: ['u_req', 'bot_a'] })
    // u_req is granted once as the requester; the self-collision bot entry is skipped.
    expect(out.botsSucceeded).toEqual(['bot_a'])
    expect(vi.mocked(grantForwardAccess)).toHaveBeenCalledTimes(2)
  })

  it('zero bots => only the requester is granted, empty arrays', async () => {
    const out = await grantRequestWithBots({ ...base, botUids: [] })
    expect(out).toEqual({ requesterRole: 'writer', botsSucceeded: [], botsFailed: [] })
    expect(vi.mocked(grantForwardAccess)).toHaveBeenCalledTimes(1)
  })

  it('tolerates an undefined snapshot (defense-in-depth) as zero bots', async () => {
    const out = await grantRequestWithBots({ ...base, botUids: undefined })
    expect(out.botsSucceeded).toEqual([])
    expect(vi.mocked(grantForwardAccess)).toHaveBeenCalledTimes(1)
  })
})
