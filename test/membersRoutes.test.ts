import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test for PUT /:docId/members (§8.4). The handler runs an
// anti-ghost-member check (getUser(uid) must resolve a real octo user) before
// upserting. Regression: getUser was called without the octo-server `token`
// header, so octo-server returned 401 -> null and every add-member 404'd. We
// mock the guard + member repo + epoch bump and inject a stub OctoIdentity to
// drive the route handler off the router stack (mirrors invitesRoutes.test.ts).
vi.mock('../src/api/guard.js', () => ({
  requireDocRole: vi.fn(),
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: { upsertDirect: vi.fn(async () => {}), list: vi.fn(async () => []) },
}))
vi.mock('../src/permission/epoch.js', () => ({
  bumpEpoch: vi.fn(async () => {}),
}))

import { membersRouter } from '../src/api/routes/members.js'
import { requireDocRole } from '../src/api/guard.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
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

// Resolve the PUT add-member handler from the Express router stack.
function putMemberHandler() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const layer of (membersRouter as unknown as { stack: any[] }).stack) {
    const route = layer.route
    if (route && route.path === '/:docId/members' && route.methods?.put) {
      return route.stack[route.stack.length - 1].handle as (req: unknown, res: unknown) => Promise<void>
    }
  }
  throw new Error('put-member handler not found')
}

// Resolve the GET list-members handler from the Express router stack.
function getMembersHandler() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const layer of (membersRouter as unknown as { stack: any[] }).stack) {
    const route = layer.route
    if (route && route.path === '/:docId/members' && route.methods?.get) {
      return route.stack[route.stack.length - 1].handle as (req: unknown, res: unknown) => Promise<void>
    }
  }
  throw new Error('get-members handler not found')
}

// Request carrying the authenticated caller's octo token (set by authMiddleware
// as req.octoToken) so we can assert it is threaded into getUser.
function req(body: Record<string, unknown>, octoToken = 'caller-session-token') {
  return {
    uid: 'u_admin',
    spaceId: 's1',
    octoToken,
    params: { docId: 'd_1' },
    body,
  } as never
}

// A stub identity whose getUser resolves only known uids; records the args it
// was called with so we can assert the caller token is forwarded.
function stubIdentity(known: Record<string, OctoUser>) {
  const getUser = vi.fn(async (uid: string, _callerToken?: string): Promise<OctoUser | null> => {
    return known[uid] ?? null
  })
  const identity: OctoIdentity = {
    verifyToken: vi.fn(async () => null),
    getUser,
    getUsers: vi.fn(async () => []),
  }
  setOctoIdentity(identity)
  return getUser
}

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(docMemberRepo.upsertDirect).mockClear()
  vi.mocked(requireDocRole).mockResolvedValue({
    meta: { doc_id: 'd_1', document_name: 'doc-d_1', owner_id: 'u_admin' },
    role: 'admin',
  } as never)
})

describe('PUT /api/v1/docs/:docId/members — anti ghost-member check', () => {
  it('add member with a resolvable uid -> 200 ok', async () => {
    stubIdentity({ u_real: { uid: 'u_real', name: 'Real User' } })
    const res = mockRes()
    await putMemberHandler()(req({ uid: 'u_real', role: 'writer' }), res as never)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(vi.mocked(docMemberRepo.upsertDirect)).toHaveBeenCalledTimes(1)
    // The doc guard is scoped to req.spaceId (4th arg).
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('s1')
  })

  it('add member with an unresolvable uid -> 404 user_not_found', async () => {
    stubIdentity({})
    const res = mockRes()
    await putMemberHandler()(req({ uid: 'u_ghost', role: 'writer' }), res as never)

    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'user_not_found' })
    expect(vi.mocked(docMemberRepo.upsertDirect)).not.toHaveBeenCalled()
  })

  it("forwards the caller's octo token into getUser", async () => {
    const getUser = stubIdentity({ u_real: { uid: 'u_real', name: 'Real User' } })
    const res = mockRes()
    await putMemberHandler()(req({ uid: 'u_real', role: 'reader' }, 'tok-xyz'), res as never)

    expect(res.statusCode).toBe(200)
    expect(getUser).toHaveBeenCalledWith('u_real', 'tok-xyz')
  })

  it('accepts a commenter add (four-role) -> 200 ok with roleNum=2 (ordered code)', async () => {
    stubIdentity({ u_real: { uid: 'u_real', name: 'Real User' } })
    const res = mockRes()
    await putMemberHandler()(req({ uid: 'u_real', role: 'commenter' }), res as never)

    expect(res.statusCode).toBe(200)
    expect(vi.mocked(docMemberRepo.upsertDirect)).toHaveBeenCalledTimes(1)
    // commenter is the ordered code 2 (reader=1 commenter=2 writer=3 admin=4).
    expect(vi.mocked(docMemberRepo.upsertDirect).mock.calls[0]![0]).toMatchObject({
      uid: 'u_real',
      roleNum: 2,
    })
  })

  it('accepts an admin add -> roleNum=4 (ordered code)', async () => {
    stubIdentity({ u_real: { uid: 'u_real', name: 'Real User' } })
    const res = mockRes()
    await putMemberHandler()(req({ uid: 'u_real', role: 'admin' }), res as never)

    expect(res.statusCode).toBe(200)
    expect(vi.mocked(docMemberRepo.upsertDirect).mock.calls[0]![0]).toMatchObject({
      uid: 'u_real',
      roleNum: 4,
    })
  })

  it('rejects an unknown role -> 400 (fail closed, never defaults to reader)', async () => {
    stubIdentity({ u_real: { uid: 'u_real', name: 'Real User' } })
    const res = mockRes()
    await putMemberHandler()(req({ uid: 'u_real', role: 'superuser' }), res as never)

    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'role must be reader|commenter|writer|admin' })
    expect(vi.mocked(docMemberRepo.upsertDirect)).not.toHaveBeenCalled()
  })
})

