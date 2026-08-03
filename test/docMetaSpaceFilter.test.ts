import { describe, it, expect, vi, beforeEach } from 'vitest'

// Strict by-space isolation (P1) at the repo layer: docMetaRepo.listForUser must
// ALWAYS constrain the query by space (`m.space_id = ?` bound to the caller's
// space). Previously the space clause was conditional; this test locks in the
// unconditional filter so a listing can never leak docs from another space.
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async () => []),
  transaction: vi.fn(),
}))

import { docMetaRepo, DocOwnershipError } from '../src/db/repos/docMetaRepo.js'
import { query } from '../src/db/pool.js'

const mockQuery = vi.mocked(query)

beforeEach(() => {
  mockQuery.mockReset()
  mockQuery.mockResolvedValue([] as never)
})

describe('docMetaRepo.listForUser always filters by space (P1 isolation)', () => {
  it('emits an unconditional m.space_id = ? clause bound to the requested space', async () => {
    await docMetaRepo.listForUser({
      uid: 'u_1',
      spaceId: 's_scope',
      page: 1,
      pageSize: 10,
      sort: 'updatedAt:desc',
    })
    // Both the COUNT and the items SELECT carry the space clause.
    for (const call of mockQuery.mock.calls) {
      const sql = call[0] as string
      const params = (call[1] ?? []) as unknown[]
      expect(sql).toMatch(/m\.space_id = \?/)
      expect(params).toContain('s_scope')
    }
  })

  it('keeps folder optional — no folder clause when folderId is omitted', async () => {
    await docMetaRepo.listForUser({
      uid: 'u_1',
      spaceId: 's_scope',
      page: 1,
      pageSize: 10,
      sort: 'updatedAt:desc',
    })
    const countSql = mockQuery.mock.calls[0]![0] as string
    expect(countSql).not.toMatch(/m\.folder_id = \?/)
  })

  it('binds space then folder positionally when a folder is also given', async () => {
    await docMetaRepo.listForUser({
      uid: 'u_1',
      spaceId: 's_scope',
      folderId: 'f_1',
      page: 1,
      pageSize: 10,
      sort: 'updatedAt:desc',
    })
    // COUNT placeholder order: JOIN dm.uid, m.space_id, m.folder_id, WHERE m.owner_id.
    const countParams = (mockQuery.mock.calls[0]![1] ?? []) as unknown[]
    expect(countParams).toEqual(['u_1', 's_scope', 'f_1', 'u_1'])
  })

  it('CROSS-SPACE ISOLATION: the #64 space-share branch never escapes the space scope (member)', async () => {
    // For a CONFIRMED space member the shared-with-me list surfaces anyone_in_space
    // docs (share_scope = 1), but ONLY within the caller's space: the unconditional
    // `m.space_id = ?` filter (bound to the requested space) applies to EVERY row,
    // share-visible ones included. So a doc shared as anyone_in_space in ANOTHER
    // space is never in the result set. The share branch also adds no positional
    // bind, so paging stays stable (verified by the bind-order test above).
    await docMetaRepo.listForUser({
      uid: 'u_1', spaceId: 's_trident', isSpaceMember: true, page: 1, pageSize: 10, sort: 'updatedAt:desc',
    })
    for (const call of mockQuery.mock.calls) {
      const sql = call[0] as string
      const params = (call[1] ?? []) as unknown[]
      // space filter still unconditional AND-ed for every query.
      expect(sql).toMatch(/m\.space_id = \? AND/)
      expect(params).toContain('s_trident')
      // the share source is present but sits INSIDE the visibility OR, downstream
      // of the AND-ed space filter — it can only ever match docs already in-space.
      expect(sql).toContain('OR m.share_scope = 1')
    }
  })

  it('CROSS-SPACE GATE: a NON-member never gets the space-share branch, so no share-only doc leaks (XIN-1295)', async () => {
    // req.spaceId is an UNVERIFIED header — being able to name a space does not make
    // the caller a member. Symmetric with the write side (resolveEffectiveRole ->
    // isSpaceMember): a non-member must not read another space's anyone_in_space doc
    // metadata. When membership is not confirmed, the share branch is dropped and
    // the bind array is byte-identical to the member case (share adds no bind).
    await docMetaRepo.listForUser({
      uid: 'u_1', spaceId: 's_trident', isSpaceMember: false, page: 1, pageSize: 10, sort: 'updatedAt:desc',
    })
    for (const call of mockQuery.mock.calls) {
      const sql = call[0] as string
      const params = (call[1] ?? []) as unknown[]
      expect(sql).toMatch(/m\.space_id = \? AND/)
      expect(params).toContain('s_trident')
      // NO share branch: the visibility predicate is owner OR doc_member only.
      expect(sql).not.toContain('share_scope')
      expect(sql).toContain('(m.owner_id = ? OR dm.role IN (1, 2, 3, 4))')
    }
    // paging binds unchanged vs the member case (share branch carries no bind).
    expect((mockQuery.mock.calls[0]![1] ?? []) as unknown[]).toEqual(['u_1', 's_trident', 'u_1'])
  })
})

