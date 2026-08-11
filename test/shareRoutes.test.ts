import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test: mock the guard, the doc_meta repo write, and the epoch bump.
// The share handlers run against the mocked guard so validation / normalization /
// epoch-bump behavior is exercised without live infra (mirrors docsRoutes.test).
vi.mock('../src/api/guard.js', () => ({
  requireDocRole: vi.fn(),
}))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: {
    setShareSettings: vi.fn(async () => 8),
  },
}))
vi.mock('../src/permission/epoch.js', () => ({
  refreshAndPublish: vi.fn(async () => undefined),
}))

import { getShareHandler, putShareHandler } from '../src/api/routes/docs.js'
import { requireDocRole } from '../src/api/guard.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { refreshAndPublish } from '../src/permission/epoch.js'

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

function req(body: unknown) {
  return { uid: 'u_admin', spaceId: 's1', params: { docId: 'd_1' }, body } as never
}

const guardMeta = (over: Record<string, unknown> = {}) => ({
  meta: {
    doc_id: 'd_1',
    document_name: 'octo:s1:f_default:d_1',
    space_id: 's1',
    share_scope: 0,
    share_role: 1,
    ...over,
  },
  role: 'admin',
})

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(docMetaRepo.setShareSettings).mockClear()
  vi.mocked(refreshAndPublish).mockClear()
})

describe('GET /api/v1/docs/:docId/share (#64)', () => {
  it('needs only reader and returns the current scope/role (fail-safe names)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardMeta({ share_scope: 1, share_role: 2 }) as never)
    const res = mockRes()
    await getShareHandler(req(undefined), res as never)
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('reader')
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ docId: 'd_1', shareScope: 'anyone_in_space', shareRole: 'edit' })
  })

  it('an unexpected stored value reads back as the most-restrictive default', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardMeta({ share_scope: 9, share_role: 9 }) as never)
    const res = mockRes()
    await getShareHandler(req(undefined), res as never)
    expect(res.body).toEqual({ docId: 'd_1', shareScope: 'restricted', shareRole: 'read' })
  })

  it('propagates the guard rejection (404/403) without emitting a body', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(null)
    const res = mockRes()
    await getShareHandler(req(undefined), res as never)
    expect(res.statusCode).toBe(0) // guard wrote its own status; handler returned early
    expect(docMetaRepo.setShareSettings).not.toHaveBeenCalled()
  })
})

describe('PUT /api/v1/docs/:docId/share (#64)', () => {
  it('needs admin, writes anyone_in_space/edit and bumps the epoch DOC-WIDE (no uid)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardMeta() as never)
    const res = mockRes()
    await putShareHandler(req({ shareScope: 'anyone_in_space', shareRole: 'edit' }), res as never)
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('admin')
    expect(docMetaRepo.setShareSettings).toHaveBeenCalledWith('d_1', 1, 2)
    // doc-wide invalidation: refreshAndPublish called with (documentName, newEpoch)
    // and NO uid — the setShareSettings tx already bumped the epoch atomically.
    expect(refreshAndPublish).toHaveBeenCalledWith('octo:s1:f_default:d_1', 8)
    expect(vi.mocked(refreshAndPublish).mock.calls[0]!.length).toBe(2)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ docId: 'd_1', shareScope: 'anyone_in_space', shareRole: 'edit' })
  })

  it('normalizes shareRole to read when scope=restricted, ignoring the sent edit', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardMeta() as never)
    const res = mockRes()
    await putShareHandler(req({ shareScope: 'restricted', shareRole: 'edit' }), res as never)
    expect(docMetaRepo.setShareSettings).toHaveBeenCalledWith('d_1', 0, 1)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ docId: 'd_1', shareScope: 'restricted', shareRole: 'read' })
  })

  it('accepts restricted with no shareRole at all', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardMeta() as never)
    const res = mockRes()
    await putShareHandler(req({ shareScope: 'restricted' }), res as never)
    expect(docMetaRepo.setShareSettings).toHaveBeenCalledWith('d_1', 0, 1)
    expect(res.statusCode).toBe(200)
  })

  it('400 invalid_scope for a scope outside the enum', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardMeta() as never)
    const res = mockRes()
    await putShareHandler(req({ shareScope: 'public', shareRole: 'read' }), res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_scope' })
    expect(docMetaRepo.setShareSettings).not.toHaveBeenCalled()
    expect(refreshAndPublish).not.toHaveBeenCalled()
  })

  it('400 invalid_role when anyone_in_space is missing a valid shareRole', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(guardMeta() as never)
    for (const body of [
      { shareScope: 'anyone_in_space' },
      { shareScope: 'anyone_in_space', shareRole: 'bogus' },
      { shareScope: 'anyone_in_space', shareRole: 'admin' },
    ]) {
      const res = mockRes()
      await putShareHandler(req(body), res as never)
      expect(res.statusCode).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_role' })
    }
    expect(docMetaRepo.setShareSettings).not.toHaveBeenCalled()
  })

  it('does not write when the admin guard rejects (403/404/409)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(null)
    const res = mockRes()
    await putShareHandler(req({ shareScope: 'anyone_in_space', shareRole: 'edit' }), res as never)
    expect(docMetaRepo.setShareSettings).not.toHaveBeenCalled()
    expect(refreshAndPublish).not.toHaveBeenCalled()
  })
})
