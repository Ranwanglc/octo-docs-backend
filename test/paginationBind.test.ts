import { describe, it, expect, vi, beforeEach } from 'vitest'

// Regression for the prepared-statement pagination 500: `query()` runs on
// mysql2 `.execute()`, which rejects a numeric LIMIT/OFFSET bound via `?` with
// ER_WRONG_ARGUMENTS (errno 1210). The fix inlines a validated integer instead.
// These tests capture the (sql, params) handed to the pool and assert the shape
// the bug would have violated: LIMIT/OFFSET are inlined integers, never `?`, and
// their values are absent from the params array. This is the shape assertion
// that would have caught the original bug without a live MySQL connection.
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async () => []),
  transaction: vi.fn(),
}))

import { docVersionRepo } from '../src/db/repos/docVersionRepo.js'
import { docCommentRepo } from '../src/db/repos/docCommentRepo.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { query } from '../src/db/pool.js'

const mockQuery = vi.mocked(query)

/** The (sql, params) of the last `query()` call. */
function lastCall(): { sql: string; params: unknown[] } {
  const call = mockQuery.mock.calls.at(-1)
  if (!call) throw new Error('query() was never called')
  return { sql: call[0] as string, params: (call[1] ?? []) as unknown[] }
}

beforeEach(() => {
  mockQuery.mockReset()
  mockQuery.mockResolvedValue([] as never)
})

describe('paginated repos inline a validated integer LIMIT/OFFSET (no numeric `?` bind)', () => {
  it('docVersionRepo.listByDoc inlines LIMIT and drops it from params', async () => {
    await docVersionRepo.listByDoc('d_1', { limit: 20 })
    const { sql, params } = lastCall()
    // Fetches limit+1 to detect a further page; clamp(20)+1 = 21.
    expect(sql).toMatch(/LIMIT 21\b/)
    expect(sql).not.toMatch(/LIMIT \?/)
    // Only the bind params survive (doc_id, plus kind filter by default); the
    // limit value (21) must not appear among them.
    expect(params).not.toContain(21)
    expect(params).not.toContain(20)
  })

  it('docVersionRepo.listByDoc falls back to the default integer on a fractional limit', async () => {
    await docVersionRepo.listByDoc('d_1', { limit: 20.5 } as never)
    // 20.5 is not an integer → falls back to default 20 → fetch limit+1 = 21.
    expect(lastCall().sql).toMatch(/LIMIT 21\b/)
    expect(lastCall().sql).not.toMatch(/LIMIT 21\.5/)
    expect(lastCall().sql).not.toMatch(/LIMIT \?/)
  })

  it('docCommentRepo.listRoots inlines LIMIT and clamps an untrusted value', async () => {
    await docCommentRepo.listRoots('d_1', { includeResolved: true, limit: 50 } as never)
    const { sql, params } = lastCall()
    expect(sql).toMatch(/LIMIT 50\b/)
    expect(sql).not.toMatch(/LIMIT \?/)
    expect(params).not.toContain(50)
  })

  it('docCommentRepo.listRoots clamps an out-of-range / non-integer limit to 1..100', async () => {
    await docCommentRepo.listRoots('d_1', { includeResolved: true, limit: 9999 } as never)
    expect(lastCall().sql).toMatch(/LIMIT 100\b/)

    await docCommentRepo.listRoots('d_1', { includeResolved: true, limit: 0 } as never)
    expect(lastCall().sql).toMatch(/LIMIT 1\b/)

    await docCommentRepo.listRoots('d_1', { includeResolved: true, limit: 12.5 } as never)
    expect(lastCall().sql).toMatch(/LIMIT 20\b/)
  })

  it('docMetaRepo.listForUser inlines both LIMIT and OFFSET and drops them from params', async () => {
    await docMetaRepo.listForUser({ uid: 'u_1', page: 3, pageSize: 25, sort: 'updatedAt:desc' })
    const { sql, params } = lastCall()
    expect(sql).toMatch(/LIMIT 25 OFFSET 50\b/) // offset = (page-1)*pageSize = 50
    expect(sql).not.toMatch(/LIMIT \?/)
    expect(sql).not.toMatch(/OFFSET \?/)
    expect(params).not.toContain(25)
    expect(params).not.toContain(50)
  })

  it('docMetaRepo.listForUser clamps pageSize and never emits a negative OFFSET', async () => {
    await docMetaRepo.listForUser({ uid: 'u_1', page: 1, pageSize: 9999, sort: 'updatedAt:asc' })
    expect(lastCall().sql).toMatch(/LIMIT 100 OFFSET 0\b/)
  })

  // The production 500 fired on requests that carried no limit at all, not just
  // on out-of-range values. These assert the omitted-limit path still inlines a
  // safe integer LIMIT (the default) rather than falling back to a `?` bind.
  it('docVersionRepo.listByDoc with no opts inlines the default LIMIT', async () => {
    await docVersionRepo.listByDoc('d_1')
    const { sql, params } = lastCall()
    // default limit 20 → fetch limit+1 = 21.
    expect(sql).toMatch(/LIMIT 21\b/)
    expect(sql).not.toMatch(/LIMIT \?/)
    expect(params).not.toContain(21)
    expect(params).not.toContain(20)
  })

  it('docCommentRepo.listRoots with no limit field inlines the default LIMIT', async () => {
    await docCommentRepo.listRoots('d_1', { includeResolved: true } as never)
    const { sql } = lastCall()
    expect(sql).toMatch(/LIMIT 20\b/)
    expect(sql).not.toMatch(/LIMIT \?/)
  })

  it('docMetaRepo.listForUser with pageSize omitted inlines the default LIMIT/OFFSET', async () => {
    await docMetaRepo.listForUser({ uid: 'u_1', page: 3, sort: 'updatedAt:desc' } as never)
    const { sql, params } = lastCall()
    // default pageSize 20 → offset = (3-1)*20 = 40.
    expect(sql).toMatch(/LIMIT 20 OFFSET 40\b/)
    expect(sql).not.toMatch(/LIMIT \?/)
    expect(sql).not.toMatch(/OFFSET \?/)
    expect(params).not.toContain(20)
    expect(params).not.toContain(40)
  })
})

