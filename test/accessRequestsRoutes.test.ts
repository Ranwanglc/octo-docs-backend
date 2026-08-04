import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit tests for the screen-4c access-request routes (§4.3). Drives the
// handlers off the Express router stack. Guard, doc-meta repo, access-request
// repo, resolveRole and the shared grant core are mocked so we assert:
//   - submit: doc gating (404/409), already_granted idempotency, pending create
//   - list:   admin-gated pending list shape
//   - approve: grants via the shared max-merge core + marks approved
//   - deny:    marks denied; unknown request -> 404
// requireDocRole is mocked (its role resolution is exercised elsewhere), but
// requireSameSpace keeps its real implementation so the submit space-scope gate
// is tested against the actual meta.space_id vs req.spaceId comparison.
vi.mock('../src/api/guard.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, requireDocRole: vi.fn() }
})
vi.mock('../src/db/repos/docMetaRepo.js', () => ({ docMetaRepo: { getByDocId: vi.fn() } }))
vi.mock('../src/db/repos/docAccessRequestRepo.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return {
    ...actual,
    docAccessRequestRepo: {
      submit: vi.fn(),
      listByStatus: vi.fn(),
      getByRequestId: vi.fn(),
      decide: vi.fn(async () => true),
    },
  }
})
vi.mock('../src/permission/resolveRole.js', () => ({ resolveRole: vi.fn() }))
vi.mock('../src/api/services/grantForward.js', () => ({
  grantForwardAccess: vi.fn(async () => ({ finalRole: 'reader', changed: true })),
}))
vi.mock('../src/api/services/docsNotify.js', () => ({
  notifyDocAccessRequested: vi.fn(async () => 1),
}))
// getOctoIdentity().ownedBotsInSpace gates the submit bot snapshot. Mocked so
// each test controls exactly which bots the caller "owns" in the doc's Space.
const mockOwnedBotsInSpace = vi.fn(async () => [] as string[])
vi.mock('../src/auth/octoIdentity.js', () => ({
  getOctoIdentity: () => ({ ownedBotsInSpace: mockOwnedBotsInSpace }),
}))

import { accessRequestsRouter } from '../src/api/routes/accessRequests.js'
import { requireDocRole } from '../src/api/guard.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import {
  docAccessRequestRepo,
  REQUEST_STATUS_APPROVED,
  REQUEST_STATUS_DENIED,
} from '../src/db/repos/docAccessRequestRepo.js'
import { resolveRole } from '../src/permission/resolveRole.js'
import { grantForwardAccess } from '../src/api/services/grantForward.js'
import { notifyDocAccessRequested } from '../src/api/services/docsNotify.js'

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

function handlerFor(path: string, method: 'get' | 'post') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const layer of (accessRequestsRouter as unknown as { stack: any[] }).stack) {
    const route = layer.route
    if (route && route.path === path && route.methods?.[method]) {
      return route.stack[route.stack.length - 1].handle as (req: unknown, res: unknown) => Promise<void>
    }
  }
  throw new Error(`handler not found: ${method} ${path}`)
}

const okGuard = {
  meta: { doc_id: 'd_1', document_name: 'doc-d_1', owner_id: 'u_admin', doc_type: 'html' },
  role: 'admin',
} as never

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(docMetaRepo.getByDocId).mockReset()
  vi.mocked(docAccessRequestRepo.submit).mockReset()
  vi.mocked(docAccessRequestRepo.listByStatus).mockReset()
  vi.mocked(docAccessRequestRepo.getByRequestId).mockReset()
  vi.mocked(docAccessRequestRepo.decide).mockClear()
  vi.mocked(resolveRole).mockReset()
  vi.mocked(grantForwardAccess).mockClear()
  vi.mocked(notifyDocAccessRequested).mockClear()
  // Default: caller owns no bots in the space unless a test says otherwise.
  mockOwnedBotsInSpace.mockReset()
  mockOwnedBotsInSpace.mockResolvedValue([])
  // grantForward default success unless a test overrides per-uid.
  vi.mocked(grantForwardAccess).mockResolvedValue({ finalRole: 'reader', changed: true })
})

