import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test for docViewHistoryRepo: the REAL repo methods run against a
// mocked pool (query + transaction), so we assert the exact (sql, params) shape
// — idempotent UPSERT, synchronous retention prune (count per (uid, space_id),
// age per uid), the query-time permission/status filter, keyset-cursor paging,
// and the cursor codec — with no live MySQL (mirrors docVersionPrune.test.ts).
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async () => []),
  transaction: vi.fn(),
}))

import {
  docViewHistoryRepo,
  encodeViewCursor,
  decodeViewCursor,
} from '../src/db/repos/docViewHistoryRepo.js'
import { query, transaction } from '../src/db/pool.js'

const mockQuery = vi.mocked(query)

interface Call {
  sql: string
  params: unknown[]
}

/** Wire `transaction` to a tx that records every query; the final SELECT
 *  viewed_at resolves to a fixed timestamp. */
function mockTx(viewedAt = new Date('2026-07-15T06:20:48.123Z')): Call[] {
  const calls: Call[] = []
  vi.mocked(transaction).mockImplementation(async (fn: never) => {
    const tx = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params })
        if (sql.includes('SELECT viewed_at')) return [{ viewed_at: viewedAt }]
        return []
      }),
    }
    return (fn as unknown as (t: typeof tx) => Promise<unknown>)(tx)
  })
  return calls
}

beforeEach(() => {
  vi.mocked(transaction).mockReset()
  mockQuery.mockReset()
  mockQuery.mockResolvedValue([] as never)
})

describe('docViewHistoryRepo.upsertViewWithPrune — idempotent UPSERT + prune', () => {
  it('UPSERTs on (uid, doc_id, space_id): a same-space re-open refreshes viewed_at, never inserts a new row', async () => {
    const calls = mockTx()
    await docViewHistoryRepo.upsertViewWithPrune({
      uid: 'u_1', docId: 'd_1', spaceId: 's1', retainCount: 200, retainDays: 90,
    })
    const insert = calls.find((c) => c.sql.includes('INSERT INTO doc_view_history'))
    expect(insert).toBeDefined()
    // idempotency is the ON DUPLICATE KEY UPDATE arm refreshing viewed_at ONLY.
    // space_id is part of the PK now (P1-b), so it is never overwritten — a
    // different space is a distinct row, not a rewrite of the same one.
    expect(insert!.sql).toContain('ON DUPLICATE KEY UPDATE')
    expect(insert!.sql).toMatch(/viewed_at\s*=\s*VALUES\(viewed_at\)/)
    expect(insert!.sql).not.toMatch(/space_id\s*=\s*VALUES\(space_id\)/)
    expect(insert!.params).toEqual(['u_1', 'd_1', 's1'])
  })

  it('returns the post-write viewed_at read back inside the same transaction', async () => {
    mockTx(new Date('2026-07-15T06:20:48.123Z'))
    const out = await docViewHistoryRepo.upsertViewWithPrune({
      uid: 'u_1', docId: 'd_1', spaceId: 's1', retainCount: 200, retainDays: 90,
    })
    expect(out.toISOString()).toBe('2026-07-15T06:20:48.123Z')
  })

  it('count prune (retainCount=3) keeps the most-recent 3 via an inlined LIMIT, keyed by (uid, space_id)', async () => {
    const calls = mockTx()
    await docViewHistoryRepo.upsertViewWithPrune({
      uid: 'u_1', docId: 'd_1', spaceId: 's1', retainCount: 3, retainDays: 0,
    })
    const del = calls.find((c) => c.sql.includes('DELETE') && c.sql.includes('NOT IN'))
    expect(del).toBeDefined()
    expect(del!.sql).toMatch(/LIMIT 3\b/)
    expect(del!.sql).not.toMatch(/LIMIT \?/)
    expect(del!.sql).toMatch(/ORDER BY viewed_at DESC, doc_id DESC/)
    // per-space retention (P1-b): both the DELETE scope and the keep-set subquery
    // are pinned to this (uid, space_id), so activity in one space never prunes
    // another space's rows.
    expect(del!.sql).toMatch(/space_id = \?/)
    expect(del!.params).toEqual(['u_1', 's1', 'u_1', 's1'])
    // 3 must not leak into params (inlined, not bound).
    expect(del!.params).not.toContain(3)
  })

  it('age prune (retainDays=1) drops rows older than an inlined INTERVAL, keyed by uid', async () => {
    const calls = mockTx()
    await docViewHistoryRepo.upsertViewWithPrune({
      uid: 'u_1', docId: 'd_1', spaceId: 's1', retainCount: 0, retainDays: 1,
    })
    const del = calls.find((c) => c.sql.includes('DELETE') && c.sql.includes('INTERVAL'))
    expect(del).toBeDefined()
    expect(del!.sql).toMatch(/INTERVAL 1 DAY/)
    expect(del!.sql).not.toMatch(/INTERVAL \? DAY/)
    expect(del!.params).toEqual(['u_1'])
  })

  it('skips the count pass when retainCount=0 and the age pass when retainDays=0 (0 = unbounded)', async () => {
    const calls = mockTx()
    await docViewHistoryRepo.upsertViewWithPrune({
      uid: 'u_1', docId: 'd_1', spaceId: 's1', retainCount: 0, retainDays: 0,
    })
    expect(calls.some((c) => c.sql.includes('DELETE'))).toBe(false)
  })

  it('clamps a fractional / negative retainCount to a safe non-negative integer', async () => {
    const calls = mockTx()
    await docViewHistoryRepo.upsertViewWithPrune({
      uid: 'u_1', docId: 'd_1', spaceId: 's1', retainCount: 3.9, retainDays: -5,
    })
    const del = calls.find((c) => c.sql.includes('NOT IN'))
    expect(del!.sql).toMatch(/LIMIT 3\b/) // floor(3.9)=3
    // retainDays=-5 clamps to 0 => no age pass.
    expect(calls.some((c) => c.sql.includes('INTERVAL'))).toBe(false)
  })
})