// Regression for the spaceId/folderId arg-binding misalignment. The `base` clause
// has positional `?` in this order: JOIN `dm.uid = ?`, optional `m.space_id = ?`,
// optional `m.folder_id = ?`, then WHERE `m.owner_id = ?`. The old code built args
// as [uid, uid, spaceId?, folderId?], which bound space_id to the uid and the
// trailing owner_id to the spaceId — so a spaceId filter matched `owner_id =
// <spaceId>` and returned zero rows for the owner. These tests assert the args
// array lines up positionally with the placeholders, which fails on the old order.
describe('docMetaRepo.listForUser binds space/folder filters positionally', () => {
  it('count query: args are [joinUid, spaceId, ownerUid] when spaceId is given', async () => {
    await docMetaRepo.listForUser({
      uid: 'u_1',
      spaceId: 's_42',
      page: 1,
      pageSize: 10,
      sort: 'updatedAt:desc',
    })
    // The COUNT(*) query is the first of the two query() calls.
    const countCall = mockQuery.mock.calls[0]!
    const sql = countCall[0] as string
    const params = (countCall[1] ?? []) as unknown[]
    expect(sql).toMatch(/COUNT\(\*\)/)
    // Placeholder order in `base`: dm.uid, m.space_id, m.owner_id.
    expect(params).toEqual(['u_1', 's_42', 'u_1'])
    // The old buggy order would have been ['u_1', 'u_1', 's_42'] — owner_id bound
    // to the spaceId. Assert that specifically is gone.
    expect(params).not.toEqual(['u_1', 'u_1', 's_42'])
  })

  it('items query: args are [caseOwnerUid, joinUid, spaceId, ownerUid] when spaceId is given', async () => {
    await docMetaRepo.listForUser({
      uid: 'u_1',
      spaceId: 's_42',
      page: 1,
      pageSize: 10,
      sort: 'updatedAt:desc',
    })
    // The items SELECT is the last query() call. Its placeholder order is:
    // CASE m.owner_id=?, JOIN dm.uid=?, m.space_id=?, WHERE m.owner_id=?.
    const { params } = lastCall()
    expect(params).toEqual(['u_1', 'u_1', 's_42', 'u_1'])
  })

  it('orders space then folder, with join uid first and owner uid last', async () => {
    await docMetaRepo.listForUser({
      uid: 'owner_x',
      spaceId: 'space_y',
      folderId: 'folder_z',
      page: 1,
      pageSize: 10,
      sort: 'updatedAt:desc',
    })
    const countCall = mockQuery.mock.calls[0]!
    const params = (countCall[1] ?? []) as unknown[]
    // JOIN dm.uid, m.space_id, m.folder_id, WHERE m.owner_id.
    expect(params).toEqual(['owner_x', 'space_y', 'folder_z', 'owner_x'])
  })

  // Behavioural framing of the same fix: with the misaligned binding, the row's
  // own space_id was compared against the caller's uid and the owner_id against
  // the spaceId, so an owner querying their own space matched nothing. Here we
  // assert the WHERE binds owner_id to the uid (match) and space_id to the
  // requested space — the only way "owner + correct space" can return the row,
  // and the only way a wrong space can return empty.
  it('binds owner_id to the uid and space_id to the requested space (owner+space match)', async () => {
    await docMetaRepo.listForUser({
      uid: 'u_owner',
      spaceId: 's_correct',
      page: 1,
      pageSize: 10,
      sort: 'updatedAt:desc',
    })
    const countParams = (mockQuery.mock.calls[0]![1] ?? []) as unknown[]
    // space_id placeholder (index 1) must carry the space, not the uid…
    expect(countParams[1]).toBe('s_correct')
    // …and the trailing owner_id placeholder (last) must carry the uid, not the space.
    expect(countParams.at(-1)).toBe('u_owner')
  })
})

