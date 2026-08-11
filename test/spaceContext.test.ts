import { describe, it, expect, vi } from 'vitest'

// Unit tests for the space-context middleware (strict by-space isolation, P1).
// The isolation boundary is the frontend-injected X-Space-Id header: present and
// non-empty -> the SHAPE is valid, so proceed to the membership gate; missing or
// empty -> hard 400 (no warn/grace mode).
//
// ★ Header presence alone no longer admits the caller. The header is
// client-supplied, so a confirmed `isSpaceMember` verdict is now also required
// (see spaceMembershipGate.test.ts for the authorization matrix). The two
// happy-path cases below therefore stub a CONFIRMED membership: they assert the
// header PARSING contract (trimming, req.spaceId population), which is what this
// file has always been about, not the authorization decision.
import { spaceContextMiddleware } from '../src/api/middleware/spaceContext.js'
import { getOctoIdentity } from '../src/auth/octoIdentity.js'

vi.mock('../src/auth/octoIdentity.js', () => ({
  getOctoIdentity: vi.fn(),
}))

/** Treat every caller as a confirmed member, isolating the parsing assertions. */
function stubMemberConfirmed() {
  vi.mocked(getOctoIdentity).mockReturnValue({
    isSpaceMember: vi.fn(async () => true),
  } as never)
}

interface MockRes {
  statusCode: number
  body: unknown
  status(c: number): MockRes
  json(b: unknown): MockRes
}

function mockRes(): MockRes {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c
      return this
    },
    json(b: unknown) {
      this.body = b
      return this
    },
  }
}

// A request whose header(name) resolves the given case-insensitive header map,
// mirroring Express's req.header().
function req(headers: Record<string, string | undefined>) {
  const lower: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return {
    spaceId: undefined as string | undefined,
    // authMiddleware resolves both upstream; the membership gate needs them to
    // authorize its verify call.
    uid: 'u_1',
    octoToken: 'tok_1',
    header(name: string) {
      return lower[name.toLowerCase()]
    },
  } as never
}

describe('spaceContextMiddleware — X-Space-Id required (§ by-space isolation P1)', () => {
  it('populates req.spaceId and calls next for a confirmed member', async () => {
    stubMemberConfirmed()
    const r = req({ 'X-Space-Id': 's_42' })
    const res = mockRes()
    const next = vi.fn()

    await spaceContextMiddleware(r, res as never, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect((r as unknown as { spaceId?: string }).spaceId).toBe('s_42')
    expect(res.statusCode).toBe(0) // no response written on the happy path
  })

  it('trims surrounding whitespace from the header value', async () => {
    stubMemberConfirmed()
    const r = req({ 'X-Space-Id': '  s_trim  ' })
    const res = mockRes()
    const next = vi.fn()

    await spaceContextMiddleware(r, res as never, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect((r as unknown as { spaceId?: string }).spaceId).toBe('s_trim')
  })

  it('rejects a missing header with 400 space_required and does not call next', async () => {
    const r = req({})
    const res = mockRes()
    const next = vi.fn()

    await spaceContextMiddleware(r, res as never, next)

    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'space_required' })
    expect(next).not.toHaveBeenCalled()
    expect((r as unknown as { spaceId?: string }).spaceId).toBeUndefined()
  })

  it('rejects an empty header with 400 space_required', async () => {
    const r = req({ 'X-Space-Id': '' })
    const res = mockRes()
    const next = vi.fn()

    await spaceContextMiddleware(r, res as never, next)

    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'space_required' })
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects a whitespace-only header with 400 space_required', async () => {
    const r = req({ 'X-Space-Id': '   ' })
    const res = mockRes()
    const next = vi.fn()

    await spaceContextMiddleware(r, res as never, next)

    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'space_required' })
    expect(next).not.toHaveBeenCalled()
  })
})