// Broken-object-level-authorization regression (PR #93, P0). Within one space a
// slug is unique, so bot B POSTing a slug bot A already registered resolves A's
// row. Before the fix upsertHtmlByOctoDocSlug UPDATEd that row keyed only on
// doc_id+doc_type+space_id — overwriting A's title, restamping updated_by=B, and
// reviving a soft-deleted row — with NO ownership check (fail-open). The owner
// gate must reject the non-owner (403) without mutating the row, while the owner
// re-registering their own slug still converges idempotently.
describe('docMetaRepo.upsertHtmlByOctoDocSlug enforces owner authz (P0)', () => {
  const existingRow = {
    doc_id: 'd_A',
    document_name: 'octo:s_1:f_default:html:d_A',
    title: 'A title',
    owner_id: 'bot_A',
    space_id: 's_1',
    folder_id: 'f_default',
    doc_type: 'html',
    octo_doc_slug: 'shared-slug',
    status: 0, // soft-deleted: pre-fix this got revived to 1 by a non-owner
    permission_epoch: 0,
    share_scope: 0,
    share_role: 1,
    created_at: new Date(0),
    updated_at: new Date(0),
    created_by: 'bot_A',
    updated_by: '',
  }

  // Route every SELECT of the slug to A's existing row; fail loudly if any
  // UPDATE is attempted so the "row not mutated" assertion is airtight.
  function routeQuery(row: typeof existingRow) {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/^\s*SELECT \* FROM doc_meta\s+WHERE octo_doc_slug/i.test(sql)) return [row] as never
      if (/^\s*SELECT \* FROM doc_meta WHERE doc_id/i.test(sql)) return [{ ...row, status: 1 }] as never
      return [] as never
    })
  }

  const input = (createdBy: string, spaceId = 's_1') => ({
    docId: 'd_new',
    documentName: 'octo:s_1:f_default:html:d_new',
    title: 'B overwrite',
    ownerId: createdBy,
    spaceId,
    folderId: 'f_default',
    docType: 'html',
    octoDocSlug: 'shared-slug',
    createdBy,
  })

  it('rejects a non-owner (owner_id mismatch) with DocOwnershipError and NO UPDATE', async () => {
    routeQuery(existingRow)
    await expect(docMetaRepo.upsertHtmlByOctoDocSlug(input('bot_B'))).rejects.toBeInstanceOf(
      DocOwnershipError,
    )
    // Pre-fix this UPDATE fired and revived/overwrote A's row. Post-fix: none.
    const updates = mockQuery.mock.calls.filter((c) => /^\s*UPDATE doc_meta/i.test(c[0] as string))
    expect(updates).toHaveLength(0)
  })

  it('lets the OWNING bot re-register its own slug idempotently (UPDATE, no throw)', async () => {
    routeQuery(existingRow)
    const res = await docMetaRepo.upsertHtmlByOctoDocSlug(input('bot_A'))
    expect(res.created).toBe(false)
    // Owner revival is allowed: exactly one UPDATE targeting A's doc_id, stamping
    // the owner as updated_by and setting status=1.
    const updates = mockQuery.mock.calls.filter((c) => /^\s*UPDATE doc_meta/i.test(c[0] as string))
    expect(updates).toHaveLength(1)
    expect((updates[0]![1] ?? []) as unknown[]).toEqual(['B overwrite', 'bot_A', 'd_A', 's_1'])
  })
})