// FEAT: owner=me ("my documents") now also returns docs owned by bots the
// caller owns. The visibility predicate goes from a single `m.owner_id = ?` to
// `m.owner_id IN (?, ...)` bound with [uid, ...ownedBots] (deduped, empties
// stripped). These assert (a) the bot-owned docs enter the owner set, (b) an
// empty/absent ownedBots degrades to the exact single-value pre-feature
// behavior, and (c) placeholder count === bind count so mysql2 execute never
// throws errno 1210. The default view (no owner=me) is untouched and its
// positional binding is still covered by the block above.
describe('docMetaRepo.listForUser owner=me spans caller + owned bots', () => {
  /** Count params (first query()) and items params (last query()). */
  function ownerCall() {
    const count = mockQuery.mock.calls[0]!
    return {
      countSql: count[0] as string,
      countParams: (count[1] ?? []) as unknown[],
      itemsSql: lastCall().sql,
      itemsParams: lastCall().params,
    }
  }

  it('includes bot-owned docs: owner set is IN (uid, ...ownedBots) in placeholder order', async () => {
    await docMetaRepo.listForUser({
      uid: 'u_human',
      spaceId: 's_1',
      owner: 'me',
      ownedBots: ['bot_a', 'bot_b'],
      page: 1,
      pageSize: 10,
      sort: 'updatedAt:desc',
    })
    const { countSql, countParams, itemsSql, itemsParams } = ownerCall()
    // Visibility widened to an IN over the caller + their bots (3 placeholders).
    expect(countSql).toMatch(/m\.owner_id IN \(\?, \?, \?\)/)
    // Shared-with-me is still excluded (no OR dm.role IN (1, 2, 3, 4) on owner=me).
    expect(countSql).not.toMatch(/dm\.uid IS NOT NULL/)
    // COUNT bind order: JOIN dm.uid, m.space_id, then the owner set.
    expect(countParams).toEqual(['u_human', 's_1', 'u_human', 'bot_a', 'bot_b'])
    // fail-before: the pre-feature code bound a single trailing uid here, so the
    // bot uids were absent and bot-owned docs could never match.
    expect(countParams).toContain('bot_a')
    expect(countParams).toContain('bot_b')
    // Role projection uses the same owner set, so bot-owned rows are admin even
    // when no doc_member row exists for the human.
    expect(itemsParams).toEqual(['u_human', 'bot_a', 'bot_b', 'u_human', 's_1', 'u_human', 'bot_a', 'bot_b'])
    expect(itemsSql).toMatch(/CASE WHEN m\.owner_id IN \(\?, \?, \?\) THEN 3/)
  })

  it('empty ownedBots degrades to exactly the pre-feature single-owner behavior', async () => {
    await docMetaRepo.listForUser({
      uid: 'u_human',
      spaceId: 's_1',
      owner: 'me',
      ownedBots: [],
      page: 1,
      pageSize: 10,
      sort: 'updatedAt:desc',
    })
    const { countSql, countParams, itemsParams } = ownerCall()
    // Single-value IN is equivalent to the old `m.owner_id = ?` (one placeholder,
    // one bind) — backward compatible, still owner-only (no shared-with-me).
    expect(countSql).toMatch(/m\.owner_id IN \(\?\)/)
    expect(countSql).not.toMatch(/dm\.uid IS NOT NULL/)
    expect(countParams).toEqual(['u_human', 's_1', 'u_human'])
    expect(itemsParams).toEqual(['u_human', 'u_human', 's_1', 'u_human'])
  })

  it('absent ownedBots (field omitted) also degrades to single-owner behavior', async () => {
    await docMetaRepo.listForUser({
      uid: 'u_human',
      spaceId: 's_1',
      owner: 'me',
      page: 1,
      pageSize: 10,
      sort: 'updatedAt:desc',
    } as never)
    const { countSql, countParams } = ownerCall()
    expect(countSql).toMatch(/m\.owner_id IN \(\?\)/)
    expect(countParams).toEqual(['u_human', 's_1', 'u_human'])
  })

  it('dedupes and strips empties so placeholder count === bind count (no errno 1210)', async () => {
    await docMetaRepo.listForUser({
      uid: 'u_human',
      spaceId: 's_1',
      owner: 'me',
      // duplicate of self, a repeated bot, and empty strings must all collapse.
      ownedBots: ['u_human', 'bot_a', 'bot_a', '', 'bot_c'],
      page: 1,
      pageSize: 10,
      sort: 'updatedAt:desc',
    })
    const { countSql, countParams, itemsParams } = ownerCall()
    // owner set collapses to [u_human, bot_a, bot_c] => 3 placeholders.
    const countPlaceholders = (countSql.match(/m\.owner_id IN \(([^)]*)\)/)![1].match(/\?/g) || [])
      .length
    // count query trailing binds after [joinUid, spaceId] are the owner set.
    expect(countParams.slice(2).length).toBe(countPlaceholders)
    expect(countParams).toEqual(['u_human', 's_1', 'u_human', 'bot_a', 'bot_c'])
    // items query: leading CASE owner-set binds + [joinUid, spaceId] + owner set.
    expect(itemsParams).toEqual(['u_human', 'bot_a', 'bot_c', 'u_human', 's_1', 'u_human', 'bot_a', 'bot_c'])
  })

  it('folder + q + owner=me: bind count still matches across every placeholder', async () => {
    await docMetaRepo.listForUser({
      uid: 'u_human',
      spaceId: 's_1',
      folderId: 'f_9',
      owner: 'me',
      ownedBots: ['bot_a'],
      q: 'report',
      page: 1,
      pageSize: 10,
      sort: 'updatedAt:desc',
    })
    const { countSql, countParams } = ownerCall()
    // Total `?` in the WHERE/base (JOIN + space + folder + q-LIKE + owner IN)
    // must equal the number of bind params (mysql2 execute contract).
    const totalPlaceholders = (countSql.match(/\?/g) || []).length
    expect(countParams.length).toBe(totalPlaceholders)
    // Positional order: JOIN dm.uid, space, folder, q, then owner set.
    expect(countParams).toEqual(['u_human', 's_1', 'f_9', '%report%', 'u_human', 'bot_a'])
  })
})

