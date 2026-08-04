import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test for the FEAT-B "my documents" extension of listForUser:
// owner='me' tightens visibility to strictly owner_id==uid (excludes
// shared-with-me), and q adds a CI substring title match with escaped wildcards.
// The REAL repo runs against a mocked pool; we assert the (sql, params) shape.
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async () => []),
  transaction: vi.fn(),
}))

import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { query } from '../src/db/pool.js'

const mockQuery = vi.mocked(query)

beforeEach(() => {
  mockQuery.mockReset()
  mockQuery.mockResolvedValue([] as never)
})

/** The (sql, params) of the items query (the last call; count is the prior one). */
function itemsCall(): { sql: string; params: unknown[] } {
  const call = mockQuery.mock.calls.at(-1)!
  return { sql: call[0] as string, params: (call[1] ?? []) as unknown[] }
}

describe('docMetaRepo.listForUser — owner=me / q (FEAT-B)', () => {
  it('default (no owner) keeps owner OR member OR space-share visibility for a SPACE MEMBER', async () => {
    await docMetaRepo.listForUser({ uid: 'u_1', spaceId: 's1', isSpaceMember: true, page: 1, pageSize: 20, sort: 'updatedAt:desc' })
    // #64 write/read symmetry: the shared-with-me list surfaces anyone_in_space
    // docs (share_scope = 1) to a confirmed Space member without a doc_member row.
    // The unconditional `m.space_id = ?` filter keeps this within the caller's
    // space, so cross-space isolation is preserved (see docMetaSpaceFilter.test.ts).
    expect(itemsCall().sql).toContain('(m.owner_id = ? OR dm.role IN (1, 2, 3, 4) OR m.share_scope = 1)')
  })

  it('CROSS-SPACE GATE: a NON-member (or unconfirmed membership) drops the space-share branch (XIN-1295)', async () => {
    // The read side must be symmetric with the write side (resolveEffectiveRole ->
    // isSpaceMember). req.spaceId is an unverified header, so a caller who is not a
    // confirmed member of the queried space must NOT see its anyone_in_space docs —
    // visibility collapses to owner OR doc_member (pre-#64). isSpaceMember omitted
    // (undefined) is treated the same as false: fail-closed, no share branch.
    await docMetaRepo.listForUser({ uid: 'u_1', spaceId: 's1', isSpaceMember: false, page: 1, pageSize: 20, sort: 'updatedAt:desc' })
    const sqlFalse = itemsCall().sql
    expect(sqlFalse).toContain('(m.owner_id = ? OR dm.role IN (1, 2, 3, 4))')
    expect(sqlFalse).not.toContain('share_scope')

    await docMetaRepo.listForUser({ uid: 'u_1', spaceId: 's1', page: 1, pageSize: 20, sort: 'updatedAt:desc' })
    expect(itemsCall().sql).not.toContain('share_scope')
  })

  it("owner='me' tightens to strictly owner_id==uid, dropping shared-with-me AND space-share", async () => {
    await docMetaRepo.listForUser({ uid: 'u_1', spaceId: 's1', owner: 'me', page: 1, pageSize: 20, sort: 'updatedAt:desc' })
    const { sql } = itemsCall()
    expect(sql).not.toContain('OR dm.role IN (1, 2, 3, 4)')
    // "my documents" is authorship, not access: a space-shared doc is NOT mine.
    expect(sql).not.toContain('share_scope')
    // Still keyed strictly on the owner predicate. With no ownedBots the owner
    // set is the lone caller uid, so the predicate is the single-value
    // `m.owner_id IN (?)` — semantically identical to the old `m.owner_id = ?`,
    // just expressed as an IN so the caller+owned-bots widening can share one
    // code path. (See paginationBind.test.ts for the bot-owned widening.)
    expect(sql).toMatch(/AND m\.owner_id IN \(\?\)/)
  })

  it('q adds an escaped CI substring title match (trimmed, wildcards literal)', async () => {
    await docMetaRepo.listForUser({ uid: 'u_1', spaceId: 's1', q: '  a_b%  ', page: 1, pageSize: 20, sort: 'updatedAt:desc' })
    const { sql, params } = itemsCall()
    expect(sql).toContain("m.title LIKE ? ESCAPE '\\\\'")
    expect(params).toContain('%a\\_b\\%%')
  })

  it('empty / whitespace-only q adds no LIKE clause (= no search)', async () => {
    await docMetaRepo.listForUser({ uid: 'u_1', spaceId: 's1', q: '   ', page: 1, pageSize: 20, sort: 'updatedAt:desc' })
    expect(itemsCall().sql).not.toContain('LIKE')
  })

  it('orders by updated_at with a doc_id tie-break and an inlined LIMIT/OFFSET', async () => {
    await docMetaRepo.listForUser({ uid: 'u_1', spaceId: 's1', page: 2, pageSize: 20, sort: 'updatedAt:desc' })
    const { sql, params } = itemsCall()
    expect(sql).toMatch(/ORDER BY m\.updated_at DESC, m\.doc_id DESC/)
    expect(sql).toMatch(/LIMIT 20 OFFSET 20/)
    expect(sql).not.toMatch(/LIMIT \?/)
    expect(params).not.toContain(20)
  })

  it('types multi-select becomes doc_type IN (?, ?) — OR between kinds, AND with q (XIN-1188)', async () => {
    await docMetaRepo.listForUser({
      uid: 'u_1', spaceId: 's1', owner: 'me', q: 'plan', types: ['doc', 'board'], page: 1, pageSize: 20, sort: 'updatedAt:desc',
    })
    const { sql, params } = itemsCall()
    expect(sql).toContain('m.doc_type IN (?, ?)')
    expect(sql).toContain("m.title LIKE ? ESCAPE '\\\\'") // AND-ed with q
    expect(params).toContain('doc')
    expect(params).toContain('board')
  })

  it('the type filter narrows the COUNT too (before pagination)', async () => {
    await docMetaRepo.listForUser({
      uid: 'u_1', spaceId: 's1', types: ['sheet'], page: 1, pageSize: 20, sort: 'updatedAt:desc',
    })
    // count query is the first of the two calls.
    const countCall = mockQuery.mock.calls[0]!
    expect(countCall[0] as string).toContain('m.doc_type IN (?)')
    expect(countCall[1] as unknown[]).toContain('sheet')
  })

  it('empty types array adds no doc_type clause (backward compatible)', async () => {
    await docMetaRepo.listForUser({ uid: 'u_1', spaceId: 's1', types: [], page: 1, pageSize: 20, sort: 'updatedAt:desc' })
    expect(itemsCall().sql).not.toContain('doc_type IN')
  })
})
