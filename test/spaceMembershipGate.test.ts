import { describe, it, expect, vi, beforeEach } from 'vitest'

// Space-membership gate (WS-SPACE-1) — split shape.
//
// `spaceContextMiddleware` accepts ANY non-empty X-Space-Id header as the
// caller's space context: it trims the value, stashes it on req.spaceId and calls
// next(). That is all it does, on purpose — `req.spaceId` is a request-scoped
// scoping key, NOT proof of membership.
//
// The authority lives in `requireSpaceMembership`, mounted per-route on the
// space-selector routes (docs create / list / search / recent). Those routes have
// no document to resolve a role from — create: the doc does not exist yet;
// list/search/recent: the subject IS the space — so the space check is the only
// check available there. Without it, any holder of a valid octo session token
// could set `X-Space-Id` to someone else's space and be treated as its occupant
// (most concretely: plant a doc into it).
//
// `POST /:docId/access-requests` is deliberately NOT gated even though it also
// resolves no role: its persona is an outsider on octo-web's forbidden landing
// (#511 screen 4c), so gating it would render the "Request access" button and
// then 404 the click. See crossSpaceDocMember.test.ts.
//
// The gate is deliberately NOT global. A doc_member grant is independent of space
// membership by design (members.ts / forwardGrant.ts verify only that the grantee
// is a real octo user; the invite-accept path never mentions a space), and the
// contract pins space as a supplemental, only-adds permission source
// (docs/contract/backend-design.md:1514). A mount-wide gate would SUBTRACT: it
// 404s a legitimate cross-space doc_member on every /:docId route — see
// crossSpaceDocMember.test.ts for the regression that split this middleware in
// two. Those routes keep requireDocRole, which is strictly stronger: it resolves
// the role from the caller's real uid and pins req.spaceId === meta.space_id.
//
// Failure mode is 404 not_found (never 403) so a non-member cannot distinguish
// "not a member of this space" from "no such space" — matching the cross-space
// 404 semantics requireSameSpace already established for docs.
import { spaceContextMiddleware, requireSpaceMembership } from '../src/api/middleware/spaceContext.js'
import { getOctoIdentity } from '../src/auth/octoIdentity.js'

vi.mock('../src/auth/octoIdentity.js', () => ({
  getOctoIdentity: vi.fn(),
}))

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

/**
 * A request carrying the given headers plus the principal fields authMiddleware
 * resolves upstream (uid + the caller's octo session token). `botToken` is left
 * undefined so this is the HUMAN mount — the one that carries an unverified
 * header. Bot requests short-circuit the gate (verifyBot resolves their space
 * server-side); that path is asserted explicitly below.
 */
function req(headers: Record<string, string | undefined>, extra: Record<string, unknown> = {}) {
  const lower: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return {
    spaceId: undefined as string | undefined,
    uid: 'u_outsider',
    octoToken: 'tok_valid_session',
    header(name: string) {
      return lower[name.toLowerCase()]
    },
    ...extra,
  } as never
}

/** Stub the identity seam with a fixed isSpaceMember verdict. */
function stubMembership(verdict: boolean | Error) {
  const isSpaceMember = vi.fn(async () => {
    if (verdict instanceof Error) throw verdict
    return verdict
  })
  vi.mocked(getOctoIdentity).mockReturnValue({ isSpaceMember } as never)
  return isSpaceMember
}

/** Run the human chain as mounted: parse, then (space-selector routes) the gate. */
async function runChain(r: unknown, res: MockRes) {
  const parsed = vi.fn()
  spaceContextMiddleware(r as never, res as never, parsed)
  if (parsed.mock.calls.length === 0) return { reachedHandler: false }
  const gated = vi.fn()
  await requireSpaceMembership(r as never, res as never, gated)
  return { reachedHandler: gated.mock.calls.length === 1 }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('spaceContextMiddleware — parses the header, asserts nothing', () => {
  it('populates req.spaceId from a non-empty header with NO membership IO', () => {
    const isSpaceMember = stubMembership(false)
    const r = req({ 'X-Space-Id': 's_someone_elses' })
    const res = mockRes()
    const next = vi.fn()

    spaceContextMiddleware(r, res as never, next)

    // Parsing is not authorization: it must not refuse, and must not pay for a
    // membership lookup on routes that do not need one.
    expect(next).toHaveBeenCalledTimes(1)
    expect((r as unknown as { spaceId?: string }).spaceId).toBe('s_someone_elses')
    expect(res.statusCode).toBe(0)
    expect(isSpaceMember).not.toHaveBeenCalled()
  })

  it('400s space_required on a missing header', () => {
    const r = req({})
    const res = mockRes()
    const next = vi.fn()

    spaceContextMiddleware(r, res as never, next)

    // Pre-existing contract preserved: shape errors stay 400 space_required and
    // are distinguishable from authorization failures.
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'space_required' })
    expect(next).not.toHaveBeenCalled()
  })

  it('400s space_required on a whitespace-only header', () => {
    const res = mockRes()
    const next = vi.fn()

    spaceContextMiddleware(req({ 'X-Space-Id': '   ' }), res as never, next)

    expect(res.statusCode).toBe(400)
    expect(next).not.toHaveBeenCalled()
  })
})

