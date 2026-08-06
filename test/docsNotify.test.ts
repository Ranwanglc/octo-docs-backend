import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Offline unit tests for the docs-notify outbound client (octo-server internal
// notify API, PR #584 contract). config, docMemberRepo, octoIdentity and
// global.fetch are mocked so we assert:
//   - config gating (missing internal token => no-op, no fetch)
//   - recipient resolution (owner + admins, de-duped, requester excluded)
//   - request shape: /v1/internal/notify, X-Internal-Token header, single-target
//     docs_card{kind:access_requested, ...} — and NEVER a type-17 payload/card
//   - only delivered[] counts; filtered/500/network failures are swallowed
vi.mock('../src/config/env.js', () => ({
  config: {
    octoIdentity: { serverBaseUrl: 'http://octo-server:8080' },
    notify: { docsToken: '', service: 'docs-service' },
  },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  ROLE_ADMIN: 3,
  docMemberRepo: { list: vi.fn(async () => []) },
}))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: {
    getByDocId: vi.fn(async () => ({
      doc_id: 'doc-1',
      owner_id: 'u-owner',
      space_id: 'space-1',
      share_scope: 0, // restricted (default)
      share_role: 1,
    })),
  },
}))
vi.mock('../src/auth/octoIdentity.js', () => ({
  getOctoIdentity: () => ({ getUser: vi.fn(async () => ({ uid: 'u-req', name: '申请人小明' })) }),
}))

import { notifyDocAccessRequested, notifyDocMentioned, mentionedUserUids } from '../src/api/services/docsNotify.js'
import { config } from '../src/config/env.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'

const cfg = config as unknown as { notify: { docsToken: string; service: string } }

function baseParams() {
  return {
    docId: 'doc-1',
    requestId: 'req-1',
    spaceId: 'space-1',
    ownerId: 'u-owner',
    title: 'Test Doc',
    requesterUid: 'u-req',
    reason: 'need edit',
    botUids: [],
  }
}

function okResp(delivered: string[]) {
  return new Response(JSON.stringify({ delivered, filtered: {} }), { status: 200 })
}

describe('notifyDocAccessRequested', () => {
  beforeEach(() => {
    cfg.notify.docsToken = 'internal-token'
    ;(docMemberRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { doc_id: 'doc-1', uid: 'u-admin', role: 3 },
      { doc_id: 'doc-1', uid: 'u-writer', role: 2 }, // not admin -> excluded
      { doc_id: 'doc-1', uid: 'u-owner', role: 3 }, // duplicate of owner -> de-duped
    ])
    // Echo the single target back in delivered[] so each send counts as delivered.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const uid = JSON.parse(init.body as string).targets[0]
        return okResp([uid])
      }),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('is a no-op when the internal token is unset (no fetch)', async () => {
    cfg.notify.docsToken = ''
    const delivered = await notifyDocAccessRequested(baseParams())
    expect(delivered).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('sends to owner + admins, de-duped, excluding the requester (one request each)', async () => {
    const delivered = await notifyDocAccessRequested(baseParams())
    expect(delivered).toBe(2)
    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(2)
    const recipients = calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).targets[0]).sort()
    expect(recipients).toEqual(['u-admin', 'u-owner'])
  })

  it('hits /v1/internal/notify with X-Internal-Token and a single-target docs_card', async () => {
    await notifyDocAccessRequested(baseParams())
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://octo-server:8080/v1/internal/notify')
    expect((init.headers as Record<string, string>)['X-Internal-Token']).toBe('internal-token')
    const body = JSON.parse(init.body as string)
    expect(body.space_id).toBe('space-1')
    expect(body.service).toBe('docs-service')
    expect(body.targets).toHaveLength(1)
    // Never a hand-built type-17 map — only structured docs_card.
    expect(body.payload).toBeUndefined()
    expect(body.card).toBeUndefined()
    expect(body.docs_card.kind).toBe('access_requested')
    expect(body.docs_card.doc_id).toBe('doc-1')
    expect(body.docs_card.title).toBe('Test Doc')
    expect(body.docs_card.actor_name).toBe('申请人小明')
    expect(body.docs_card.excerpt).toBe('need edit')
    expect(typeof body.docs_card.updated_at).toBe('string')
  })

  it('shows the bot count and every bot uid before approval', async () => {
    await notifyDocAccessRequested({ ...baseParams(), botUids: ['bot_a', 'bot_b'] })
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.docs_card.excerpt).toBe('Bots (2): bot_a, bot_b\nneed edit')
  })

  it('caps access-request excerpts at 300 runes while always retaining the bot count', async () => {
    await notifyDocAccessRequested({
      ...baseParams(),
      reason: '理'.repeat(400),
      botUids: Array.from({ length: 50 }, (_, i) => `bot_${i}_${'😀'.repeat(20)}`),
    })
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    const excerpt = JSON.parse(init.body as string).docs_card.excerpt as string
    expect([...excerpt]).toHaveLength(300)
    expect(excerpt.startsWith('Bots (50)')).toBe(true)
  })

  it('counts only delivered[]; a filtered recipient is not counted', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(okResp(['u-owner'])) // delivered
        .mockResolvedValueOnce(new Response(JSON.stringify({ delivered: [], filtered: { 'u-admin': 'busy' } }), { status: 200 })),
    )
    const delivered = await notifyDocAccessRequested(baseParams())
    expect(delivered).toBe(1)
  })

  it('never throws on a 500 or network error (best-effort)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    expect(await notifyDocAccessRequested(baseParams())).toBe(0)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    expect(await notifyDocAccessRequested(baseParams())).toBe(0)
  })
})