// ── submit ────────────────────────────────────────────────────────────────
describe('POST /:docId/access-requests — submit', () => {
  const submitHandler = () => handlerFor('/:docId/access-requests', 'post')
  const req = (body: Record<string, unknown>) =>
    ({ uid: 'u_applicant', spaceId: 's_1', params: { docId: 'd_1' }, body }) as never

  it('doc missing/deleted -> 404, no row written', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(null)
    const res = mockRes()
    await submitHandler()(req({}), res as never)
    expect(res.statusCode).toBe(404)
    expect(vi.mocked(docAccessRequestRepo.submit)).not.toHaveBeenCalled()
  })

  it('cross-space doc -> 404 (indistinguishable from missing), no row, no oracle', async () => {
    // Doc exists but lives in space s_other; the caller is scoped to s_1. The
    // submit path is role-less, so this space gate is the only thing standing
    // between a caller in one space and a doc in another. It must 404 (same
    // shape as a missing doc) BEFORE the status branches so neither the doc's
    // existence nor its archived/active state leaks, and no request row is
    // written into the other space.
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({ status: 1, space_id: 's_other' } as never)
    const res = mockRes()
    await submitHandler()(req({ requestedRole: 'writer' }), res as never)
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
    expect(vi.mocked(resolveRole)).not.toHaveBeenCalled()
    expect(vi.mocked(docAccessRequestRepo.submit)).not.toHaveBeenCalled()
  })

  it('archived doc (status=2) -> 409', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({ status: 2, space_id: 's_1' } as never)
    const res = mockRes()
    await submitHandler()(req({}), res as never)
    expect(res.statusCode).toBe(409)
  })

  it('caller already >= requested role -> 200 already_granted, no row', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({ status: 1, space_id: 's_1', doc_type: 'html' } as never)
    vi.mocked(resolveRole).mockResolvedValue('writer')
    const res = mockRes()
    await submitHandler()(req({ requestedRole: 'reader' }), res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ status: 'already_granted', role: 'writer' })
    expect(vi.mocked(docAccessRequestRepo.submit)).not.toHaveBeenCalled()
  })

  it('no existing access -> 201 pending, row written with requested role', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({ status: 1, space_id: 's_1' } as never)
    vi.mocked(resolveRole).mockResolvedValue('none')
    vi.mocked(docAccessRequestRepo.submit).mockResolvedValue({ requestId: 'req_x', status: 1 })
    const res = mockRes()
    await submitHandler()(req({ requestedRole: 'writer', reason: 'need edit' }), res as never)
    expect(res.statusCode).toBe(201)
    expect(res.body).toEqual({ requestId: 'req_x', status: 'pending' })
    expect(vi.mocked(docAccessRequestRepo.submit)).toHaveBeenCalledWith({
      docId: 'd_1',
      uid: 'u_applicant',
      requestedRoleNum: 2,
      reason: 'need edit',
      botUids: [],
    })
  })

  it('omitted requestedRole defaults to reader and creates a pending request', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({ status: 1, space_id: 's_1', doc_type: 'html' } as never)
    vi.mocked(resolveRole).mockResolvedValue('none')
    vi.mocked(docAccessRequestRepo.submit).mockResolvedValue({ requestId: 'req_r', status: 1 })

    const res = mockRes()
    await submitHandler()(req({}), res as never)

    expect(res.statusCode).toBe(201)
    expect(res.body).toEqual({ requestId: 'req_r', status: 'pending' })
    expect(vi.mocked(docAccessRequestRepo.submit)).toHaveBeenCalledWith({
      docId: 'd_1',
      uid: 'u_applicant',
      requestedRoleNum: 1,
      reason: '',
      botUids: [],
    })
  })

  it('explicit invalid requestedRole returns 400 without writing a row', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({ status: 1, space_id: 's_1', doc_type: 'html' } as never)

    for (const requestedRole of ['admin', 'bogus', null]) {
      const res = mockRes()
      await submitHandler()(req({ requestedRole }), res as never)
      expect(res.statusCode).toBe(400)
      expect(res.body).toEqual({ error: 'requestedRole must be reader|commenter|writer' })
    }

    expect(vi.mocked(resolveRole)).not.toHaveBeenCalled()
    expect(vi.mocked(docAccessRequestRepo.submit)).not.toHaveBeenCalled()
  })

  it('persists commenter for HTML and non-HTML docs', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({ status: 1, space_id: 's_1', doc_type: 'html' } as never)
    vi.mocked(resolveRole).mockResolvedValue('none')
    vi.mocked(docAccessRequestRepo.submit).mockResolvedValue({ requestId: 'req_c', status: 1 })

    const commenter = mockRes()
    await submitHandler()(req({ requestedRole: 'commenter' }), commenter as never)
    expect(commenter.statusCode).toBe(201)
    expect(vi.mocked(docAccessRequestRepo.submit)).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestedRoleNum: 4 }),
    )

    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({ status: 1, space_id: 's_1', doc_type: 'doc' } as never)
    const nonHtml = mockRes()
    await submitHandler()(req({ requestedRole: 'commenter' }), nonHtml as never)
    expect(nonHtml.statusCode).toBe(201)
    expect(vi.mocked(docAccessRequestRepo.submit)).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestedRoleNum: 4 }),
    )
  })
})