// TOCTOU dup-entry recovery (PR #93, reviewer OctoBoooot [major]). The upsert is
// check-then-act: getByOctoDocSlug (miss) -> create(). Two concurrent same-slug
// registrations both miss the SELECT and race on INSERT; the loser hits the
// composite UNIQUE KEY uk_octo_doc_slug and mysql2 throws ER_DUP_ENTRY / errno
// 1062. Without recovery that surfaces as a 500. The fix catches the dup, re-
// fetches the now-committed racing winner, and converges idempotently through
// the SAME owner-authz gate as the check-then-act path — so a non-owner loser is
// still rejected (403) and a non-dup error is never swallowed.
describe('docMetaRepo.upsertHtmlByOctoDocSlug recovers from TOCTOU dup-entry (major)', () => {
  const racedRow = {
    doc_id: 'd_win',
    document_name: 'octo:s_1:f_default:html:d_win',
    title: 'winner title',
    owner_id: 'bot_A',
    space_id: 's_1',
    folder_id: 'f_default',
    doc_type: 'html',
    octo_doc_slug: 'shared-slug',
    status: 1,
    permission_epoch: 0,
    share_scope: 0,
    share_role: 1,
    created_at: new Date(0),
    updated_at: new Date(0),
    created_by: 'bot_A',
    updated_by: '',
  }

  // Route the shared mockQuery per-call to simulate the race:
  //  1st slug SELECT  -> [] (both racers miss)
  //  INSERT           -> reject with `insertErr` (the dup, or a non-dup error)
  //  2nd slug SELECT  -> [winner] (re-fetch resolves the committed row)
  //  doc_id SELECT    -> [winner status=1] (final read after UPDATE)
  // A monotonic counter distinguishes the two identical slug SELECTs.
  function routeRace(winner: typeof racedRow, insertErr: unknown) {
    let slugSelects = 0
    mockQuery.mockImplementation(async (sql: string) => {
      if (/^\s*SELECT \* FROM doc_meta\s+WHERE octo_doc_slug/i.test(sql)) {
        slugSelects += 1
        return (slugSelects === 1 ? [] : [winner]) as never
      }
      if (/^\s*INSERT INTO doc_meta/i.test(sql)) throw insertErr
      if (/^\s*SELECT \* FROM doc_meta WHERE doc_id/i.test(sql)) return [winner] as never
      return [] as never
    })
  }

  const input = (createdBy: string, spaceId = 's_1') => ({
    docId: 'd_new',
    documentName: 'octo:s_1:f_default:html:d_new',
    title: 'B overwrite',
    ownerId: createdBy,
    spaceId,
    folderId: 'f_default',
    docType: 'html',
    octoDocSlug: 'shared-slug',
    createdBy,
  })

  it('(a) same-owner racer: dup on INSERT -> re-fetch -> idempotent UPDATE, {created:false}', async () => {
    routeRace(racedRow, { code: 'ER_DUP_ENTRY', errno: 1062 })
    const res = await docMetaRepo.upsertHtmlByOctoDocSlug(input('bot_A'))
    expect(res.created).toBe(false)
    // The loser must NOT surface the failed INSERT as a 500: exactly one INSERT
    // (which rejected) and then a recovery UPDATE targeting the winner's doc_id.
    const inserts = mockQuery.mock.calls.filter((c) => /^\s*INSERT INTO doc_meta/i.test(c[0] as string))
    expect(inserts).toHaveLength(1)
    const updates = mockQuery.mock.calls.filter((c) => /^\s*UPDATE doc_meta/i.test(c[0] as string))
    expect(updates).toHaveLength(1)
    expect((updates[0]![1] ?? []) as unknown[]).toEqual(['B overwrite', 'bot_A', 'd_win', 's_1'])
  })

  it('(b) non-owner racer: dup on INSERT -> re-fetch resolves ANOTHER bot -> DocOwnershipError, NO UPDATE', async () => {
    routeRace(racedRow, { code: 'ER_DUP_ENTRY', errno: 1062 })
    // Winner is bot_A; the losing racer is bot_B -> re-authorization must reject.
    await expect(docMetaRepo.upsertHtmlByOctoDocSlug(input('bot_B'))).rejects.toBeInstanceOf(
      DocOwnershipError,
    )
    // Recovery must NOT overwrite/revive the winner's row for a non-owner.
    const updates = mockQuery.mock.calls.filter((c) => /^\s*UPDATE doc_meta/i.test(c[0] as string))
    expect(updates).toHaveLength(0)
  })

  it('(c) non-dup INSERT error propagates unchanged (not swallowed by the dup catch)', async () => {
    const otherErr = Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK', errno: 9999 })
    routeRace(racedRow, otherErr)
    await expect(docMetaRepo.upsertHtmlByOctoDocSlug(input('bot_A'))).rejects.toBe(otherErr)
    // A non-dup failure must not trigger the re-fetch/UPDATE recovery at all.
    const updates = mockQuery.mock.calls.filter((c) => /^\s*UPDATE doc_meta/i.test(c[0] as string))
    expect(updates).toHaveLength(0)
  })
})
