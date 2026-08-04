import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test for the create-invite response shape. The link is built by
// the frontend from its own origin, so the backend must NOT return a Host-
// derived URL — only { inviteToken, role }. Mock the guard + invite repo and
// drive the route handler off the router stack (mirrors the pool/guard mocking
// in docsRoutes.test.ts / versions.test.ts).
vi.mock('../src/api/guard.js', () => ({
  requireDocRole: vi.fn(),
}))
vi.mock('../src/db/repos/docInviteRepo.js', () => ({
  docInviteRepo: { create: vi.fn(async () => {}) },
}))

import { invitesRouter } from '../src/api/routes/invites.js'
import { requireDocRole } from '../src/api/guard.js'
import { docInviteRepo } from '../src/db/repos/docInviteRepo.js'

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

// Resolve the POST create-invite handler from the Express router stack.
function createInviteHandler() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const layer of (invitesRouter as unknown as { stack: any[] }).stack) {
    const route = layer.route
    if (route && route.path === '/:docId/invites' && route.methods?.post) {
      return route.stack[route.stack.length - 1].handle as (req: unknown, res: unknown) => Promise<void>
    }
  }
  throw new Error('create-invite handler not found')
}

// A request carrying Host / X-Forwarded-Proto headers — if the handler still
// built a URL from these, the leak would show up in the response.
function req() {
  return {
    uid: 'u_admin',
    spaceId: 's1',
    params: { docId: 'd_1' },
    body: { role: 'writer' },
    protocol: 'http',
    header: (name: string) =>
      name.toLowerCase() === 'host'
        ? 'attacker.example.com'
        : name.toLowerCase() === 'x-forwarded-proto'
          ? 'https'
          : undefined,
  } as never
}

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(docInviteRepo.create).mockClear()
})

describe('POST /api/v1/docs/:docId/invites — create response (#6)', () => {
  it('returns only { inviteToken, role } with no host-derived url', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({ meta: { doc_type: 'html' }, role: 'admin' } as never)
    const res = mockRes()
    await createInviteHandler()(req(), res as never)

    expect(res.statusCode).toBe(201)
    const body = res.body as Record<string, unknown>
    expect(typeof body.inviteToken).toBe('string')
    expect(body.role).toBe('writer')
    // The doc guard is scoped to req.spaceId (4th arg).
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('s1')

    // No host-derived link of any kind in the response.
    expect(body).not.toHaveProperty('url')
    expect(JSON.stringify(body)).not.toContain('attacker.example.com')
    expect(JSON.stringify(body)).not.toContain('http')
  })

  it('creates a commenter invite with stored role 4', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({ meta: { doc_type: 'html' }, role: 'admin' } as never)
    const res = mockRes()
    await createInviteHandler()(reqWith({ role: 'commenter' }), res as never)
    expect(res.statusCode).toBe(201)
    expect(res.body).toMatchObject({ role: 'commenter' })
    expect(vi.mocked(docInviteRepo.create)).toHaveBeenLastCalledWith(
      expect.objectContaining({ roleNum: 4 }),
    )
  })

  it('defaults an omitted role to writer but rejects explicit invalid roles', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({ meta: { doc_type: 'html' }, role: 'admin' } as never)
    const omitted = mockRes()
    await createInviteHandler()(reqWith({}), omitted as never)
    expect(omitted.statusCode).toBe(201)
    expect(omitted.body).toMatchObject({ role: 'writer' })

    const invalid = mockRes()
    await createInviteHandler()(reqWith({ role: 'bogus' }), invalid as never)
    expect(invalid.statusCode).toBe(400)
  })

  it('creates commenter invites for non-HTML documents', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({ meta: { doc_type: 'doc' }, role: 'admin' } as never)
    const res = mockRes()
    await createInviteHandler()(reqWith({ role: 'commenter' }), res as never)
    expect(res.statusCode).toBe(201)
    expect(vi.mocked(docInviteRepo.create)).toHaveBeenCalledWith(expect.objectContaining({ roleNum: 4 }))
  })
})

// Request builder carrying an explicit body (role defaults to writer).
function reqWith(body: Record<string, unknown>) {
  return {
    uid: 'u_admin',
    spaceId: 's1',
    params: { docId: 'd_1' },
    body,
  } as never
}

// Pull the expiresAt Date passed to docInviteRepo.create on its last call.
function lastCreateExpiresAt(): Date {
  const call = vi.mocked(docInviteRepo.create).mock.calls.at(-1)!
  return (call[0] as { expiresAt: Date }).expiresAt
}

describe('POST /api/v1/docs/:docId/invites — expiresInDays policy', () => {
  const DAY_MS = 24 * 60 * 60 * 1000
  // Tolerance for the small gap between our `before` stamp and the handler's
  // own Date.now() (handler + assertion run within the same tick in practice).
  const TOL_MS = 5_000

  beforeEach(() => {
    vi.mocked(requireDocRole).mockResolvedValue({ meta: { doc_type: 'html' }, role: 'admin' } as never)
  })

  // expectedDays → assert stored expiresAt ≈ now + expectedDays, and never NULL.
  async function assertDays(body: Record<string, unknown>, expectedDays: number) {
    const before = Date.now()
    const res = mockRes()
    await createInviteHandler()(reqWith(body), res as never)
    const after = Date.now()

    expect(res.statusCode).toBe(201)
    const expires = lastCreateExpiresAt()
    expect(expires).toBeInstanceOf(Date)
    // Never a permanent (NULL-expiry) link.
    expect(expires).not.toBeNull()
    expect(expires.getTime()).toBeGreaterThanOrEqual(before + expectedDays * DAY_MS - TOL_MS)
    expect(expires.getTime()).toBeLessThanOrEqual(after + expectedDays * DAY_MS + TOL_MS)

    // Create response echoes the computed expiry as ISO.
    const respExpiresAt = (res.body as Record<string, unknown>).expiresAt
    expect(typeof respExpiresAt).toBe('string')
    expect(new Date(respExpiresAt as string).getTime()).toBe(expires.getTime())
  }

  it('expiresInDays=5 → stores now + 5d', async () => {
    await assertDays({ role: 'writer', expiresInDays: 5 }, 5)
  })

  it('no expiresInDays → defaults to now + 3d', async () => {
    await assertDays({ role: 'writer' }, 3)
  })

  it('expiresInDays=0 → clamps to now + 1d', async () => {
    await assertDays({ role: 'writer', expiresInDays: 0 }, 1)
  })

  it('expiresInDays=99 → clamps to now + 7d', async () => {
    await assertDays({ role: 'writer', expiresInDays: 99 }, 7)
  })

  it('expiresInDays="abc" → defaults to now + 3d', async () => {
    await assertDays({ role: 'writer', expiresInDays: 'abc' }, 3)
  })

  it('expiresInDays=null → defaults to now + 3d', async () => {
    await assertDays({ role: 'writer', expiresInDays: null }, 3)
  })

  it('never creates an invite with a NULL expiry', async () => {
    const res = mockRes()
    await createInviteHandler()(reqWith({ role: 'writer' }), res as never)
    for (const call of vi.mocked(docInviteRepo.create).mock.calls) {
      const { expiresAt } = call[0] as { expiresAt: Date | null }
      expect(expiresAt).not.toBeNull()
      expect(expiresAt).toBeInstanceOf(Date)
    }
  })
})
