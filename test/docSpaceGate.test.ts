import { describe, it, expect, vi, beforeEach } from 'vitest'

// Unit tests for the single-doc space-scoping gate (remove-sp §6). requireDocRole
// now reads the explicit per-mount policy from `req.docSpaceScope`, NOT a spaceId
// argument:
//   - Bot ({ mode: 'bot', spaceId }): a cross-space hit 404s BEFORE the role
//     check, so a doc in another space is indistinguishable from a missing one.
//   - Human ({ mode: 'human' }): locate by docId ALONE — no cross-space gate, so
//     a cross-Space direct member / owner resolves exactly as if `sp` were right.
//   - Unset scope: fail CLOSED (bot with empty space) so a wiring bug 404s rather
//     than silently opening the human locate.
// We mock the repo and resolveRole so the gate logic is exercised in isolation;
// roleAtLeast + resolveEffectiveRole run for real (restricted docs short-circuit
// to the direct role with zero IO).
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: {
    getByDocId: vi.fn(),
  },
}))
vi.mock('../src/permission/resolveRole.js', () => ({
  resolveRole: vi.fn(),
}))

import { requireDocRole } from '../src/api/guard.js'
import type { DocSpaceScope } from '../src/api/middleware/docSpaceScope.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { resolveRole } from '../src/permission/resolveRole.js'

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

/** Minimal Express-like req carrying the per-mount doc space-scoping policy. */
function mockReq(opts: { uid?: string; scope?: DocSpaceScope; octoToken?: string } = {}) {
  return {
    uid: opts.uid ?? 'u_1',
    octoToken: opts.octoToken,
    docSpaceScope: opts.scope,
  }
}

/** A live (status===1) doc_meta row in space 's1'. */
function metaRow(over: Record<string, unknown> = {}) {
  return {
    doc_id: 'd_1',
    document_name: 'octo:s1:f_default:d_1',
    title: 'My Doc',
    owner_id: 'u_owner',
    space_id: 's1',
    folder_id: 'f_default',
    doc_type: 'doc',
    status: 1,
    permission_epoch: 7,
    share_scope: 0,
    share_role: 0,
    created_at: new Date(0),
    updated_at: new Date(1000),
    created_by: 'u_owner',
    updated_by: 'u_owner',
    ...over,
  }
}

beforeEach(() => {
  vi.mocked(docMetaRepo.getByDocId).mockReset()
  vi.mocked(resolveRole).mockReset()
})

describe('requireDocRole — Bot mount cross-space gate (§6)', () => {
  const botScope: DocSpaceScope = { mode: 'bot', spaceId: 's2' }

  it('404s a cross-space doc and never consults the role (gate runs before 403)', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow({ space_id: 's1' }) as never)
    const res = mockRes()

    const guard = await requireDocRole(mockReq({ uid: 'u_1', scope: botScope }) as never, res as never, 'd_1', 'reader')

    expect(guard).toBeNull()
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
    // The gate short-circuits before role resolution — no existence/role leak.
    expect(vi.mocked(resolveRole)).not.toHaveBeenCalled()
  })

  it('returns 404 (not 403) even when the caller would otherwise be admin in the doc', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow({ space_id: 's1' }) as never)
    vi.mocked(resolveRole).mockResolvedValue('admin' as never)
    const res = mockRes()

    const guard = await requireDocRole(mockReq({ uid: 'u_admin', scope: botScope }) as never, res as never, 'd_1', 'admin')

    expect(guard).toBeNull()
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
    expect(vi.mocked(resolveRole)).not.toHaveBeenCalled()
  })

  it('404s a cross-space archived doc (gate runs before the 409 archived branch)', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow({ space_id: 's1', status: 2 }) as never)
    const res = mockRes()

    const guard = await requireDocRole(mockReq({ uid: 'u_1', scope: botScope }) as never, res as never, 'd_1', 'reader')

    expect(guard).toBeNull()
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
  })

  it('lets a same-space bot request through and resolves the role as before', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow({ space_id: 's1' }) as never)
    vi.mocked(resolveRole).mockResolvedValue('writer' as never)
    const res = mockRes()

    const guard = await requireDocRole(
      mockReq({ uid: 'u_1', scope: { mode: 'bot', spaceId: 's1' } }) as never,
      res as never,
      'd_1',
      'reader',
    )

    expect(res.statusCode).toBe(0)
    expect(guard).not.toBeNull()
    expect(guard!.role).toBe('writer')
    expect(vi.mocked(resolveRole)).toHaveBeenCalledWith('u_1', 'd_1')
  })
})

describe('requireDocRole — Human mount locates by docId (§6)', () => {
  const humanScope: DocSpaceScope = { mode: 'human' }

  it('resolves a doc that lives in ANOTHER space — the human mount never gates on Space', async () => {
    // The whole point of remove-sp: a cross-Space direct member opens the doc by
    // docId regardless of any (now absent / wrong) X-Space-Id. No 404 gate here.
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow({ space_id: 's_other' }) as never)
    vi.mocked(resolveRole).mockResolvedValue('writer' as never)
    const res = mockRes()

    const guard = await requireDocRole(mockReq({ uid: 'u_1', scope: humanScope }) as never, res as never, 'd_1', 'reader')

    expect(res.statusCode).toBe(0)
    expect(guard).not.toBeNull()
    expect(guard!.role).toBe('writer')
    expect(guard!.meta.space_id).toBe('s_other')
  })

  it('preserves the existing 404 for a missing/deleted doc', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(null as never)
    const res = mockRes()

    const guard = await requireDocRole(mockReq({ uid: 'u_1', scope: humanScope }) as never, res as never, 'd_1', 'reader')

    expect(guard).toBeNull()
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
    expect(vi.mocked(resolveRole)).not.toHaveBeenCalled()
  })

  it('returns 409 for an archived doc only after the role gate passes', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow({ status: 2 }) as never)
    vi.mocked(resolveRole).mockResolvedValue('reader' as never)
    const res = mockRes()

    const guard = await requireDocRole(mockReq({ uid: 'u_1', scope: humanScope }) as never, res as never, 'd_1', 'reader')

    expect(guard).toBeNull()
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'conflict' })
  })

  it('does not leak archived state to a caller with no role', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow({ status: 2 }) as never)
    vi.mocked(resolveRole).mockResolvedValue('none' as never)
    const res = mockRes()

    const guard = await requireDocRole(mockReq({ uid: 'u_none', scope: humanScope }) as never, res as never, 'd_1', 'reader')

    expect(guard).toBeNull()
    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({ error: 'forbidden' })
  })

  it('preserves the existing 403 when the role is insufficient', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow() as never)
    vi.mocked(resolveRole).mockResolvedValue('reader' as never)
    const res = mockRes()

    const guard = await requireDocRole(mockReq({ uid: 'u_1', scope: humanScope }) as never, res as never, 'd_1', 'admin')

    expect(guard).toBeNull()
    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({ error: 'forbidden' })
  })
})

describe('requireDocRole — fail-closed when the mount set no policy', () => {
  it('treats an unset scope as bot-with-empty-space, so any real doc 404s (wiring bug is safe)', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow({ space_id: 's1' }) as never)
    const res = mockRes()

    const guard = await requireDocRole(mockReq({ uid: 'u_1', scope: undefined }) as never, res as never, 'd_1', 'reader')

    expect(guard).toBeNull()
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
    expect(vi.mocked(resolveRole)).not.toHaveBeenCalled()
  })
})