// GET list-members synthesizes the implicit owner (§4.2). The owner is an
// implicit admin with no doc_member row, so a plain listing omitted it and
// disagreed with `docs get` (which reports ownerId). The handler now prepends a
// synthesized owner item {role:'admin', source:'owner', grantedBy:null} and
// dedups any doc_member row for the same owner_id. doc and sheet share this
// endpoint, so both are covered by driving the same handler with each doc_type.
function getReq(docId = 'd_1') {
  return { uid: 'u_admin', spaceId: 's1', params: { docId } } as never
}

// Point the guard at a specific owner_id + doc_type for one GET call.
function guardWithOwner(ownerId: string, docType = 'doc') {
  vi.mocked(requireDocRole).mockResolvedValue({
    meta: { doc_id: 'd_1', document_name: 'doc-d_1', owner_id: ownerId, doc_type: docType },
    role: 'admin',
  } as never)
}

describe('GET /api/v1/docs/:docId/members — synthesized owner row', () => {
  // Each case runs for a document AND a sheet (shared endpoint => identical
  // behavior); the parity assertion is the doc/sheet double-coverage.
  const docTypes = ['doc', 'sheet']

  it('includes the owner (role=admin, source=owner) when there are no other members', async () => {
    for (const docType of docTypes) {
      guardWithOwner('u_owner', docType)
      vi.mocked(docMemberRepo.list).mockResolvedValue([] as never)
      const res = mockRes()
      await getMembersHandler()(getReq(), res as never)

      expect(res.statusCode).toBe(200)
      expect((res.body as { items: unknown[] }).items).toEqual([
        { uid: 'u_owner', role: 'admin', source: 'owner', grantedBy: null },
      ])
    }
  })

  it('dedups an owner that also has a doc_member row into a single admin/owner item', async () => {
    for (const docType of docTypes) {
      guardWithOwner('u_owner', docType)
      // Historical PUT upserted the owner as a writer direct row — must NOT
      // surface as a second item, and must stay admin (owner not downgradable).
      vi.mocked(docMemberRepo.list).mockResolvedValue([
        { uid: 'u_owner', role: 3, source: 1, granted_by: 'u_owner' },
      ] as never)
      const res = mockRes()
      await getMembersHandler()(getReq(), res as never)

      expect(res.statusCode).toBe(200)
      const items = (res.body as { items: Array<{ uid: string }> }).items
      expect(items).toEqual([{ uid: 'u_owner', role: 'admin', source: 'owner', grantedBy: null }])
      expect(items.filter((i) => i.uid === 'u_owner')).toHaveLength(1)
    }
  })

  it('keeps direct/invite members alongside the owner without dropping or duplicating them', async () => {
    for (const docType of docTypes) {
      guardWithOwner('u_owner', docType)
      vi.mocked(docMemberRepo.list).mockResolvedValue([
        { uid: 'u_writer', role: 3, source: 1, granted_by: 'u_owner' }, // direct writer (ordered code 3)
        { uid: 'u_commenter', role: 2, source: 1, granted_by: 'u_owner' }, // direct commenter (ordered code 2)
        { uid: 'u_reader', role: 1, source: 2, granted_by: 'u_admin' }, // invite reader
      ] as never)
      const res = mockRes()
      await getMembersHandler()(getReq(), res as never)

      expect(res.statusCode).toBe(200)
      expect((res.body as { items: unknown[] }).items).toEqual([
        { uid: 'u_owner', role: 'admin', source: 'owner', grantedBy: null },
        { uid: 'u_writer', role: 'writer', source: 'direct', grantedBy: 'u_owner' },
        { uid: 'u_commenter', role: 'commenter', source: 'direct', grantedBy: 'u_owner' },
        { uid: 'u_reader', role: 'reader', source: 'invite', grantedBy: 'u_admin' },
      ])
    }
  })
})