// ── submit: Space-bot snapshot gate ─────────────────────────────────────────
describe('POST /:docId/access-requests — bot_uids snapshot subset gate', () => {
  const submitHandler = () => handlerFor('/:docId/access-requests', 'post')
  const req = (body: Record<string, unknown>) =>
    ({ uid: 'u_applicant', spaceId: 's_1', octoToken: 'caller-tok', params: { docId: 'd_1' }, body }) as never

  beforeEach(() => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({ status: 1, space_id: 's_1' } as never)
    vi.mocked(resolveRole).mockResolvedValue('none')
    vi.mocked(docAccessRequestRepo.submit).mockResolvedValue({ requestId: 'req_b', status: 1 })
  })

  it('admits the caller\u2019s OWN bots in this Space (subset) and stores the snapshot', async () => {
    // Caller owns bot_a, bot_b, bot_c in s_1; requests a subset.
    mockOwnedBotsInSpace.mockResolvedValue(['bot_a', 'bot_b', 'bot_c'])
    const res = mockRes()
    await submitHandler()(req({ requestedRole: 'writer', botUids: ['bot_b', 'bot_a'] }), res as never)
    expect(res.statusCode).toBe(201)
    // ownedBotsInSpace is resolved with the caller\u2019s own token + the doc\u2019s space.
    expect(mockOwnedBotsInSpace).toHaveBeenCalledWith('u_applicant', 's_1', 'caller-tok')
    // Stored snapshot is normalized (sorted, deduped).
    expect(vi.mocked(docAccessRequestRepo.submit)).toHaveBeenCalledWith(
      expect.objectContaining({ botUids: ['bot_a', 'bot_b'] }),
    )
    expect(vi.mocked(notifyDocAccessRequested)).toHaveBeenCalledWith(
      expect.objectContaining({ botUids: ['bot_a', 'bot_b'] }),
    )
  })

  it('rejects (403) a bot the caller does NOT own in the Space \u2014 someone else\u2019s bot', async () => {
    // Caller owns only bot_a; bot_other belongs to a different user.
    mockOwnedBotsInSpace.mockResolvedValue(['bot_a'])
    const res = mockRes()
    await submitHandler()(req({ botUids: ['bot_a', 'bot_other'] }), res as never)
    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({ error: 'bot_not_owned_in_space', botUids: ['bot_other'] })
    // Nothing written when any bot is inadmissible (fail closed, no partial row).
    expect(vi.mocked(docAccessRequestRepo.submit)).not.toHaveBeenCalled()
  })

  it('rejects (403) a cross-Space bot (owned map is scoped to THIS doc\u2019s space)', async () => {
    // The caller owns bot_x in some OTHER space, so ownedBotsInSpace(s_1) omits it.
    mockOwnedBotsInSpace.mockResolvedValue([])
    const res = mockRes()
    await submitHandler()(req({ botUids: ['bot_x'] }), res as never)
    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({ error: 'bot_not_owned_in_space', botUids: ['bot_x'] })
    expect(vi.mocked(docAccessRequestRepo.submit)).not.toHaveBeenCalled()
  })

  it('fail-closed: an unresolvable owned set (transport failure => []) rejects any submitted bot', async () => {
    mockOwnedBotsInSpace.mockResolvedValue([]) // fail-closed empty from identity layer
    const res = mockRes()
    await submitHandler()(req({ botUids: ['bot_a'] }), res as never)
    expect(res.statusCode).toBe(403)
    expect(vi.mocked(docAccessRequestRepo.submit)).not.toHaveBeenCalled()
  })

  it('enforces the count cap: > MAX_BOT_UIDS submitted bots -> 400, no ownership check, no row', async () => {
    const many = Array.from({ length: 51 }, (_, i) => `bot_${String(i).padStart(2, '0')}`)
    const res = mockRes()
    await submitHandler()(req({ botUids: many }), res as never)
    expect(res.statusCode).toBe(400)
    expect(mockOwnedBotsInSpace).not.toHaveBeenCalled()
    expect(vi.mocked(docAccessRequestRepo.submit)).not.toHaveBeenCalled()
  })

  it('rejects (400) junk entries strictly (non-strings, blanks, over-long, duplicates) — no silent drop', async () => {
    mockOwnedBotsInSpace.mockResolvedValue(['bot_a'])
    const overlong = 'b'.repeat(65)
    for (const bad of [['bot_a', ''], ['bot_a', 123], ['bot_a', overlong], ['bot_a', 'bot_a'], ['bot_a', ' bot_b']]) {
      const res = mockRes()
      await submitHandler()(req({ botUids: bad }), res as never)
      expect(res.statusCode).toBe(400)
    }
    // A strict 400 never reaches the ownership check or writes a row.
    expect(mockOwnedBotsInSpace).not.toHaveBeenCalled()
    expect(vi.mocked(docAccessRequestRepo.submit)).not.toHaveBeenCalled()
  })

  it('zero bots (omitted botUids) never calls the ownership resolver \u2014 legacy path unchanged', async () => {
    const res = mockRes()
    await submitHandler()(req({ requestedRole: 'reader' }), res as never)
    expect(res.statusCode).toBe(201)
    expect(mockOwnedBotsInSpace).not.toHaveBeenCalled()
    expect(vi.mocked(docAccessRequestRepo.submit)).toHaveBeenCalledWith(
      expect.objectContaining({ botUids: [] }),
    )
  })

  it.each(['writer', 'admin'] as const)(
    '%s requester with bots creates a pending request for admin approval',
    async (currentRole) => {
      vi.mocked(resolveRole).mockResolvedValue(currentRole)
      mockOwnedBotsInSpace.mockResolvedValue(['bot_a'])
      const res = mockRes()
      await submitHandler()(req({ requestedRole: 'reader', botUids: ['bot_a'] }), res as never)
      expect(res.statusCode).toBe(201)
      expect(res.body).toEqual({ requestId: 'req_b', status: 'pending' })
      expect(mockOwnedBotsInSpace).toHaveBeenCalledWith('u_applicant', 's_1', 'caller-tok')
      expect(vi.mocked(docAccessRequestRepo.submit)).toHaveBeenCalledWith(
        expect.objectContaining({ requestedRoleNum: 1, botUids: ['bot_a'] }),
      )
    },
  )

  it('writer without bots keeps the legacy already_granted no-op', async () => {
    vi.mocked(resolveRole).mockResolvedValue('writer')
    const res = mockRes()
    await submitHandler()(req({ requestedRole: 'reader' }), res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ status: 'already_granted', role: 'writer' })
    expect(mockOwnedBotsInSpace).not.toHaveBeenCalled()
    expect(vi.mocked(docAccessRequestRepo.submit)).not.toHaveBeenCalled()
  })

  it('a bot-mount submit (no session token) cannot carry bots \u2014 owned set empty => 403', async () => {
    // Bot mount: req.octoToken is undefined. ownedBotsInSpace gets '' and returns
    // [] (fail-closed), so any submitted bot is rejected.
    mockOwnedBotsInSpace.mockResolvedValue([])
    const botReq = ({ uid: 'bot_self', spaceId: 's_1', params: { docId: 'd_1' }, body: { botUids: ['bot_a'] } }) as never
    const res = mockRes()
    await submitHandler()(botReq, res as never)
    expect(res.statusCode).toBe(403)
    expect(mockOwnedBotsInSpace).toHaveBeenCalledWith('bot_self', 's_1', '')
    expect(vi.mocked(docAccessRequestRepo.submit)).not.toHaveBeenCalled()
  })
})