describe('docViewHistoryRepo — P1-b per-space recent (triple key, no flip-flop) [XIN-1297]', () => {
  it('the same doc opened from two spaces writes one row PER space, each preserving its own space_id', async () => {
    // Root cause of the flip-flop: the old (uid, doc_id) PK meant a re-open in a
    // different space overwrote the single row's space_id, so the doc dropped out
    // of the first space's recent list. With PK (uid, doc_id, space_id) each open
    // is a distinct row keyed by space, and the UPSERT refreshes viewed_at only —
    // it never rewrites space_id — so the doc stays "recent" in BOTH spaces.
    const callsA = mockTx()
    await docViewHistoryRepo.upsertViewWithPrune({
      uid: 'u_1', docId: 'd_shared', spaceId: 's_A', retainCount: 200, retainDays: 90,
    })
    const insertA = callsA.find((c) => c.sql.includes('INSERT INTO doc_view_history'))!
    expect(insertA.params).toEqual(['u_1', 'd_shared', 's_A'])

    const callsB = mockTx()
    await docViewHistoryRepo.upsertViewWithPrune({
      uid: 'u_1', docId: 'd_shared', spaceId: 's_B', retainCount: 200, retainDays: 90,
    })
    const insertB = callsB.find((c) => c.sql.includes('INSERT INTO doc_view_history'))!
    // Same (uid, doc) but a DIFFERENT space_id — a separate row, not a rewrite.
    expect(insertB.params).toEqual(['u_1', 'd_shared', 's_B'])
    // The UPSERT clause must not touch space_id (it is part of the PK), so the
    // s_A row can never be flipped to s_B (or vice-versa) by an open in the other.
    expect(insertB.sql).not.toMatch(/space_id\s*=\s*VALUES\(space_id\)/)
  })

  it('count prune stays within the written space, so a busy space cannot evict another space recent rows', async () => {
    const calls = mockTx()
    await docViewHistoryRepo.upsertViewWithPrune({
      uid: 'u_1', docId: 'd_shared', spaceId: 's_A', retainCount: 3, retainDays: 0,
    })
    const del = calls.find((c) => c.sql.includes('DELETE') && c.sql.includes('NOT IN'))!
    // The prune only ever deletes rows in the space just written (s_A). Rows in
    // s_B are out of scope, so per-space recent lists are retained independently.
    expect(del.sql).toMatch(/WHERE uid = \? AND space_id = \?/)
    expect(del.params).toEqual(['u_1', 's_A', 'u_1', 's_A'])
  })
})

