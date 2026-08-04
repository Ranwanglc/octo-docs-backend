import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test for the FEAT-B route handlers. Mock the permission guard,
// the doc_view_history repo, and octo identity, then exercise the exported
// handlers directly (mirrors docsRoutes.test.ts) — no live infra.
vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/db/repos/docViewHistoryRepo.js', () => ({
  docViewHistoryRepo: {
    upsertViewWithPrune: vi.fn(),
    listRecent: vi.fn(),
    listCreators: vi.fn(),
  },
}))
const { getUsersMock, isSpaceMemberMock } = vi.hoisted(() => ({
  getUsersMock: vi.fn(),
  isSpaceMemberMock: vi.fn(),
}))
vi.mock('../src/auth/octoIdentity.js', () => ({
  getOctoIdentity: () => ({ getUsers: getUsersMock, isSpaceMember: isSpaceMemberMock }),
}))

import {
  recordDocViewHandler,
  listRecentHandler,
  listRecentCreatorsHandler,
} from '../src/api/routes/docs.js'
import { requireDocRole } from '../src/api/guard.js'
import { docViewHistoryRepo } from '../src/db/repos/docViewHistoryRepo.js'

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
    status(c: number) { this.statusCode = c; return this },
    json(b: unknown) { this.body = b; return this },
  }
}
function req(extra: Record<string, unknown>) {
  return { uid: 'u_1', spaceId: 's1', octoToken: 'tok', params: {}, query: {}, ...extra } as never
}

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(docViewHistoryRepo.upsertViewWithPrune).mockReset()
  vi.mocked(docViewHistoryRepo.listRecent).mockReset()
  vi.mocked(docViewHistoryRepo.listCreators).mockReset()
  getUsersMock.mockReset()
  isSpaceMemberMock.mockReset()
  isSpaceMemberMock.mockResolvedValue(true)
})

describe('POST /docs/:docId/view — recordDocViewHandler', () => {
  it('does NOT ingest when the reader guard blocks (guard already wrote the error)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(null) // 403/404/409 written by guard
    const res = mockRes()
    await recordDocViewHandler(req({ params: { docId: 'd_1' } }), res as never)
    expect(docViewHistoryRepo.upsertViewWithPrune).not.toHaveBeenCalled()
  })

  it('UPSERTs the view (uid derived server-side) and returns 200 { ok, viewedAt ISO }', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({ meta: {}, role: 'reader' } as never)
    vi.mocked(docViewHistoryRepo.upsertViewWithPrune).mockResolvedValue(
      new Date('2026-07-15T06:20:48.123Z'),
    )
    const res = mockRes()
    // a viewedBy in the body must be ignored — uid comes from req.uid.
    await recordDocViewHandler(
      req({ params: { docId: 'd_1' }, body: { viewedBy: 'u_hacker' } }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: true, viewedAt: '2026-07-15T06:20:48.123Z' })
    const arg = vi.mocked(docViewHistoryRepo.upsertViewWithPrune).mock.calls[0]![0]
    expect(arg.uid).toBe('u_1') // server-derived, not the body value
    expect(arg.docId).toBe('d_1')
    expect(arg.spaceId).toBe('s1')
  })
})