describe('docMetaRepo html registration slug SQL', () => {
  const htmlRow = {
    doc_id: 'd_html',
    document_name: 'octo:s_1:f_default:html:d_html',
    title: 'HTML',
    owner_id: 'bot_1',
    space_id: 's_1',
    folder_id: 'f_default',
    doc_type: 'html',
    octo_doc_slug: 'html-slug-1',
    status: 1,
    permission_epoch: 0,
    created_at: new Date(0),
    updated_at: new Date(0),
    created_by: 'bot_1',
    updated_by: '',
  }

  it('create writes octo_doc_slug into doc_meta', async () => {
    await docMetaRepo.create({
      docId: 'd_html',
      documentName: 'octo:s_1:f_default:html:d_html',
      title: 'HTML',
      ownerId: 'bot_1',
      spaceId: 's_1',
      folderId: 'f_default',
      docType: 'html',
      octoDocSlug: 'html-slug-1',
      createdBy: 'bot_1',
    })

    const { sql, params } = lastCall()
    expect(sql).toMatch(/octo_doc_slug/)
    expect(params).toContain('html-slug-1')
  })

  it('create writes NULL octo_doc_slug for multiple non-html docs', async () => {
    await docMetaRepo.create({
      docId: 'd_doc_1',
      documentName: 'octo:s_1:f_default:doc:d_doc_1',
      title: 'Doc 1',
      ownerId: 'u_1',
      spaceId: 's_1',
      folderId: 'f_default',
      docType: 'doc',
      createdBy: 'u_1',
    })
    await docMetaRepo.create({
      docId: 'd_board_1',
      documentName: 'octo:s_1:f_default:wb:d_board_1',
      title: 'Board 1',
      ownerId: 'u_1',
      spaceId: 's_1',
      folderId: 'f_default',
      docType: 'whiteboard',
      octoDocSlug: 'ignored-for-non-html',
      createdBy: 'u_1',
    })

    const firstParams = mockQuery.mock.calls.at(-2)?.[1] as unknown[]
    const secondParams = mockQuery.mock.calls.at(-1)?.[1] as unknown[]
    expect(firstParams[7]).toBeNull()
    expect(secondParams[7]).toBeNull()
  })

  it('finds html metadata by octo_doc_slug scoped to the space (P0)', async () => {
    mockQuery.mockResolvedValueOnce([htmlRow] as never)

    const out = await docMetaRepo.getByOctoDocSlug('html-slug-1', 's_1')

    expect(out).toEqual(htmlRow)
    const { sql, params } = lastCall()
    expect(sql).toMatch(/octo_doc_slug = \?/)
    expect(sql).toMatch(/doc_type = 'html'/)
    // P0: the lookup is space-scoped so it can never resolve another space's row.
    expect(sql).toMatch(/space_id = \?/)
    expect(sql).not.toMatch(/octo_doc_slug <> ''/)
    expect(params).toEqual(['html-slug-1', 's_1'])
  })

  it('upserts an existing html slug by updating title and updated_by (space-scoped)', async () => {
    mockQuery
      .mockResolvedValueOnce([htmlRow] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ ...htmlRow, title: 'HTML 2', updated_by: 'bot_1' }] as never)

    const out = await docMetaRepo.upsertHtmlByOctoDocSlug({
      docId: 'd_new',
      documentName: 'octo:s_1:f_default:html:d_new',
      title: 'HTML 2',
      ownerId: 'bot_1',
      spaceId: 's_1',
      folderId: 'f_default',
      docType: 'html',
      octoDocSlug: 'html-slug-1',
      createdBy: 'bot_1',
    })

    expect(out.created).toBe(false)
    expect(out.meta.doc_id).toBe('d_html')
    // The existence lookup is space-scoped: (slug, spaceId).
    const selectCall = mockQuery.mock.calls.find((call) => /octo_doc_slug = \?/i.test(call[0] as string))
    expect(selectCall?.[1]).toEqual(['html-slug-1', 's_1'])
    const updateCall = mockQuery.mock.calls.find((call) => /^UPDATE doc_meta/i.test(call[0] as string))
    expect(updateCall?.[0]).toMatch(/updated_by = \?/)
    expect(updateCall?.[0]).toMatch(/doc_type = 'html'/)
    // P0 defense-in-depth: the UPDATE is also pinned to the caller's space.
    expect(updateCall?.[0]).toMatch(/space_id = \?/)
    expect(updateCall?.[1]).toEqual(['HTML 2', 'bot_1', 'd_html', 's_1'])
  })

  it('never resolves a same-slug row from another space (cross-tenant read block, P0)', async () => {
    // The repo hands (slug, spaceId) to the SQL; the WHERE space_id=? is what
    // makes a foreign-space row return nothing. Simulate "no row in this space".
    mockQuery.mockResolvedValueOnce([] as never)

    const out = await docMetaRepo.getByOctoDocSlug('html-slug-1', 's_B')

    expect(out).toBeNull()
    const { sql, params } = lastCall()
    expect(sql).toMatch(/space_id = \?/)
    // space_id bind is the caller's space, never a slug-derived global value.
    expect(params).toEqual(['html-slug-1', 's_B'])
  })

  it('recovers from a concurrent-insert dup-key by re-fetching and updating (TOCTOU, idempotent, no 500)', async () => {
    // Both racers miss the initial SELECT; this racer loses the INSERT with
    // ER_DUP_ENTRY, then re-fetches the winner's row and UPDATEs it — created:false,
    // no throw. Sequence: SELECT(miss) -> INSERT(dup) -> SELECT(hit) -> UPDATE -> getByDocId.
    const dupErr = Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY', errno: 1062 })
    mockQuery
      .mockResolvedValueOnce([] as never) // getByOctoDocSlug: initial miss
      .mockRejectedValueOnce(dupErr as never) // create INSERT: dup-key
      .mockResolvedValueOnce([htmlRow] as never) // re-fetch getByOctoDocSlug: winner's row
      .mockResolvedValueOnce([] as never) // UPDATE
      .mockResolvedValueOnce([{ ...htmlRow, title: 'HTML raced' }] as never) // getByDocId

    const out = await docMetaRepo.upsertHtmlByOctoDocSlug({
      docId: 'd_loser',
      documentName: 'octo:s_1:f_default:html:d_loser',
      title: 'HTML raced',
      ownerId: 'bot_1',
      spaceId: 's_1',
      folderId: 'f_default',
      docType: 'html',
      octoDocSlug: 'html-slug-1',
      createdBy: 'bot_1',
    })

    expect(out.created).toBe(false)
    expect(out.meta.doc_id).toBe('d_html')
    const updateCall = mockQuery.mock.calls.find((call) => /^UPDATE doc_meta/i.test(call[0] as string))
    expect(updateCall?.[1]).toEqual(['HTML raced', 'bot_1', 'd_html', 's_1'])
  })
})