describe('docViewHistoryRepo.listRecent — query-time filter + keyset paging', () => {
  it('filters at query time on status=1 + the owner/member/space-share visibility predicate (member)', async () => {
    mockQuery.mockResolvedValueOnce([{ cnt: 0 }] as never) // count
    mockQuery.mockResolvedValueOnce([] as never) // items
    await docViewHistoryRepo.listRecent({ uid: 'u_1', spaceId: 's1', isSpaceMember: true, pageSize: 20 })
    const itemsSql = mockQuery.mock.calls.at(-1)![0] as string
    // this — NOT pruning — is what makes revoked/deleted/archived docs vanish.
    expect(itemsSql).toContain('m.status = 1')
    // Write/read symmetry (#64): for a CONFIRMED member the read predicate also
    // recognizes the space-scoped share source, so an anyone_in_space doc a member
    // opened (written by POST /view's effectiveRole guard) is no longer dropped.
    expect(itemsSql).toContain(
      '(m.owner_id = ? OR dm.role IN (1, 2, 3, 4) OR (m.share_scope = 1 AND m.space_id = v.space_id))',
    )
    expect(itemsSql).toMatch(/ORDER BY v\.viewed_at DESC, v\.doc_id DESC/)
  })

  it('selects the last-editor uid (m.updated_by) alongside the existing doc_meta columns (XIN-1240)', async () => {
    mockQuery.mockResolvedValueOnce([{ cnt: 0 }] as never) // count
    mockQuery.mockResolvedValueOnce([] as never) // items
    await docViewHistoryRepo.listRecent({ uid: 'u_1', spaceId: 's1', pageSize: 20 })
    const itemsSql = mockQuery.mock.calls.at(-1)![0] as string
    // additive: updated_by joins the existing SELECT list, next to updated_at.
    expect(itemsSql).toContain('m.updated_by')
    expect(itemsSql).toContain('m.updated_at') // existing column not dropped
    // the COUNT query is unaffected (no per-row column in the aggregate).
    const countSql = mockQuery.mock.calls[0]![0] as string
    expect(countSql).toContain('COUNT(*)')
  })

  it('CROSS-SPACE ISOLATION: the share branch is same-space-guarded and never leaks another space (member)', async () => {
    mockQuery.mockResolvedValueOnce([{ cnt: 0 }] as never) // count
    mockQuery.mockResolvedValueOnce([] as never) // items
    await docViewHistoryRepo.listRecent({ uid: 'u_1', spaceId: 's_trident', isSpaceMember: true, pageSize: 20 })
    const itemsSql = mockQuery.mock.calls.at(-1)![0] as string
    const itemsParams = mockQuery.mock.calls.at(-1)![1] as unknown[]
    // The recent query is pinned to ONE space: v.space_id = ? bound to the caller's
    // queried space. A view row recorded under another space is never selected.
    expect(itemsSql).toContain('v.space_id = ?')
    expect(itemsParams).toContain('s_trident')
    // The space-share branch MUST require the doc's HOME space to equal the view
    // record's space (m.share_scope = 1 AND m.space_id = v.space_id). A bare
    // `OR m.share_scope = 1` would let a doc shared in a DIFFERENT space surface
    // via a stray view row — that is the cross-space leak this guard forbids.
    expect(itemsSql).toContain('m.share_scope = 1 AND m.space_id = v.space_id')
    expect(itemsSql).not.toMatch(/OR\s+m\.share_scope = 1\s*\)/) // never unguarded
  })

  it('CROSS-SPACE GATE: a NON-member never gets the share branch at all — visibility is owner OR doc_member (XIN-1295)', async () => {
    mockQuery.mockResolvedValueOnce([{ cnt: 0 }] as never) // count
    mockQuery.mockResolvedValueOnce([] as never) // items
    // v.space_id pins the query to the caller-named space, but naming a space does
    // not make the caller a member of it. Symmetric with the write side
    // (resolveEffectiveRole -> isSpaceMember): an unconfirmed member must NOT read
    // that space's anyone_in_space docs, even via a residual view row.
    await docViewHistoryRepo.listRecent({ uid: 'u_1', spaceId: 's_trident', isSpaceMember: false, pageSize: 20 })
    const itemsSql = mockQuery.mock.calls.at(-1)![0] as string
    expect(itemsSql).not.toContain('share_scope')
    expect(itemsSql).toContain('(m.owner_id = ? OR dm.role IN (1, 2, 3, 4))')
    // isSpaceMember omitted (undefined) is fail-closed too: no share branch.
    mockQuery.mockResolvedValueOnce([{ cnt: 0 }] as never)
    mockQuery.mockResolvedValueOnce([] as never)
    await docViewHistoryRepo.listRecent({ uid: 'u_1', spaceId: 's_trident', pageSize: 20 })
    expect(mockQuery.mock.calls.at(-1)![0] as string).not.toContain('share_scope')
  })

  it('fetches pageSize+1 (inlined LIMIT) and derives nextCursor from the last kept row', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      doc_id: `d_${i}`, title: `T${i}`, owner_id: 'u_o', doc_type: 'doc', role: 1,
      updated_at: new Date('2026-07-10T00:00:00.000Z'),
      viewed_at: new Date(`2026-07-15T06:00:0${i}.000Z`),
    }))
    mockQuery.mockResolvedValueOnce([{ cnt: 9 }] as never) // count
    mockQuery.mockResolvedValueOnce(rows as never) // items: pageSize(2)+1 = 3 rows
    const out = await docViewHistoryRepo.listRecent({ uid: 'u_1', spaceId: 's1', pageSize: 2 })
    const itemsSql = mockQuery.mock.calls.at(-1)![0] as string
    expect(itemsSql).toMatch(/LIMIT 3\b/) // pageSize(2)+1
    expect(itemsSql).not.toMatch(/LIMIT \?/)
    expect(out.items).toHaveLength(2) // truncated back to pageSize
    expect(out.total).toBe(9)
    // nextCursor decodes to the 2nd (last kept) row's (viewed_at, doc_id).
    const cur = decodeViewCursor(out.nextCursor!)!
    expect(cur.docId).toBe('d_1')
    expect(cur.viewedAt).toBe('2026-07-15T06:00:01.000Z')
  })

  it('projects m.octo_doc_slug in the items SELECT so html rows can carry a slug', async () => {
    mockQuery.mockResolvedValueOnce([{ cnt: 0 }] as never) // count
    mockQuery.mockResolvedValueOnce([] as never) // items
    await docViewHistoryRepo.listRecent({ uid: 'u_1', spaceId: 's1', pageSize: 20 })
    const itemsSql = mockQuery.mock.calls.at(-1)![0] as string
    expect(itemsSql).toContain('m.octo_doc_slug')
  })

  it('returns nextCursor=null when the page is not full (no further page)', async () => {
    mockQuery.mockResolvedValueOnce([{ cnt: 1 }] as never)
    mockQuery.mockResolvedValueOnce([
      { doc_id: 'd_0', title: 'T', owner_id: 'u_o', doc_type: 'doc', role: 3,
        updated_at: new Date(0), viewed_at: new Date('2026-07-15T06:00:00.000Z') },
    ] as never)
    const out = await docViewHistoryRepo.listRecent({ uid: 'u_1', spaceId: 's1', pageSize: 20 })
    expect(out.nextCursor).toBeNull()
    expect(out.items).toHaveLength(1)
  })

  it('applies a keyset cursor as a (viewed_at, doc_id) tuple comparison with bound params', async () => {
    mockQuery.mockResolvedValueOnce([{ cnt: 5 }] as never)
    mockQuery.mockResolvedValueOnce([] as never)
    const cursor = encodeViewCursor('2026-07-15T06:00:01.000Z', 'd_1')
    await docViewHistoryRepo.listRecent({ uid: 'u_1', spaceId: 's1', cursor, pageSize: 20 })
    const call = mockQuery.mock.calls.at(-1)!
    const sql = call[0] as string
    const params = call[1] as unknown[]
    expect(sql).toContain('(v.viewed_at, v.doc_id) < (?, ?)')
    // the cursor viewed_at binds as a Date (mysql2 round-trips DATETIME as Date).
    const curDate = params.find((p) => p instanceof Date && (p as Date).toISOString() === '2026-07-15T06:00:01.000Z')
    expect(curDate).toBeDefined()
    expect(params).toContain('d_1')
  })

  it('escapes LIKE wildcards in q so a literal %/_ matches literally (CI substring)', async () => {
    mockQuery.mockResolvedValueOnce([{ cnt: 0 }] as never)
    mockQuery.mockResolvedValueOnce([] as never)
    await docViewHistoryRepo.listRecent({ uid: 'u_1', spaceId: 's1', q: '  50%_off  ', pageSize: 20 })
    const call = mockQuery.mock.calls.at(-1)!
    const sql = call[0] as string
    const params = call[1] as unknown[]
    expect(sql).toContain("LIKE ? ESCAPE '\\\\'")
    // trimmed + wildcards escaped.
    expect(params).toContain('%50\\%\\_off%')
  })

  it('creator multi-select becomes owner_id IN (?, ?) — OR between creators, AND with q', async () => {
    mockQuery.mockResolvedValueOnce([{ cnt: 0 }] as never)
    mockQuery.mockResolvedValueOnce([] as never)
    await docViewHistoryRepo.listRecent({
      uid: 'u_1', spaceId: 's1', q: 'spec', creators: ['u_a', 'u_b'], pageSize: 20,
    })
    const call = mockQuery.mock.calls.at(-1)!
    const sql = call[0] as string
    const params = call[1] as unknown[]
    expect(sql).toContain('m.owner_id IN (?, ?)')
    expect(sql).toContain("LIKE ? ESCAPE '\\\\'") // AND-ed with q
    expect(params).toContain('u_a')
    expect(params).toContain('u_b')
  })

  it('an empty creators array short-circuits to no IN clause (no empty IN ())', async () => {
    mockQuery.mockResolvedValueOnce([{ cnt: 0 }] as never)
    mockQuery.mockResolvedValueOnce([] as never)
    await docViewHistoryRepo.listRecent({ uid: 'u_1', spaceId: 's1', creators: [], pageSize: 20 })
    const sql = mockQuery.mock.calls.at(-1)![0] as string
    expect(sql).not.toContain('IN ()')
    expect(sql).not.toContain('owner_id IN')
  })

  it('type multi-select becomes doc_type IN (?, ?) — OR between kinds, AND with q/creator (XIN-1188)', async () => {
    mockQuery.mockResolvedValueOnce([{ cnt: 0 }] as never)
    mockQuery.mockResolvedValueOnce([] as never)
    await docViewHistoryRepo.listRecent({
      uid: 'u_1', spaceId: 's1', q: 'spec', creators: ['u_a'], types: ['doc', 'sheet'], pageSize: 20,
    })
    const call = mockQuery.mock.calls.at(-1)!
    const sql = call[0] as string
    const params = call[1] as unknown[]
    expect(sql).toContain('m.doc_type IN (?, ?)')
    expect(sql).toContain('m.owner_id IN (?)') // AND-ed with creator
    expect(sql).toContain("LIKE ? ESCAPE '\\\\'") // AND-ed with q
    expect(params).toContain('doc')
    expect(params).toContain('sheet')
  })

  it('the type filter narrows the COUNT too (before pagination — page and total agree)', async () => {
    mockQuery.mockResolvedValueOnce([{ cnt: 0 }] as never)
    mockQuery.mockResolvedValueOnce([] as never)
    await docViewHistoryRepo.listRecent({ uid: 'u_1', spaceId: 's1', types: ['board'], pageSize: 20 })
    // first call is the COUNT(*) query; it must carry the same doc_type predicate + bind.
    const countCall = mockQuery.mock.calls[0]!
    expect(countCall[0] as string).toContain('m.doc_type IN (?)')
    expect(countCall[1] as unknown[]).toContain('board')
  })

  it('an empty types array short-circuits to no doc_type clause (backward compatible)', async () => {
    mockQuery.mockResolvedValueOnce([{ cnt: 0 }] as never)
    mockQuery.mockResolvedValueOnce([] as never)
    await docViewHistoryRepo.listRecent({ uid: 'u_1', spaceId: 's1', types: [], pageSize: 20 })
    const sql = mockQuery.mock.calls.at(-1)![0] as string
    expect(sql).not.toContain('doc_type IN')
  })
})