// ── list ──────────────────────────────────────────────────────────────────
describe('GET /:docId/access-requests — list pending (admin)', () => {
  const listHandler = () => handlerFor('/:docId/access-requests', 'get')

  it('returns mapped pending items', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(okGuard)
    vi.mocked(docAccessRequestRepo.listByStatus).mockResolvedValue([
      {
        doc_id: 'd_1',
        uid: 'u_applicant',
        requested_role: 2,
        reason: 'edit pls',
        status: 1,
        request_id: 'req_x',
        decided_by: '',
        bot_uids: ['bot_a', 'bot_b'],
        created_at: new Date(0),
        updated_at: new Date(0),
      },
    ])
    const res = mockRes()
    await listHandler()({ uid: 'u_admin', params: { docId: 'd_1' }, query: {} } as never, res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      items: [
        { requestId: 'req_x', uid: 'u_applicant', requestedRole: 'writer', reason: 'edit pls', botUids: ['bot_a', 'bot_b'], createdAt: new Date(0) },
      ],
    })
  })

  it('blocked guard short-circuits (no list read)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(null)
    const res = mockRes()
    await listHandler()({ uid: 'u_reader', params: { docId: 'd_1' }, query: {} } as never, res as never)
    expect(vi.mocked(docAccessRequestRepo.listByStatus)).not.toHaveBeenCalled()
  })
})

