import { describe, it, expect, vi, beforeEach } from 'vitest'

// Route-level authorization test for GET /api/v1/docs (listDocsHandler) — the
// primary P1-a surface (yujiawei RC#5). The prior coverage asserted the repo
// predicate string; this exercises the HANDLER's membership resolution end to
// end, proving a non-member (or a spoofed X-Space-Id) never reaches listForUser
// with the space-share branch enabled. Mirrors docViewRoutes.test.ts: mock the
// repo + octo identity, then call the exported handler directly (no live infra).
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { listForUser: vi.fn() },
}))
const { isSpaceMemberMock } = vi.hoisted(() => ({ isSpaceMemberMock: vi.fn() }))
vi.mock('../src/auth/octoIdentity.js', () => ({
  getOctoIdentity: () => ({ isSpaceMember: isSpaceMemberMock }),
}))

import { listDocsHandler } from '../src/api/routes/docs.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'

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
    status(c: number) { this.statusCode = c; return this },
    json(b: unknown) { this.body = b; return this },
  }
}
function req(extra: Record<string, unknown>) {
  return { uid: 'u_1', spaceId: 's_target', octoToken: 'tok', query: {}, ...extra } as never
}

beforeEach(() => {
  vi.mocked(docMetaRepo.listForUser).mockReset()
  vi.mocked(docMetaRepo.listForUser).mockResolvedValue({ total: 0, items: [] })
  isSpaceMemberMock.mockReset()
})

describe('GET /api/v1/docs — listDocsHandler membership gate (P1-a, XIN-1297 RC#5)', () => {
  it('AUTHZ RED->GREEN: a NON-member sending a spoofed X-Space-Id gets isSpaceMember=false, so the share branch is dropped', async () => {
    // A logged-in user who is NOT a member of s_target names it via X-Space-Id.
    isSpaceMemberMock.mockResolvedValue(false)
    const res = mockRes()
    await listDocsHandler(req({ spaceId: 's_target' }), res as never)

    // membership is resolved against the queried space with the caller's own token.
    expect(isSpaceMemberMock).toHaveBeenCalledWith('u_1', 's_target', 'tok')
    // and the repo is told the caller is NOT a member => no anyone_in_space docs.
    const arg = vi.mocked(docMetaRepo.listForUser).mock.calls[0]![0]
    expect(arg.isSpaceMember).toBe(false)
    expect(arg.spaceId).toBe('s_target')
    expect(res.statusCode).toBe(200)
  })

  it('a confirmed member gets isSpaceMember=true (the space-share branch is available)', async () => {
    isSpaceMemberMock.mockResolvedValue(true)
    const res = mockRes()
    await listDocsHandler(req({ spaceId: 's_target' }), res as never)
    expect(isSpaceMemberMock).toHaveBeenCalledWith('u_1', 's_target', 'tok')
    expect(vi.mocked(docMetaRepo.listForUser).mock.calls[0]![0].isSpaceMember).toBe(true)
  })

  it('owner=me skips the membership lookup entirely and forwards isSpaceMember=false', async () => {
    const res = mockRes()
    await listDocsHandler(req({ query: { owner: 'me' } }), res as never)
    // "my documents" is authorship-only; the share branch is excluded outright,
    // so no isSpaceMember IO is spent.
    expect(isSpaceMemberMock).not.toHaveBeenCalled()
    const arg = vi.mocked(docMetaRepo.listForUser).mock.calls[0]![0]
    expect(arg.isSpaceMember).toBe(false)
    expect(arg.owner).toBe('me')
  })

  it('a bot (server-resolved req.spaceId) is a member by definition — no isSpaceMember call', async () => {
    const res = mockRes()
    await listDocsHandler(req({ botToken: 'bot-tok' }), res as never)
    expect(isSpaceMemberMock).not.toHaveBeenCalled()
    expect(vi.mocked(docMetaRepo.listForUser).mock.calls[0]![0].isSpaceMember).toBe(true)
  })

  it('RC#2 fail-closed: a rejected isSpaceMember lookup degrades to non-member, never a 500', async () => {
    // isSpaceMember documents a fail-closed `false`, but a REJECTED promise would
    // bubble to a 500 on /docs. resolveViewerSpaceMembership must .catch(()=>false)
    // so a transient identity-service failure drops the share branch instead.
    isSpaceMemberMock.mockRejectedValue(new Error('identity service unavailable'))
    const res = mockRes()
    await listDocsHandler(req({ spaceId: 's_target' }), res as never)
    expect(res.statusCode).toBe(200)
    expect(vi.mocked(docMetaRepo.listForUser).mock.calls[0]![0].isSpaceMember).toBe(false)
  })
})

// Read/write role SYMMETRY at the wire layer: the repo now projects the same
// numeric role the write side derives (effectiveRole), and the route serializes
// it verbatim. Locks the canonical four-role encoding (1=reader 2=commenter
// 3=writer 4=admin) round-trips to its wire string — the user-visible half of RC#1.
describe('GET /api/v1/docs — role serialization mirrors the projected numeric role (RC#1)', () => {
  it.each([
    [4, 'admin'],
    [3, 'writer'],
    [2, 'commenter'],
    [1, 'reader'],
  ])('repo role %i => wire role %s', async (numeric, wire) => {
    isSpaceMemberMock.mockResolvedValue(true)
    vi.mocked(docMetaRepo.listForUser).mockResolvedValue({
      total: 1,
      items: [{ doc_id: 'd_1', title: 't', owner_id: 'u_2', doc_type: 'doc', role: numeric, updated_at: new Date(0) }] as never,
    })
    const res = mockRes()
    await listDocsHandler(req({ spaceId: 's_target' }), res as never)
    expect((res.body as { items: { role: string }[] }).items[0]!.role).toBe(wire)
  })
})