describe('docViewHistoryRepo.listCreators — pre-facet distinct owners', () => {
  it('returns DISTINCT owners under q + query-time permission filter, WITHOUT the creator filter (member)', async () => {
    mockQuery.mockResolvedValueOnce([{ owner_id: 'u_a' }, { owner_id: 'u_b' }] as never)
    const out = await docViewHistoryRepo.listCreators({ uid: 'u_1', spaceId: 's1', isSpaceMember: true, q: 'spec' })
    const sql = mockQuery.mock.calls.at(-1)![0] as string
    expect(sql).toContain('SELECT DISTINCT m.owner_id')
    expect(sql).toContain('m.status = 1')
    // Creator facet must share listRecent's visibility, including the space-share
    // branch for a member, so a shared-doc owner shows up in the filter dropdown too
    // — and it stays same-space-guarded (no cross-space leak into the facet).
    expect(sql).toContain(
      '(m.owner_id = ? OR dm.role IN (1, 2, 3, 4) OR (m.share_scope = 1 AND m.space_id = v.space_id))',
    )
    expect(sql).toContain("LIKE ? ESCAPE '\\\\'") // respects q
    expect(sql).not.toContain('owner_id IN') // NOT the creator filter
    expect(out).toEqual(['u_a', 'u_b'])
  })

  it('CROSS-SPACE GATE: a NON-member creator facet drops the share branch (XIN-1295)', async () => {
    mockQuery.mockResolvedValueOnce([] as never)
    await docViewHistoryRepo.listCreators({ uid: 'u_1', spaceId: 's1', isSpaceMember: false, q: 'spec' })
    const sql = mockQuery.mock.calls.at(-1)![0] as string
    // Same asymmetry fix as listRecent: no share source in the facet for a
    // non-member, so a share-only doc's owner never leaks into the dropdown.
    expect(sql).not.toContain('share_scope')
    expect(sql).toContain('(m.owner_id = ? OR dm.role IN (1, 2, 3, 4))')
  })
})

describe('keyset cursor codec', () => {
  it('round-trips (viewed_at, doc_id) through base64url', () => {
    const enc = encodeViewCursor('2026-07-15T06:00:01.000Z', 'd_9')
    expect(decodeViewCursor(enc)).toEqual({ viewedAt: '2026-07-15T06:00:01.000Z', docId: 'd_9' })
  })

  it('treats a missing/empty cursor as the first page (null)', () => {
    expect(decodeViewCursor(undefined)).toBeNull()
    expect(decodeViewCursor('')).toBeNull()
  })

  it('throws invalid_cursor on garbage / wrong shape / unparseable date', () => {
    expect(() => decodeViewCursor('!!!not-base64-json')).toThrow('invalid_cursor')
    expect(() => decodeViewCursor(Buffer.from('{"v":"x"}').toString('base64url'))).toThrow('invalid_cursor')
    expect(() =>
      decodeViewCursor(Buffer.from('{"v":"not-a-date","d":"d_1"}').toString('base64url')),
    ).toThrow('invalid_cursor')
  })
})