// ── approve ─────────────────────────────────────────────────────────────────
describe('POST /:docId/access-requests/:requestId/approve', () => {
  const approveHandler = () => handlerFor('/:docId/access-requests/:requestId/approve', 'post')
  const req = (body: Record<string, unknown>) =>
    ({ uid: 'u_admin', params: { docId: 'd_1', requestId: 'req_x' }, body }) as never

  it('grants via shared max-merge core + marks approved -> 200', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(okGuard)
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValue({
      doc_id: 'd_1',
      uid: 'u_applicant',
      requested_role: 1,
      reason: '',
      status: 1,
      request_id: 'req_x',
      decided_by: '',
      created_at: new Date(0),
      updated_at: new Date(0),
    })
    vi.mocked(grantForwardAccess).mockResolvedValue({ finalRole: 'writer', changed: true })
    const res = mockRes()
    await approveHandler()(req({ role: 'writer' }), res as never)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: true, role: 'writer' })
    expect(vi.mocked(grantForwardAccess)).toHaveBeenCalledWith({
      docId: 'd_1',
      documentName: 'doc-d_1',
      uid: 'u_applicant',
      roleNum: 2,
      grantedBy: 'u_admin',
    })
    expect(vi.mocked(docAccessRequestRepo.decide)).toHaveBeenCalledWith({
      docId: 'd_1',
      requestId: 'req_x',
      status: REQUEST_STATUS_APPROVED,
      decidedBy: 'u_admin',
    })
  })

  it('unknown request -> 404, no grant', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(okGuard)
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValue(null)
    const res = mockRes()
    await approveHandler()(req({ role: 'reader' }), res as never)
    expect(res.statusCode).toBe(404)
    expect(vi.mocked(grantForwardAccess)).not.toHaveBeenCalled()
  })

  it('approves commenter and rejects an explicit invalid override before deciding', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(okGuard)
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValue({
      doc_id: 'd_1', uid: 'u_applicant', requested_role: 4, reason: '', status: 1,
      request_id: 'req_x', decided_by: '', created_at: new Date(0), updated_at: new Date(0),
    })
    const commenter = mockRes()
    await approveHandler()(req({ role: 'commenter' }), commenter as never)
    expect(commenter.statusCode).toBe(200)
    expect(vi.mocked(grantForwardAccess)).toHaveBeenLastCalledWith(expect.objectContaining({ roleNum: 4 }))

    vi.mocked(docAccessRequestRepo.decide).mockClear()
    const invalid = mockRes()
    await approveHandler()(req({ role: 'admin' }), invalid as never)
    expect(invalid.statusCode).toBe(400)
    expect(vi.mocked(docAccessRequestRepo.decide)).not.toHaveBeenCalled()
  })

  // Regression (§ review打回 blocker): grant MUST be gated on a genuine
  // pending -> approved transition. decide() owns the only WHERE status=pending
  // guard, so when it reports no row transitioned we授权 nothing — otherwise a
  // replayed / already-decided approve silently overwrites a denial or double-
  // grants. These three cases pin decide()->grant ordering.
  const requestRow = (status: number) => ({
    doc_id: 'd_1',
    uid: 'u_applicant',
    requested_role: 1,
    reason: '',
    status,
    request_id: 'req_x',
    decided_by: 'u_admin',
    created_at: new Date(0),
    updated_at: new Date(0),
  })

  it('① approving an already-denied request -> 409, no grant', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(okGuard)
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValue(requestRow(REQUEST_STATUS_DENIED))
    // Real repo returns false: the WHERE status=pending UPDATE matched no row.
    vi.mocked(docAccessRequestRepo.decide).mockResolvedValue(false)
    const res = mockRes()
    await approveHandler()(req({ role: 'writer' }), res as never)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'not_pending' })
    expect(vi.mocked(grantForwardAccess)).not.toHaveBeenCalled()
  })

  it('② approving an already-approved request -> 409, idempotent (no double grant)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(okGuard)
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValue(requestRow(REQUEST_STATUS_APPROVED))
    vi.mocked(docAccessRequestRepo.decide).mockResolvedValue(false)
    const res = mockRes()
    await approveHandler()(req({ role: 'writer' }), res as never)
    expect(res.statusCode).toBe(409)
    expect(vi.mocked(grantForwardAccess)).not.toHaveBeenCalled()
  })

  it('③ decide() returns false (lost race) -> no grant, decide runs before grant', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(okGuard)
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValue(requestRow(1))
    vi.mocked(docAccessRequestRepo.decide).mockResolvedValue(false)
    const res = mockRes()
    await approveHandler()(req({ role: 'writer' }), res as never)
    expect(res.statusCode).toBe(409)
    expect(vi.mocked(docAccessRequestRepo.decide)).toHaveBeenCalledWith({
      docId: 'd_1',
      requestId: 'req_x',
      status: REQUEST_STATUS_APPROVED,
      decidedBy: 'u_admin',
    })
    expect(vi.mocked(grantForwardAccess)).not.toHaveBeenCalled()
  })
})