describe('requireSpaceMembership — the gate on space-selector routes', () => {
  it('admits a CONFIRMED member, checking the TRIMMED value that will be scoped by', async () => {
    const isSpaceMember = stubMembership(true)
    const r = req({ 'X-Space-Id': '  s_home  ' })
    const res = mockRes()

    const { reachedHandler } = await runChain(r, res)

    expect(reachedHandler).toBe(true)
    expect(res.statusCode).toBe(0)
    // Same string the handler will scope by — so no whitespace variant can be
    // verified as one space and then applied as another.
    expect((r as unknown as { spaceId?: string }).spaceId).toBe('s_home')
    expect(isSpaceMember).toHaveBeenCalledWith('u_outsider', 's_home', 'tok_valid_session')
  })

  it('REJECTS a non-member with 404 not_found — the header alone is not authority', async () => {
    stubMembership(false)
    const r = req({ 'X-Space-Id': 's_someone_elses' })
    const res = mockRes()

    const { reachedHandler } = await runChain(r, res)

    // This is the vulnerability: pre-fix the chain reached the handler here and
    // the caller was treated as an occupant of a space they do not belong to.
    expect(reachedHandler).toBe(false)
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
  })

  it('uses 404 (not 403) so space existence is not disclosed to outsiders', async () => {
    stubMembership(false)
    const res = mockRes()

    await runChain(req({ 'X-Space-Id': 's_secret' }), res)

    // A 403 would confirm "this space exists, you're just not in it".
    expect(res.statusCode).not.toBe(403)
    expect(res.statusCode).toBe(404)
  })

  it('fails CLOSED when the membership lookup throws (transient identity outage)', async () => {
    stubMembership(new Error('octo-server unreachable'))
    const res = mockRes()

    const { reachedHandler } = await runChain(req({ 'X-Space-Id': 's_home' }), res)

    // A rejected lookup must not open the boundary, and must not surface as a 500.
    expect(reachedHandler).toBe(false)
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
  })

  it('fails CLOSED when the identity seam is missing the method entirely', async () => {
    // A synchronous TypeError on call, raised BEFORE any promise exists — the
    // shape a bare `.catch()` on the returned promise would NOT contain. Under
    // Express 4 an uncontained throw here hangs the request instead of refusing.
    vi.mocked(getOctoIdentity).mockReturnValue({} as never)
    const res = mockRes()

    const { reachedHandler } = await runChain(req({ 'X-Space-Id': 's_home' }), res)

    expect(reachedHandler).toBe(false)
    expect(res.statusCode).toBe(404)
  })

  it('fails CLOSED when the caller has no session token to authorize verify', async () => {
    const isSpaceMember = stubMembership(true)
    const res = mockRes()

    // authMiddleware always sets octoToken, but an absent token cannot authorize
    // a verify call, so the gate must refuse rather than skip the check —
    // skipping would make "no token" the widest possible privilege.
    const { reachedHandler } = await runChain(req({ 'X-Space-Id': 's_home' }, { octoToken: undefined }), res)

    expect(reachedHandler).toBe(false)
    expect(res.statusCode).toBe(404)
    expect(isSpaceMember).not.toHaveBeenCalled()
  })

  it('short-circuits for BOT requests without asking octo-server', async () => {
    const isSpaceMember = stubMembership(false)
    const r = req({ 'X-Space-Id': 's_bot_space' }, { botToken: 'bot-tok', spaceId: 's_bot_space' })
    const res = mockRes()
    const next = vi.fn()

    await requireSpaceMembership(r, res as never, next)

    // The space-selector routers are shared verbatim between the human and bot
    // mounts. A bot's req.spaceId comes from verifyBot's server-side reverse
    // lookup, so it is already authoritative and there is no session token to
    // verify with — asking whether a bot "is a member" of its own space would
    // fail closed and break the whole bot mount.
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(0)
    expect(isSpaceMember).not.toHaveBeenCalled()
  })
})
