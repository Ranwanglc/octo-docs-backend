import { describe, it, expect, vi, afterEach } from 'vitest'
import { HttpOctoIdentity } from '../src/auth/octoIdentity.js'

// ownedBotsInSpace resolves the caller's owned_bots_by_space[spaceId] by reusing
// POST /v1/auth/verify?include=context (the caller's own token IS the auth). It
// is FAIL-CLOSED: any transport failure / non-200 / malformed body / missing
// context / token-uid mismatch yields [] so a non-empty submitted bot set is
// then rejected rather than authorized.
function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HttpOctoIdentity.ownedBotsInSpace', () => {
  it('extracts the caller\u2019s bots for THE requested space and normalizes them', async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        uid: 'u_h',
        context_included: true,
        owned_bots_by_space: {
          s_1: ['bot_b', 'bot_a', 'bot_c'],
          s_2: ['bot_other'],
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const identity = new HttpOctoIdentity('http://octo.test')
    const out = await identity.ownedBotsInSpace('u_h', 's_1', 'tok')
    // Only s_1's bots, sorted. s_2 is never leaked cross-space.
    expect(out).toEqual(['bot_a', 'bot_b', 'bot_c'])
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe('http://octo.test/v1/auth/verify?include=context')
    expect(JSON.parse(init.body as string)).toEqual({ token: 'tok' })
  })

  it('fail-closed (whole list): a duplicate / illegal element in the space list => []', async () => {
    // The space list is trusted as a WHOLE: any duplicate or illegal element
    // collapses it to [] (never a partial set) so a garbled body authorizes
    // nothing rather than something partial.
    const identity = new HttpOctoIdentity('http://octo.test')
    vi.stubGlobal('fetch', vi.fn(async () =>
      okResponse({ uid: 'u_h', context_included: true, owned_bots_by_space: { s_1: ['bot_a', 'bot_a'] } }),
    ))
    expect(await identity.ownedBotsInSpace('u_h', 's_1', 'tok')).toEqual([])
    vi.stubGlobal('fetch', vi.fn(async () =>
      okResponse({ uid: 'u_h', context_included: true, owned_bots_by_space: { s_1: ['bot_a', 1] } }),
    ))
    expect(await identity.ownedBotsInSpace('u_h', 's_1', 'tok')).toEqual([])
    vi.stubGlobal('fetch', vi.fn(async () =>
      okResponse({ uid: 'u_h', context_included: true, owned_bots_by_space: { s_1: ['bot_a', ' bot_b'] } }),
    ))
    expect(await identity.ownedBotsInSpace('u_h', 's_1', 'tok')).toEqual([])
  })

  it('not count-capped: an owner of > 50 bots gets the FULL authoritative set', async () => {
    // The request-body snapshot is what MAX_BOT_UIDS (50) caps; the authoritative
    // owned set is not, so an owner whose target bot sits past 50 is not misjudged.
    const many = Array.from({ length: 60 }, (_, i) => `bot_${String(i).padStart(3, '0')}`)
    vi.stubGlobal('fetch', vi.fn(async () =>
      okResponse({ uid: 'u_h', context_included: true, owned_bots_by_space: { s_1: many } }),
    ))
    const identity = new HttpOctoIdentity('http://octo.test')
    const out = await identity.ownedBotsInSpace('u_h', 's_1', 'tok')
    expect(out.length).toBe(60)
    expect(out).toContain('bot_055') // a target past the 50-cap is present
  })

  it('returns [] when the space has no owned bots (absent map key)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      okResponse({ uid: 'u_h', context_included: true, owned_bots_by_space: { s_2: ['bot_x'] } }),
    ))
    const identity = new HttpOctoIdentity('http://octo.test')
    expect(await identity.ownedBotsInSpace('u_h', 's_1', 'tok')).toEqual([])
  })

  it('fail-closed: token/uid mismatch => [] (verify answers for a different uid)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      okResponse({ uid: 'someone_else', context_included: true, owned_bots_by_space: { s_1: ['bot_a'] } }),
    ))
    const identity = new HttpOctoIdentity('http://octo.test')
    expect(await identity.ownedBotsInSpace('u_h', 's_1', 'tok')).toEqual([])
  })

  it('fail-closed: pre-context server (context_included !== true) => []', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      okResponse({ uid: 'u_h', owned_bots_by_space: { s_1: ['bot_a'] } }),
    ))
    const identity = new HttpOctoIdentity('http://octo.test')
    expect(await identity.ownedBotsInSpace('u_h', 's_1', 'tok')).toEqual([])
  })

  it('fail-closed: owned_bots_by_space is not an object (malformed) => []', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      okResponse({ uid: 'u_h', context_included: true, owned_bots_by_space: ['bot_a'] }),
    ))
    const identity = new HttpOctoIdentity('http://octo.test')
    expect(await identity.ownedBotsInSpace('u_h', 's_1', 'tok')).toEqual([])
  })

  it('fail-closed: non-200 => []', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401 }) as unknown as Response))
    const identity = new HttpOctoIdentity('http://octo.test')
    expect(await identity.ownedBotsInSpace('u_h', 's_1', 'tok')).toEqual([])
  })

  it('fail-closed: transport throw => []', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network') }))
    const identity = new HttpOctoIdentity('http://octo.test')
    expect(await identity.ownedBotsInSpace('u_h', 's_1', 'tok')).toEqual([])
  })

  it('short-circuits (no IO) on a missing uid / space / token', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const identity = new HttpOctoIdentity('http://octo.test')
    expect(await identity.ownedBotsInSpace('', 's_1', 'tok')).toEqual([])
    expect(await identity.ownedBotsInSpace('u_h', '', 'tok')).toEqual([])
    expect(await identity.ownedBotsInSpace('u_h', 's_1', '')).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