// ── deny ────────────────────────────────────────────────────────────────────
describe('POST /:docId/access-requests/:requestId/approve — carried Space-bot snapshot', () => {
  const approveHandler = () => handlerFor('/:docId/access-requests/:requestId/approve', 'post')
  const req = (body: Record<string, unknown>) =>
    ({ uid: 'u_admin', params: { docId: 'd_1', requestId: 'req_x' }, body }) as never
  const rowWithBots = (bots: string[], status = 1) => ({
    doc_id: 'd_1',
    uid: 'u_applicant',
    requested_role: 2,
    reason: '',
    status,
    request_id: 'req_x',
    decided_by: '',
    bot_uids: bots,
    created_at: new Date(0),
    updated_at: new Date(0),
  })

  it('grants the requester AND each carried bot the same role; returns succeeded/failed', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(okGuard)
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValue(rowWithBots(['bot_a', 'bot_b']))
    vi.mocked(docAccessRequestRepo.decide).mockResolvedValue(true)
    vi.mocked(grantForwardAccess).mockResolvedValue({ finalRole: 'writer', changed: true })
    const res = mockRes()
    await approveHandler()(req({ role: 'writer' }), res as never)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      role: 'writer',
      botGrantResult: { succeeded: ['bot_a', 'bot_b'], failed: [] },
    })
    // requester + 2 bots, each at roleNum 2 (writer), via the shared grant core.
    expect(vi.mocked(grantForwardAccess)).toHaveBeenCalledTimes(3)
    for (const uid of ['u_applicant', 'bot_a', 'bot_b']) {
      expect(vi.mocked(grantForwardAccess)).toHaveBeenCalledWith(
        expect.objectContaining({ uid, roleNum: 2, docId: 'd_1', grantedBy: 'u_admin' }),
      )
    }
  })

  it('partial failure: one bot grant throws, request stays approved, failed bot reported', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(okGuard)
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValue(rowWithBots(['bot_a', 'bot_bad', 'bot_c']))
    vi.mocked(docAccessRequestRepo.decide).mockResolvedValue(true)
    vi.mocked(grantForwardAccess).mockImplementation(async (p: { uid: string }) => {
      if (p.uid === 'bot_bad') throw new Error('transient grant failure')
      return { finalRole: 'writer', changed: true }
    })
    const res = mockRes()
    await approveHandler()(req({ role: 'writer' }), res as never)

    // Approval stands (200) even though one bot failed.
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      role: 'writer',
      botGrantResult: {
        succeeded: ['bot_a', 'bot_c'],
        failed: [{ uid: 'bot_bad', reason: 'grant_failed' }],
      },
    })
    expect(vi.mocked(docAccessRequestRepo.decide)).toHaveBeenCalledTimes(1)
  })

  it('already-high-role bot is not downgraded (grantForward skip) and counts as succeeded', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(okGuard)
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValue(rowWithBots(['bot_admin']))
    vi.mocked(docAccessRequestRepo.decide).mockResolvedValue(true)
    // grantForwardAccess is the only-up/no-downgrade seam; a bot already admin
    // returns finalRole:'admin', changed:false (idempotent success, no write).
    vi.mocked(grantForwardAccess).mockImplementation(async (p: { uid: string }) =>
      p.uid === 'bot_admin'
        ? { finalRole: 'admin', changed: false }
        : { finalRole: 'writer', changed: true },
    )
    const res = mockRes()
    await approveHandler()(req({ role: 'writer' }), res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      role: 'writer',
      botGrantResult: { succeeded: ['bot_admin'], failed: [] },
    })
  })

  it('duplicate approval (already-decided) grants NO bot and returns 409 not_pending', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(okGuard)
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValue(rowWithBots(['bot_a'], REQUEST_STATUS_APPROVED))
    vi.mocked(docAccessRequestRepo.decide).mockResolvedValue(false) // CAS: already decided
    const res = mockRes()
    await approveHandler()(req({ role: 'writer' }), res as never)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'not_pending' })
    expect(vi.mocked(grantForwardAccess)).not.toHaveBeenCalled()
  })

  it('zero-bot approve returns the legacy role plus empty bots arrays', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(okGuard)
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValue(rowWithBots([]))
    vi.mocked(docAccessRequestRepo.decide).mockResolvedValue(true)
    vi.mocked(grantForwardAccess).mockResolvedValue({ finalRole: 'writer', changed: true })
    const res = mockRes()
    await approveHandler()(req({ role: 'writer' }), res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: true, role: 'writer' })
    expect(vi.mocked(grantForwardAccess)).toHaveBeenCalledTimes(1) // requester only
  })
})

