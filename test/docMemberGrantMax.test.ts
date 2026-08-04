import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test for docMemberRepo.upsertGrantMax (§2 max-merge). The method
// runs a single INSERT ... ON DUPLICATE KEY UPDATE that keeps the higher-RANK
// role (rank compare via FIELD(), not the raw stored value — commenter's stored
// 4 ranks below writer's 2) and reports whether a genuine grant/upgrade happened
// via the ResultSetHeader's affectedRows (insert=1, real update=2, no-change=0).
// We mock the pool so the SQL is asserted and the affectedRows -> boolean
// contract is locked without a DB.
const execute = vi.fn()
vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ execute }),
  // query is imported by the repo module but unused on this path; stub it.
  query: vi.fn(async () => []),
}))

import { docMemberRepo, SOURCE_DIRECT } from '../src/db/repos/docMemberRepo.js'

beforeEach(() => {
  execute.mockReset()
})

const params = { docId: 'd_1', uid: 'u_recipient', roleNum: 1, grantedBy: 'u_admin' }

describe('docMemberRepo.upsertGrantMax — only-up max-merge', () => {
  it('compares by privilege rank (FIELD), not the raw stored value, and passes binds in order', async () => {
    execute.mockResolvedValue([{ affectedRows: 1 }, undefined])
    await docMemberRepo.upsertGrantMax(params)

    const [sql, binds] = execute.mock.calls[0]!
    // Rank ordering reader<commenter<writer<admin => FIELD(role, 1, 4, 2, 3).
    // This keeps the higher RANK, so granting commenter (4) never downgrades a
    // writer (2) — which a raw GREATEST on the stored value would wrongly do.
    expect(sql).toContain('FIELD(role, 1, 4, 2, 3)')
    expect(sql).toContain('FIELD(VALUES(role), 1, 4, 2, 3)')
    expect(sql).not.toContain('GREATEST')
    // source=direct is inlined (SOURCE_DIRECT), invite_token=''.
    expect(sql).toContain(`${SOURCE_DIRECT}, ''`)
    expect(binds).toEqual(['d_1', 'u_recipient', 1, 'u_admin'])
  })

  it('affectedRows=1 (fresh insert) -> changed true', async () => {
    execute.mockResolvedValue([{ affectedRows: 1 }, undefined])
    expect(await docMemberRepo.upsertGrantMax(params)).toBe(true)
  })

  it('affectedRows=2 (real upgrade) -> changed true', async () => {
    execute.mockResolvedValue([{ affectedRows: 2 }, undefined])
    expect(await docMemberRepo.upsertGrantMax(params)).toBe(true)
  })

  it('affectedRows=0 (already >= target, GREATEST no-op) -> changed false', async () => {
    execute.mockResolvedValue([{ affectedRows: 0 }, undefined])
    expect(await docMemberRepo.upsertGrantMax(params)).toBe(false)
  })
})