describe('mentionedUserUids', () => {
  it('extracts unique user uids, ignores doc mentions, excludes the author', () => {
    const body = 'hi @[user:u_1:Alice] and @[doc:d_9:Plan] cc @[user:u_2:Bob] and @[user:u_1:Alice] again'
    expect(mentionedUserUids(body, 'u_author')).toEqual(['u_1', 'u_2'])
  })
  it('excludes the author (no self-notify)', () => {
    expect(mentionedUserUids('@[user:u_1:Me] @[user:u_2:You]', 'u_1')).toEqual(['u_2'])
  })
  it('returns [] when there are no mentions', () => {
    expect(mentionedUserUids('just plain text', 'u_1')).toEqual([])
  })
})

describe('notifyDocMentioned', () => {
  function mentionParams() {
    return {
      docId: 'doc-1',
      spaceId: 'space-1',
      title: 'Test Doc',
      authorUid: 'u-req', // commenter; excluded + actor
      body: 'see this @[user:u_1:Alice] and @[user:u_2:Bob]',
    }
  }
  beforeEach(() => {
    cfg.notify.docsToken = 'internal-token'
    // Restricted doc (default mock) whose readers are owner + these doc_members;
    // u_1/u_2 are members so they're authorized recipients.
    ;(docMetaRepo.getByDocId as ReturnType<typeof vi.fn>).mockResolvedValue({
      doc_id: 'doc-1',
      owner_id: 'u-owner',
      space_id: 'space-1',
      share_scope: 0,
      share_role: 1,
    })
    ;(docMemberRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { doc_id: 'doc-1', uid: 'u_1', role: 1 },
      { doc_id: 'doc-1', uid: 'u_2', role: 2 },
    ])
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => okResp([JSON.parse(init.body as string).targets[0]])),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('is a no-op when the internal token is unset (no fetch)', async () => {
    cfg.notify.docsToken = ''
    expect(await notifyDocMentioned(mentionParams())).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('is a no-op when nobody is mentioned', async () => {
    expect(await notifyDocMentioned({ ...mentionParams(), body: 'no mentions here' })).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('sends a commented docs_card to each mentioned user (one request each)', async () => {
    const delivered = await notifyDocMentioned(mentionParams())
    expect(delivered).toBe(2)
    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls
    const recipients = calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).targets[0]).sort()
    expect(recipients).toEqual(['u_1', 'u_2'])
    const body = JSON.parse((calls[0]![1] as RequestInit).body as string)
    expect(body.docs_card.kind).toBe('commented')
    expect(body.docs_card.doc_id).toBe('doc-1')
    expect(body.payload).toBeUndefined()
    expect(body.card).toBeUndefined()
    // Excerpt collapses tokens to @label (no raw @[...] leaks into the card).
    expect(body.docs_card.excerpt).toBe('see this @Alice and @Bob')
  })

  it('never throws on a 500 or network error (best-effort)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    expect(await notifyDocMentioned(mentionParams())).toBe(0)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    expect(await notifyDocMentioned(mentionParams())).toBe(0)
  })

  // ── P0 regression: recipient authorization by doc read-access ──────────────
  it('on a restricted doc, does NOT notify a mentioned user who is not a doc member (info-leak guard)', async () => {
    // u_2 is NOT a doc member here — only u_1 (+ owner) can read the restricted doc.
    ;(docMemberRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { doc_id: 'doc-1', uid: 'u_1', role: 1 },
    ])
    const delivered = await notifyDocMentioned(mentionParams())
    expect(delivered).toBe(1)
    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls
    const recipients = calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).targets[0])
    expect(recipients).toEqual(['u_1'])
    expect(recipients).not.toContain('u_2') // same-space non-member never notified
  })

  it('notifies the doc owner when mentioned even without a doc_member row', async () => {
    ;(docMemberRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const delivered = await notifyDocMentioned({
      ...mentionParams(),
      body: 'ping @[user:u-owner:Owner]',
    })
    expect(delivered).toBe(1)
    const recipients = (fetch as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => JSON.parse((c[1] as RequestInit).body as string).targets[0],
    )
    expect(recipients).toEqual(['u-owner'])
  })

  it('on an anyone_in_space doc, notifies all mentioned (server does space-level filtering)', async () => {
    ;(docMetaRepo.getByDocId as ReturnType<typeof vi.fn>).mockResolvedValue({
      doc_id: 'doc-1',
      owner_id: 'u-owner',
      space_id: 'space-1',
      share_scope: 1, // anyone_in_space
      share_role: 1,
    })
    ;(docMemberRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([]) // no member rows needed
    const delivered = await notifyDocMentioned(mentionParams())
    expect(delivered).toBe(2)
    const recipients = (fetch as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => JSON.parse((c[1] as RequestInit).body as string).targets[0])
      .sort()
    expect(recipients).toEqual(['u_1', 'u_2'])
  })

  it('fails closed (notifies no one) when the doc row is missing', async () => {
    ;(docMetaRepo.getByDocId as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    expect(await notifyDocMentioned(mentionParams())).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  // ── P1 regression: fan-out is capped ───────────────────────────────────────
  it('caps the recipient fan-out at MAX_MENTION_RECIPIENTS (50)', async () => {
    // 200 unique mentioned users, all authorized readers of an anyone_in_space doc.
    ;(docMetaRepo.getByDocId as ReturnType<typeof vi.fn>).mockResolvedValue({
      doc_id: 'doc-1',
      owner_id: 'u-owner',
      space_id: 'space-1',
      share_scope: 1,
      share_role: 1,
    })
    const body = Array.from({ length: 200 }, (_, i) => `@[user:u_${i}:Name${i}]`).join(' ')
    const delivered = await notifyDocMentioned({ ...mentionParams(), body })
    expect(delivered).toBe(50)
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(50)
  })
})