describe('POST /:docId/access-requests/:requestId/deny', () => {
  const denyHandler = () => handlerFor('/:docId/access-requests/:requestId/deny', 'post')
  const req = () => ({ uid: 'u_admin', params: { docId: 'd_1', requestId: 'req_x' }, body: {} }) as never

  it('marks denied -> 200, no grant', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(okGuard)
    vi.mocked(docAccessRequestRepo.decide).mockResolvedValue(true)
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValue({
      doc_id: 'd_1',
      uid: 'u_applicant',
      requested_role: 1,
      reason: '',
      status: 1,
      request_id: 'req_x',
      decided_by: '',
      created_at: new Date(0),
      updated_at: new Date(0),
    })
    const res = mockRes()
    await denyHandler()(req(), res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(vi.mocked(docAccessRequestRepo.decide)).toHaveBeenCalledWith({
      docId: 'd_1',
      requestId: 'req_x',
      status: REQUEST_STATUS_DENIED,
      decidedBy: 'u_admin',
    })
    expect(vi.mocked(grantForwardAccess)).not.toHaveBeenCalled()
  })

  it('unknown request -> 404', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(okGuard)
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValue(null)
    const res = mockRes()
    await denyHandler()(req(), res as never)
    expect(res.statusCode).toBe(404)
    expect(vi.mocked(docAccessRequestRepo.decide)).not.toHaveBeenCalled()
  })

  // Regression (§ Jerry-Xin review 遗留非阻塞): deny MUST gate ok on a genuine
  // pending -> denied transition, mirroring approve. decide() owns the only
  // WHERE status=pending guard; when it reports no row transitioned we return
  // 409 not_pending instead of a false ok:true. These pin that contract.
  const requestRow = (status: number) => ({
    doc_id: 'd_1',
    uid: 'u_applicant',
    requested_role: 1,
    reason: '',
    status,
    request_id: 'req_x',
    decided_by: 'u_admin',
    created_at: new Date(0),
    updated_at: new Date(0),
  })

  it('denying an already-decided (non-pending) request -> 409 not_pending', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(okGuard)
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValue(requestRow(REQUEST_STATUS_APPROVED))
    // Real repo returns false: the WHERE status=pending UPDATE matched no row.
    vi.mocked(docAccessRequestRepo.decide).mockResolvedValue(false)
    const res = mockRes()
    await denyHandler()(req(), res as never)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'not_pending' })
    expect(vi.mocked(grantForwardAccess)).not.toHaveBeenCalled()
  })

  it('decide() returns false (lost race) -> 409, decide runs, no grant', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(okGuard)
    vi.mocked(docAccessRequestRepo.getByRequestId).mockResolvedValue(requestRow(1))
    vi.mocked(docAccessRequestRepo.decide).mockResolvedValue(false)
    const res = mockRes()
    await denyHandler()(req(), res as never)
    expect(res.statusCode).toBe(409)
    expect(vi.mocked(docAccessRequestRepo.decide)).toHaveBeenCalledWith({
      docId: 'd_1',
      requestId: 'req_x',
      status: REQUEST_STATUS_DENIED,
      decidedBy: 'u_admin',
    })
    expect(vi.mocked(grantForwardAccess)).not.toHaveBeenCalled()
  })
})
