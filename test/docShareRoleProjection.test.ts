import { describe, it, expect, vi, beforeEach } from 'vitest'

// Locks the space-share ROLE projection regression (#89 RC#1): a doc that is
// visible ONLY through the anyone_in_space share branch has no doc_member row,
// so the pre-fix `CASE WHEN owner THEN 3 ELSE dm.role END` yielded NULL ->
// Number(null)=0 -> reader in the route — mislabeling an EDIT-shared doc as
// read-only, out of sync with the write side (effectiveRole in shareScope.ts,
// EDIT => writer). The fix projects the share role for a confirmed member,
// RAISE-only (GREATEST over the direct role), mirroring effectiveRole. These
// are offline (sql, params) shape assertions against a mocked pool — no live
// MySQL — same technique as docMetaSpaceFilter / paginationBind.
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async () => []),
  transaction: vi.fn(),
}))

import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { docViewHistoryRepo } from '../src/db/repos/docViewHistoryRepo.js'
import { query } from '../src/db/pool.js'
import { SHARE_SCOPE_ANYONE, SHARE_ROLE_EDIT } from '../src/permission/shareScope.js'
import { ROLE_READER, ROLE_WRITER, ROLE_ADMIN } from '../src/permission/role.js'

const mockQuery = vi.mocked(query)

/** The (sql, params) of the items SELECT — the one carrying the role CASE. */
function itemsCall(): { sql: string; params: unknown[] } {
  const call = mockQuery.mock.calls.find((c) => /AS role/.test(c[0] as string))
  if (!call) throw new Error('no items query with a role projection was issued')
  return { sql: call[0] as string, params: (call[1] ?? []) as unknown[] }
}

beforeEach(() => {
  mockQuery.mockReset()
  mockQuery.mockResolvedValue([] as never)
})

// The stored numerics the SQL inlines. Guard against a drift between the SQL
// literals and the shared constants so the two can never diverge silently.
describe('share-role projection constants stay pinned to shareScope.ts', () => {
  it('anyone_in_space=1, edit=2, reader=1, writer=2, admin=3', () => {
    expect(SHARE_SCOPE_ANYONE).toBe(1)
    expect(SHARE_ROLE_EDIT).toBe(2)
    expect(ROLE_READER).toBe(1)
    expect(ROLE_WRITER).toBe(2)
    expect(ROLE_ADMIN).toBe(3)
  })
})

describe('docMetaRepo.listForUser — role CASE gains a share arm for a confirmed member (RC#1)', () => {
  it('a member gets a rank-aware raise-only share projection', async () => {
    await docMetaRepo.listForUser({
      uid: 'u_1', spaceId: 's1', isSpaceMember: true, page: 1, pageSize: 10, sort: 'updatedAt:desc',
    })
    const { sql, params } = itemsCall()
    // owner short-circuits to admin(3); the share arm is RAISE-only over dm.role.
    expect(sql).toMatch(/WHEN m\.owner_id = \? THEN 3/)
    expect(sql).not.toMatch(/GREATEST\(/)
    expect(sql).toMatch(/dm\.role = 3 THEN 3 WHEN dm\.role = 2 THEN 2/)
    expect(sql).toMatch(/dm\.role = 4 THEN 4/)
    // anyone_in_space + EDIT => writer(2); any other share role => reader(1).
    expect(sql).toMatch(new RegExp(`m\\.share_scope = ${SHARE_SCOPE_ANYONE}`))
    expect(sql).toMatch(new RegExp(`m\\.share_role = ${SHARE_ROLE_EDIT}`))
    // the share arm inlines numeric constants (no bind), so the SINGLE leading
    // owner-uid bind is unchanged — paging/args stay stable.
    expect(sql).not.toMatch(/m\.share_scope = \?/)
    expect(params[0]).toBe('u_1')

    // the share arm must add NO positional bind: a member's items binds match a
    // non-member's exactly (CASE owner uid + join uid + visibility owner uid).
    mockQuery.mockClear()
    await docMetaRepo.listForUser({
      uid: 'u_1', spaceId: 's1', isSpaceMember: false, page: 1, pageSize: 10, sort: 'updatedAt:desc',
    })
    const nonMemberBinds = itemsCall().params.length
    expect(params.length).toBe(nonMemberBinds)
  })

  it('a NON-member keeps the pre-#64 plain CASE — no share arm, no role escalation', async () => {
    await docMetaRepo.listForUser({
      uid: 'u_1', spaceId: 's1', isSpaceMember: false, page: 1, pageSize: 10, sort: 'updatedAt:desc',
    })
    const { sql } = itemsCall()
    expect(sql).toMatch(/CASE WHEN m\.owner_id = \? THEN 3[\s\S]*dm\.role = 4 THEN 4[\s\S]*ELSE NULL END/)
    expect(sql).not.toMatch(/GREATEST\(/)
    expect(sql).not.toMatch(/share_role/)
  })

  it('owner=me excludes the share arm entirely (authorship, not access)', async () => {
    await docMetaRepo.listForUser({
      uid: 'u_1', spaceId: 's1', owner: 'me', isSpaceMember: false, page: 1, pageSize: 10, sort: 'updatedAt:desc',
    })
    const { sql } = itemsCall()
    expect(sql).not.toMatch(/GREATEST\(/)
    expect(sql).not.toMatch(/share_role/)
  })
})

describe('docViewHistoryRepo.listRecent — role CASE gains a same-space-guarded share arm (RC#1)', () => {
  it('a member gets the share projection, guarded by m.space_id = v.space_id', async () => {
    await docViewHistoryRepo.listRecent({ uid: 'u_1', spaceId: 's1', isSpaceMember: true, pageSize: 10 })
    const { sql, params } = itemsCall()
    expect(sql).toMatch(/WHEN m\.owner_id = \? THEN 3/)
    expect(sql).not.toMatch(/GREATEST\(/)
    expect(sql).toMatch(/dm\.role = 3 THEN 3 WHEN dm\.role = 2 THEN 2/)
    expect(sql).toMatch(/dm\.role = 4 THEN 4/)
    // the recent list keeps the same-space guard on the share arm, matching the
    // visibility predicate: a doc shared in ANOTHER space never gets a label.
    expect(sql).toMatch(new RegExp(`m\\.share_scope = ${SHARE_SCOPE_ANYONE} AND m\\.space_id = v\\.space_id`))
    expect(sql).toMatch(new RegExp(`m\\.share_role = ${SHARE_ROLE_EDIT}`))
    // items binds still lead with (role-CASE uid, join uid, ...) — arm adds none.
    expect(params[0]).toBe('u_1')
    expect(params[1]).toBe('u_1')
  })

  it('a NON-member keeps the plain CASE — no share arm', async () => {
    await docViewHistoryRepo.listRecent({ uid: 'u_1', spaceId: 's1', isSpaceMember: false, pageSize: 10 })
    const { sql } = itemsCall()
    expect(sql).toMatch(/CASE WHEN m\.owner_id = \? THEN 3[\s\S]*dm\.role = 4 THEN 4[\s\S]*ELSE NULL END/)
    expect(sql).not.toMatch(/GREATEST\(/)
    expect(sql).not.toMatch(/share_role/)
  })
})
