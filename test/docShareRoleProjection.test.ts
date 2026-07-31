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
  it('anyone_in_space=1, edit=2, reader=1, writer=3, admin=4', () => {
    expect(SHARE_SCOPE_ANYONE).toBe(1)
    expect(SHARE_ROLE_EDIT).toBe(2)
    expect(ROLE_READER).toBe(1)
    expect(ROLE_WRITER).toBe(3)
    expect(ROLE_ADMIN).toBe(4)
  })
})

describe('docMetaRepo.listForUser — role CASE gains a share arm for a confirmed member (RC#1)', () => {
  it('a member gets the RAISE-only share projection: owner=>admin, else GREATEST(dm.role, share)', async () => {
    await docMetaRepo.listForUser({
      uid: 'u_1', spaceId: 's1', isSpaceMember: true, page: 1, pageSize: 10, sort: 'updatedAt:desc',
    })
    const { sql, params } = itemsCall()
    // owner short-circuits to admin(4); the share arm is RAISE-only over dm.role.
    expect(sql).toMatch(/WHEN m\.owner_id IN \(\?\) THEN 4/)
    expect(sql).toMatch(/GREATEST\(/)
    expect(sql).toMatch(/COALESCE\(dm\.role, 0\)/)
    // anyone_in_space + EDIT => writer(3); any other share role => reader(1).
    expect(sql).toMatch(new RegExp(`m\\.share_scope = ${SHARE_SCOPE_ANYONE}`))
    expect(sql).toMatch(new RegExp(`m\\.share_role = ${SHARE_ROLE_EDIT} THEN 3 ELSE 1`))
    // the share arm inlines numeric constants (no bind), so the SINGLE leading
    // owner-uid bind is unchanged — paging/args stay stable.
    expect(sql).not.toMatch(/m\.share_scope = \?/)
    expect(params).toEqual(['u_1', 'u_1', 's1', 'u_1'])

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
    expect(sql).toMatch(/CASE WHEN m\.owner_id IN \(\?\) THEN 4 ELSE dm\.role END/)
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

  it('owner=me projects caller-owned bot documents as admin with exact bind ordering', async () => {
    await docMetaRepo.listForUser({
      uid: 'u_1',
      spaceId: 's1',
      owner: 'me',
      ownedBots: ['bot_1', 'u_1', '', 'bot_2', 'bot_1'],
      isSpaceMember: true,
      page: 1,
      pageSize: 10,
      sort: 'updatedAt:desc',
    })
    const { sql, params } = itemsCall()

    expect(sql).toMatch(/CASE WHEN m\.owner_id IN \(\?, \?, \?\) THEN 4 ELSE dm\.role END/)
    expect(sql).toMatch(/AND m\.owner_id IN \(\?, \?, \?\)/)
    expect(sql).not.toMatch(/GREATEST\(/)
    expect(sql).not.toMatch(/share_role/)
    // Projection owner set, JOIN uid, space filter, then visibility owner set.
    expect(params).toEqual(['u_1', 'bot_1', 'bot_2', 'u_1', 's1', 'u_1', 'bot_1', 'bot_2'])
  })
})

describe('docViewHistoryRepo.listRecent — role CASE gains a same-space-guarded share arm (RC#1)', () => {
  it('a member gets the share projection, guarded by m.space_id = v.space_id', async () => {
    await docViewHistoryRepo.listRecent({ uid: 'u_1', spaceId: 's1', isSpaceMember: true, pageSize: 10 })
    const { sql, params } = itemsCall()
    expect(sql).toMatch(/WHEN m\.owner_id = \? THEN 4/)
    expect(sql).toMatch(/GREATEST\(/)
    expect(sql).toMatch(/COALESCE\(dm\.role, 0\)/)
    // the recent list keeps the same-space guard on the share arm, matching the
    // visibility predicate: a doc shared in ANOTHER space never gets a label.
    expect(sql).toMatch(new RegExp(`m\\.share_scope = ${SHARE_SCOPE_ANYONE} AND m\\.space_id = v\\.space_id`))
    expect(sql).toMatch(new RegExp(`m\\.share_role = ${SHARE_ROLE_EDIT} THEN 3 ELSE 1`))
    // items binds still lead with (role-CASE uid, join uid, ...) — arm adds none.
    expect(params[0]).toBe('u_1')
    expect(params[1]).toBe('u_1')
  })

  it('a NON-member keeps the plain CASE — no share arm', async () => {
    await docViewHistoryRepo.listRecent({ uid: 'u_1', spaceId: 's1', isSpaceMember: false, pageSize: 10 })
    const { sql } = itemsCall()
    expect(sql).toMatch(/CASE WHEN m\.owner_id = \? THEN 4 ELSE dm\.role END/)
    expect(sql).not.toMatch(/GREATEST\(/)
    expect(sql).not.toMatch(/share_role/)
  })
})