describe('GET /docs/recent — listRecentHandler', () => {
  it('maps rows to the wire shape: role string enum + viewedAt ISO + nextCursor', async () => {
    vi.mocked(docViewHistoryRepo.listRecent).mockResolvedValue({
      total: 2,
      nextCursor: 'CURSOR',
      items: [
        { doc_id: 'd_1', title: 'A', owner_id: 'u_o', doc_type: 'doc', role: 2,
          updated_at: new Date('2026-07-10T00:00:00.000Z'), updated_by: 'u_e1',
          viewed_at: new Date('2026-07-15T06:00:00.000Z') },
        { doc_id: 'd_2', title: 'B', owner_id: 'u_1', doc_type: 'board', role: 3,
          updated_at: new Date('2026-07-11T00:00:00.000Z'), updated_by: 'u_e2',
          viewed_at: new Date('2026-07-15T05:00:00.000Z') },
      ],
    } as never)
    getUsersMock.mockResolvedValue([
      { uid: 'u_e1', name: 'Editor One' },
      { uid: 'u_e2', name: 'Editor Two' },
    ])
    const res = mockRes()
    await listRecentHandler(req({ query: { q: 'a', creator: ['u_o'], cursor: 'X' } }), res as never)
    expect(res.statusCode).toBe(200)
    const body = res.body as { total: number; nextCursor: string; items: Array<Record<string, unknown>> }
    expect(body.total).toBe(2)
    expect(body.nextCursor).toBe('CURSOR')
    expect(body.items[0]!.role).toBe('writer')
    expect(body.items[1]!.role).toBe('admin')
    expect(body.items[0]!.viewedAt).toBe('2026-07-15T06:00:00.000Z')
    // repo received the normalized inputs.
    const arg = vi.mocked(docViewHistoryRepo.listRecent).mock.calls[0]![0]
    expect(arg.creators).toEqual(['u_o'])
    expect(arg.cursor).toBe('X')
  })

  it('drops an anomalous role projection instead of exposing it as reader', async () => {
    vi.mocked(docViewHistoryRepo.listRecent).mockResolvedValue({
      total: 1,
      nextCursor: null,
      items: [
        { doc_id: 'd_corrupt', title: 'X', owner_id: 'u_o', doc_type: 'doc', role: 99,
          updated_at: new Date('2026-07-10T00:00:00.000Z'), updated_by: '',
          viewed_at: new Date('2026-07-15T06:00:00.000Z') },
      ],
    } as never)
    const res = mockRes()
    await listRecentHandler(req({ query: {} }), res as never)
    expect((res.body as { items: unknown[] }).items).toEqual([])
  })

  it('surfaces octo_doc_slug as octoDocSlug on html rows (so the front-end can fetch the body) and omits it on non-html rows', async () => {
    vi.mocked(docViewHistoryRepo.listRecent).mockResolvedValue({
      total: 2,
      nextCursor: null,
      items: [
        { doc_id: 'd_html', title: 'Web', owner_id: 'u_o', doc_type: 'html', octo_doc_slug: 'sp/fd/html-slug', role: 1,
          updated_at: new Date('2026-07-10T00:00:00.000Z'), updated_by: '',
          viewed_at: new Date('2026-07-15T06:00:00.000Z') },
        { doc_id: 'd_doc', title: 'Doc', owner_id: 'u_o', doc_type: 'doc', octo_doc_slug: null, role: 1,
          updated_at: new Date('2026-07-10T00:00:00.000Z'), updated_by: '',
          viewed_at: new Date('2026-07-15T05:00:00.000Z') },
      ],
    } as never)
    const res = mockRes()
    await listRecentHandler(req({ query: {} }), res as never)
    expect(res.statusCode).toBe(200)
    const body = res.body as { items: Array<Record<string, unknown>> }
    // html row carries the slug under the wire key octoDocSlug (same shape as GET /docs).
    expect(body.items[0]!.octoDocSlug).toBe('sp/fd/html-slug')
    // non-html row omits the key entirely (not null/undefined value).
    expect('octoDocSlug' in body.items[1]!).toBe(false)
  })

  it('resolves updatedBy (last editor) to { uid, name } server-side, authenticated with the caller token (XIN-1240)', async () => {
    vi.mocked(docViewHistoryRepo.listRecent).mockResolvedValue({
      total: 1,
      nextCursor: null,
      items: [
        { doc_id: 'd_1', title: 'A', owner_id: 'u_o', doc_type: 'doc', role: 2,
          updated_at: new Date('2026-07-10T00:00:00.000Z'), updated_by: 'u_e1',
          viewed_at: new Date('2026-07-15T06:00:00.000Z') },
      ],
    } as never)
    getUsersMock.mockResolvedValue([{ uid: 'u_e1', name: 'Zhang San' }])
    const res = mockRes()
    await listRecentHandler(req({ query: {} }), res as never)
    const body = res.body as { items: Array<Record<string, unknown>> }
    expect(body.items[0]!.updatedBy).toEqual({ uid: 'u_e1', name: 'Zhang San' })
    // name resolution is authenticated with the caller's own token (same as creators).
    expect(getUsersMock).toHaveBeenCalledWith(['u_e1'], 'tok')
  })

  it('falls back updatedBy.name to the uid when the directory has no (or blank) name', async () => {
    vi.mocked(docViewHistoryRepo.listRecent).mockResolvedValue({
      total: 2,
      nextCursor: null,
      items: [
        { doc_id: 'd_1', title: 'A', owner_id: 'u_o', doc_type: 'doc', role: 2,
          updated_at: new Date('2026-07-10T00:00:00.000Z'), updated_by: 'u_blank',
          viewed_at: new Date('2026-07-15T06:00:00.000Z') },
        { doc_id: 'd_2', title: 'B', owner_id: 'u_o', doc_type: 'doc', role: 2,
          updated_at: new Date('2026-07-10T00:00:00.000Z'), updated_by: 'u_missing',
          viewed_at: new Date('2026-07-15T05:00:00.000Z') },
      ],
    } as never)
    getUsersMock.mockResolvedValue([{ uid: 'u_blank', name: '  ' }]) // blank name; u_missing absent
    const res = mockRes()
    await listRecentHandler(req({ query: {} }), res as never)
    const body = res.body as { items: Array<Record<string, unknown>> }
    expect(body.items[0]!.updatedBy).toEqual({ uid: 'u_blank', name: 'u_blank' })
    expect(body.items[1]!.updatedBy).toEqual({ uid: 'u_missing', name: 'u_missing' })
  })

  it('returns updatedBy=null for a never-edited doc (updated_by = "") without hitting the directory', async () => {
    vi.mocked(docViewHistoryRepo.listRecent).mockResolvedValue({
      total: 1,
      nextCursor: null,
      items: [
        { doc_id: 'd_1', title: 'A', owner_id: 'u_o', doc_type: 'doc', role: 2,
          updated_at: new Date('2026-07-10T00:00:00.000Z'), updated_by: '',
          viewed_at: new Date('2026-07-15T06:00:00.000Z') },
      ],
    } as never)
    const res = mockRes()
    await listRecentHandler(req({ query: {} }), res as never)
    const body = res.body as { items: Array<Record<string, unknown>> }
    expect(body.items[0]!.updatedBy).toBeNull()
    // no non-empty editor uids => no directory call.
    expect(getUsersMock).not.toHaveBeenCalled()
  })

  it('batches distinct editor uids into a single directory call (dedup across rows)', async () => {
    vi.mocked(docViewHistoryRepo.listRecent).mockResolvedValue({
      total: 2,
      nextCursor: null,
      items: [
        { doc_id: 'd_1', title: 'A', owner_id: 'u_o', doc_type: 'doc', role: 2,
          updated_at: new Date('2026-07-10T00:00:00.000Z'), updated_by: 'u_e1',
          viewed_at: new Date('2026-07-15T06:00:00.000Z') },
        { doc_id: 'd_2', title: 'B', owner_id: 'u_o', doc_type: 'doc', role: 2,
          updated_at: new Date('2026-07-10T00:00:00.000Z'), updated_by: 'u_e1',
          viewed_at: new Date('2026-07-15T05:00:00.000Z') },
      ],
    } as never)
    getUsersMock.mockResolvedValue([{ uid: 'u_e1', name: 'Editor One' }])
    const res = mockRes()
    await listRecentHandler(req({ query: {} }), res as never)
    expect(getUsersMock).toHaveBeenCalledTimes(1)
    expect(getUsersMock).toHaveBeenCalledWith(['u_e1'], 'tok') // deduped, not ['u_e1','u_e1']
    const body = res.body as { items: Array<Record<string, unknown>> }
    expect(body.items[0]!.updatedBy).toEqual({ uid: 'u_e1', name: 'Editor One' })
    expect(body.items[1]!.updatedBy).toEqual({ uid: 'u_e1', name: 'Editor One' })
  })

  it('answers 400 invalid_cursor when the repo rejects a malformed cursor', async () => {
    vi.mocked(docViewHistoryRepo.listRecent).mockRejectedValue(new Error('invalid_cursor'))
    const res = mockRes()
    await listRecentHandler(req({ query: { cursor: 'garbage' } }), res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_cursor' })
  })

  it('normalizes the repeated ?type= param and forwards a validated types[] to the repo (XIN-1188)', async () => {
    vi.mocked(docViewHistoryRepo.listRecent).mockResolvedValue({ total: 0, nextCursor: null, items: [] } as never)
    const res = mockRes()
    // a stray unknown value is dropped; known kinds pass through as a multi-value OR set.
    await listRecentHandler(req({ query: { type: ['doc', 'sheet', 'slides'] } }), res as never)
    expect(res.statusCode).toBe(200)
    const arg = vi.mocked(docViewHistoryRepo.listRecent).mock.calls[0]![0]
    expect(arg.types).toEqual(['doc', 'sheet'])
  })

  it('forwards no type filter (empty array) when the param is absent — backward compatible', async () => {
    vi.mocked(docViewHistoryRepo.listRecent).mockResolvedValue({ total: 0, nextCursor: null, items: [] } as never)
    const res = mockRes()
    await listRecentHandler(req({ query: {} }), res as never)
    const arg = vi.mocked(docViewHistoryRepo.listRecent).mock.calls[0]![0]
    expect(arg.types).toEqual([])
  })

  it('CROSS-SPACE GATE: resolves the caller space membership and forwards isSpaceMember=true for a member (XIN-1295)', async () => {
    isSpaceMemberMock.mockResolvedValue(true)
    vi.mocked(docViewHistoryRepo.listRecent).mockResolvedValue({ total: 0, nextCursor: null, items: [] } as never)
    const res = mockRes()
    await listRecentHandler(req({ query: {} }), res as never)
    // membership resolved against the QUERIED space, with the caller's own token.
    expect(isSpaceMemberMock).toHaveBeenCalledWith('u_1', 's1', 'tok')
    expect(vi.mocked(docViewHistoryRepo.listRecent).mock.calls[0]![0].isSpaceMember).toBe(true)
  })

  it('CROSS-SPACE GATE: forwards isSpaceMember=false for a NON-member so the share branch is dropped (XIN-1295)', async () => {
    isSpaceMemberMock.mockResolvedValue(false)
    vi.mocked(docViewHistoryRepo.listRecent).mockResolvedValue({ total: 0, nextCursor: null, items: [] } as never)
    const res = mockRes()
    await listRecentHandler(req({ query: {} }), res as never)
    expect(vi.mocked(docViewHistoryRepo.listRecent).mock.calls[0]![0].isSpaceMember).toBe(false)
  })

  it('RC#2 fail-closed: a rejected isSpaceMember lookup degrades to non-member, never a 500', async () => {
    isSpaceMemberMock.mockRejectedValue(new Error('identity service unavailable'))
    vi.mocked(docViewHistoryRepo.listRecent).mockResolvedValue({ total: 0, nextCursor: null, items: [] } as never)
    const res = mockRes()
    await listRecentHandler(req({ query: {} }), res as never)
    expect(res.statusCode).toBe(200)
    expect(vi.mocked(docViewHistoryRepo.listRecent).mock.calls[0]![0].isSpaceMember).toBe(false)
  })
})

describe('GET /docs/recent/creators — listRecentCreatorsHandler', () => {
  it('resolves display names server-side and falls back to uid when a name is missing', async () => {
    vi.mocked(docViewHistoryRepo.listCreators).mockResolvedValue(['u_a', 'u_b', 'u_c'])
    getUsersMock.mockResolvedValue([
      { uid: 'u_a', name: 'Alice' },
      { uid: 'u_b', name: '  ' }, // blank -> fallback to uid
      // u_c absent from directory -> fallback to uid
    ])
    const res = mockRes()
    await listRecentCreatorsHandler(req({ query: { q: 'spec' } }), res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      creators: [
        { uid: 'u_a', name: 'Alice' },
        { uid: 'u_b', name: 'u_b' },
        { uid: 'u_c', name: 'u_c' },
      ],
    })
    // name resolution is authenticated with the caller's own token.
    expect(getUsersMock).toHaveBeenCalledWith(['u_a', 'u_b', 'u_c'], 'tok')
  })

  it('returns an empty list without calling the directory when there are no creators', async () => {
    vi.mocked(docViewHistoryRepo.listCreators).mockResolvedValue([])
    const res = mockRes()
    await listRecentCreatorsHandler(req({ query: {} }), res as never)
    expect(res.body).toEqual({ creators: [] })
    expect(getUsersMock).not.toHaveBeenCalled()
  })

  it('CROSS-SPACE GATE: forwards the resolved isSpaceMember flag to listCreators (XIN-1295)', async () => {
    isSpaceMemberMock.mockResolvedValue(false)
    vi.mocked(docViewHistoryRepo.listCreators).mockResolvedValue([])
    const res = mockRes()
    await listRecentCreatorsHandler(req({ query: {} }), res as never)
    expect(isSpaceMemberMock).toHaveBeenCalledWith('u_1', 's1', 'tok')
    expect(vi.mocked(docViewHistoryRepo.listCreators).mock.calls[0]![0].isSpaceMember).toBe(false)
  })
})
