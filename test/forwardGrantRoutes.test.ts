import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test for POST /:docId/forward-grant (§2 / §9.1). Drives the route
// handler off the Express router stack (mirrors membersRoutes.test.ts). The
// grant core (grantForwardAccess) and the guard are mocked; we assert the per-uid
// status contract: 400 bad input, 404 ghost user, 200 grant, and that a blocked
// guard (non admin/owner => 403 already written) short-circuits before the grant.
vi.mock('../src/api/guard.js', () => ({
  requireDocRole: vi.fn(),
}))
vi.mock('../src/api/services/grantForward.js', () => ({
  grantForwardAccess: vi.fn(async () => ({ finalRole: 'reader', changed: true })),
}))

import { forwardGrantRouter } from '../src/api/routes/forwardGrant.js'
import { requireDocRole } from '../src/api/guard.js'
import { grantForwardAccess } from '../src/api/services/grantForward.js'
import { setOctoIdentity, type OctoIdentity, type OctoUser } from '../src/auth/octoIdentity.js'

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

function handler() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const layer of (forwardGrantRouter as unknown as { stack: any[] }).stack) {
    const route = layer.route
    if (route && route.path === '/:docId/forward-grant' && route.methods?.post) {
      return route.stack[route.stack.length - 1].handle as (req: unknown, res: unknown) => Promise<void>
    }
  }
  throw new Error('forward-grant handler not found')
}

function req(body: Record<string, unknown>) {
  return { uid: 'u_admin', octoToken: 'tok', params: { docId: 'd_1' }, body } as never
}

function stubIdentity(known: Record<string, OctoUser>) {
  const getUser = vi.fn(async (uid: string): Promise<OctoUser | null> => known[uid] ?? null)
  const identity: OctoIdentity = {
    verifyToken: vi.fn(async () => null),
    getUser,
    getUsers: vi.fn(async () => []),
  }
  setOctoIdentity(identity)
  return getUser
}

const okGuard = {
  meta: { doc_id: 'd_1', document_name: 'doc-d_1', owner_id: 'u_admin' },
  role: 'admin',
} as never

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(grantForwardAccess).mockClear()
})

describe('POST /:docId/forward-grant', () => {
  it('admin grants reader to a real user -> 200 { ok, role, changed }', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(okGuard)
    stubIdentity({ u_real: { uid: 'u_real', name: 'Real' } })
    const res = mockRes()
    await handler()(req({ uid: 'u_real', role: 'reader' }), res as never)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: true, role: 'reader', changed: true })
    expect(vi.mocked(grantForwardAccess)).toHaveBeenCalledWith({
      docId: 'd_1',
      documentName: 'doc-d_1',
      uid: 'u_real',
      roleNum: 1,
      grantedBy: 'u_admin',
    })
  })

  it('rejects commenter because the forward-grant contract accepts only reader|writer', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(okGuard)
    stubIdentity({ u_real: { uid: 'u_real', name: 'Real' } })
    const res = mockRes()
    await handler()(req({ uid: 'u_real', role: 'commenter' }), res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'role must be reader|writer' })
    expect(vi.mocked(grantForwardAccess)).not.toHaveBeenCalled()
  })

  it('blocked guard (non admin/owner) short-circuits: no grant attempted', async () => {
    // requireDocRole already wrote 403 and returned null.
    vi.mocked(requireDocRole).mockResolvedValue(null)
    const res = mockRes()
    await handler()(req({ uid: 'u_real', role: 'reader' }), res as never)

    expect(vi.mocked(grantForwardAccess)).not.toHaveBeenCalled()
  })

  it('missing uid -> 400', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(okGuard)
    stubIdentity({})
    const res = mockRes()
    await handler()(req({ role: 'reader' }), res as never)

    expect(res.statusCode).toBe(400)
    expect(vi.mocked(grantForwardAccess)).not.toHaveBeenCalled()
  })

  it('role=admin is rejected (only reader|commenter|writer forward-grantable) -> 400', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(okGuard)
    stubIdentity({ u_real: { uid: 'u_real', name: 'Real' } })
    const res = mockRes()
    await handler()(req({ uid: 'u_real', role: 'admin' }), res as never)

    expect(res.statusCode).toBe(400)
    expect(vi.mocked(grantForwardAccess)).not.toHaveBeenCalled()
  })

  it('ghost uid (not a real octo user) -> 404 user_not_found', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(okGuard)
    stubIdentity({})
    const res = mockRes()
    await handler()(req({ uid: 'u_ghost', role: 'writer' }), res as never)

    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'user_not_found' })
    expect(vi.mocked(grantForwardAccess)).not.toHaveBeenCalled()
  })
})
