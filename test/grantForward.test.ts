import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test for grantForwardAccess (§2 max-merge + §6 epoch + owner/admin
// skip). This is the shared core behind both forward-grant and access-request
// approve, so the §7 permission matrix ("only up, never down") is asserted here
// once. We mock the member repo, resolveRole, and bumpEpoch; role math (real
// role.js) stays live so finalRole is computed for real.
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: { upsertGrantMax: vi.fn() },
}))
vi.mock('../src/permission/resolveRole.js', () => ({
  resolveRole: vi.fn(),
}))
vi.mock('../src/permission/epoch.js', () => ({
  bumpEpoch: vi.fn(async () => 1),
}))

import { grantForwardAccess } from '../src/api/services/grantForward.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { resolveRole } from '../src/permission/resolveRole.js'
import { bumpEpoch } from '../src/permission/epoch.js'
import { roleToNumber } from '../src/permission/role.js'

const base = { docId: 'd_1', documentName: 'doc-d_1', uid: 'u_recipient', grantedBy: 'u_admin' }

beforeEach(() => {
  vi.mocked(docMemberRepo.upsertGrantMax).mockReset()
  vi.mocked(resolveRole).mockReset()
  vi.mocked(bumpEpoch).mockClear()
})

describe('grantForwardAccess — owner / existing admin skip', () => {
  it('owner (resolveRole => admin): no write, no epoch bump, stays admin', async () => {
    vi.mocked(resolveRole).mockResolvedValue('admin')
    const out = await grantForwardAccess({ ...base, roleNum: roleToNumber('reader') })

    expect(out).toEqual({ finalRole: 'admin', changed: false })
    expect(vi.mocked(docMemberRepo.upsertGrantMax)).not.toHaveBeenCalled()
    expect(vi.mocked(bumpEpoch)).not.toHaveBeenCalled()
  })
})

describe('grantForwardAccess — only-up matrix (§7)', () => {
  it('none + reader -> insert, bump, reader', async () => {
    vi.mocked(resolveRole).mockResolvedValue('none')
    vi.mocked(docMemberRepo.upsertGrantMax).mockResolvedValue(true)
    const out = await grantForwardAccess({ ...base, roleNum: roleToNumber('reader') })

    expect(out).toEqual({ finalRole: 'reader', changed: true })
    expect(vi.mocked(docMemberRepo.upsertGrantMax)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(bumpEpoch)).toHaveBeenCalledWith('d_1', 'doc-d_1', 'u_recipient')
  })

  it('none + writer -> insert, bump, writer', async () => {
    vi.mocked(resolveRole).mockResolvedValue('none')
    vi.mocked(docMemberRepo.upsertGrantMax).mockResolvedValue(true)
    const out = await grantForwardAccess({ ...base, roleNum: roleToNumber('writer') })

    expect(out).toEqual({ finalRole: 'writer', changed: true })
    expect(vi.mocked(bumpEpoch)).toHaveBeenCalledTimes(1)
  })

  it('reader + writer -> upgrade, bump, writer', async () => {
    vi.mocked(resolveRole).mockResolvedValue('reader')
    vi.mocked(docMemberRepo.upsertGrantMax).mockResolvedValue(true)
    const out = await grantForwardAccess({ ...base, roleNum: roleToNumber('writer') })

    expect(out).toEqual({ finalRole: 'writer', changed: true })
    expect(vi.mocked(bumpEpoch)).toHaveBeenCalledTimes(1)
  })

  it('writer + reader -> NO downgrade: GREATEST no-op, no bump, stays writer', async () => {
    vi.mocked(resolveRole).mockResolvedValue('writer')
    // GREATEST leaves writer untouched => affectedRows 0 => changed false.
    vi.mocked(docMemberRepo.upsertGrantMax).mockResolvedValue(false)
    const out = await grantForwardAccess({ ...base, roleNum: roleToNumber('reader') })

    expect(out).toEqual({ finalRole: 'writer', changed: false })
    // upsert IS attempted (it is the atomic guard), but no epoch bump on no-op.
    expect(vi.mocked(docMemberRepo.upsertGrantMax)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(bumpEpoch)).not.toHaveBeenCalled()
  })

  it('reader + commenter -> upgrade, bump, commenter', async () => {
    vi.mocked(resolveRole).mockResolvedValue('reader')
    vi.mocked(docMemberRepo.upsertGrantMax).mockResolvedValue(true)
    const out = await grantForwardAccess({ ...base, roleNum: roleToNumber('commenter') })

    expect(out).toEqual({ finalRole: 'commenter', changed: true })
    expect(vi.mocked(bumpEpoch)).toHaveBeenCalledTimes(1)
  })

  it('writer + commenter -> NO downgrade despite stored 4 > 2: stays writer', async () => {
    // commenter's stored value (4) is higher than writer's (2), but its RANK is
    // lower — granting commenter to a writer must never downgrade. The repo's
    // rank-aware upsert reports no change (affectedRows 0).
    vi.mocked(resolveRole).mockResolvedValue('writer')
    vi.mocked(docMemberRepo.upsertGrantMax).mockResolvedValue(false)
    const out = await grantForwardAccess({ ...base, roleNum: roleToNumber('commenter') })

    expect(out).toEqual({ finalRole: 'writer', changed: false })
    expect(vi.mocked(bumpEpoch)).not.toHaveBeenCalled()
  })

  it('commenter + writer -> upgrade, bump, writer', async () => {
    vi.mocked(resolveRole).mockResolvedValue('commenter')
    vi.mocked(docMemberRepo.upsertGrantMax).mockResolvedValue(true)
    const out = await grantForwardAccess({ ...base, roleNum: roleToNumber('writer') })

    expect(out).toEqual({ finalRole: 'writer', changed: true })
    expect(vi.mocked(bumpEpoch)).toHaveBeenCalledTimes(1)
  })

  it('reader + reader -> same level: no-op, no bump, stays reader', async () => {
    vi.mocked(resolveRole).mockResolvedValue('reader')
    vi.mocked(docMemberRepo.upsertGrantMax).mockResolvedValue(false)
    const out = await grantForwardAccess({ ...base, roleNum: roleToNumber('reader') })

    expect(out).toEqual({ finalRole: 'reader', changed: false })
    expect(vi.mocked(bumpEpoch)).not.toHaveBeenCalled()
  })
})
