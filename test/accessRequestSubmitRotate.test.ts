import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test for docAccessRequestRepo.submit — request_id ROTATION on
// re-submit (review blocker: stale-card cross-approval).
//
// An approval card carries only request_id as its decision key. If a re-submit
// reused the same request_id, a stale card minted for an earlier submission
// (e.g. requested "reader") could approve a LATER, different pending row (e.g.
// re-submitted as "writer") — granting a role the approver never saw on their
// card. submit() must therefore write `request_id = VALUES(request_id)` in the
// ON DUPLICATE KEY UPDATE so every submission rotates to a fresh id; a stale
// card's request_id then matches no row and the callback resolves not_found.
//
// We mock the pool's `query` so the SQL + bind order are asserted and the
// read-back-authoritative-row contract is locked without a DB.
const query = vi.fn()
vi.mock('../src/db/pool.js', () => ({
  query: (...args: unknown[]) => query(...args),
  getPool: () => ({ execute: vi.fn() }),
}))
// Deterministic id so we can assert it flows into the INSERT bind AND the update.
vi.mock('../src/util/ids.js', () => ({ newRequestId: () => 'rotated-id-2' }))

import { docAccessRequestRepo, REQUEST_STATUS_PENDING } from '../src/db/repos/docAccessRequestRepo.js'

beforeEach(() => {
  query.mockReset()
})

const params = { docId: 'd_1', uid: 'u_req', requestedRoleNum: 2, reason: 'need writer' }

describe('docAccessRequestRepo.submit — request_id rotation on re-submit', () => {
  it('writes request_id = VALUES(request_id) in the ON DUPLICATE KEY UPDATE', async () => {
    query
      .mockResolvedValueOnce(undefined) // the INSERT ... ON DUPLICATE KEY UPDATE
      .mockResolvedValueOnce([{ request_id: 'rotated-id-2', status: REQUEST_STATUS_PENDING }]) // read-back

    await docAccessRequestRepo.submit(params)

    const [insertSql, insertBinds] = query.mock.calls[0]!
    // The rotation clause — without this a stale card can cross-approve.
    expect(insertSql).toContain('request_id     = VALUES(request_id)')
    expect(insertSql).toContain('ON DUPLICATE KEY UPDATE')
    // The fresh id is bound as the INSERT candidate, so a duplicate
    // update sets request_id to this new value via VALUES(request_id). The
    // trailing bind is the normalized bot_uids JSON snapshot (empty here).
    expect(insertBinds).toEqual(['d_1', 'u_req', 2, 'need writer', 'rotated-id-2', '[]'])
  })

  it('clears decision_note in the ON DUPLICATE KEY UPDATE so a re-submit drops the prior denial reason', async () => {
    // Re-submit reuses the (doc_id, uid) row and resets it to pending. A previously
    // denied request leaves decision_note populated; without an explicit reset the
    // fresh pending row would carry the prior cycle's reviewer reason, which the
    // companion octo-server outcome card surfaces to the requester — misattributing
    // a stale denial to a brand-new request. submit() must clear it alongside
    // decided_by. (review blocker: stale-note leak on re-submit.)
    query
      .mockResolvedValueOnce(undefined) // INSERT ... ON DUPLICATE KEY UPDATE
      .mockResolvedValueOnce([{ request_id: 'rotated-id-2', status: REQUEST_STATUS_PENDING }]) // read-back

    await docAccessRequestRepo.submit(params)

    const [insertSql] = query.mock.calls[0]!
    // The reset clause — without this a resubmitted request keeps the old deny reason.
    expect(insertSql).toContain("decision_note  = ''")
    // Reset sits inside the duplicate-key update, right next to decided_by.
    expect(insertSql).toContain("decided_by     = ''")
    expect(insertSql).toContain('ON DUPLICATE KEY UPDATE')
  })

  it('returns the read-back authoritative request_id (the rotated value)', async () => {
    query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([{ request_id: 'rotated-id-2', status: REQUEST_STATUS_PENDING }])

    const out = await docAccessRequestRepo.submit(params)
    expect(out.requestId).toBe('rotated-id-2')
    expect(out.status).toBe(REQUEST_STATUS_PENDING)
  })

  it('binds a normalized bot_uids JSON snapshot and rotates it via VALUES(bot_uids)', async () => {
    query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([{ request_id: 'rotated-id-2', status: REQUEST_STATUS_PENDING }])

    // The route strict-validates before this, so the repo receives a clean list;
    // it re-checks fail-closed and binds canonical (sorted) JSON.
    await docAccessRequestRepo.submit({ ...params, botUids: ['bot_b', 'bot_a'] })

    const [insertSql, insertBinds] = query.mock.calls[0]!
    // Snapshot is rotated in lockstep with request_id on a duplicate re-submit.
    expect(insertSql).toContain('bot_uids       = VALUES(bot_uids)')
    expect(insertSql).toContain('CAST(? AS JSON)')
    // Last bind is the canonical (sorted) JSON text.
    expect(insertBinds[insertBinds.length - 1]).toBe('["bot_a","bot_b"]')
  })

  it('fail-closes a corrupt stored-write snapshot (duplicate) to [] before binding', async () => {
    query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([{ request_id: 'rotated-id-2', status: REQUEST_STATUS_PENDING }])
    // A duplicate reaching the DB boundary (should never pass the route) fail-
    // closes the WHOLE snapshot to [] rather than binding a partial list.
    await docAccessRequestRepo.submit({ ...params, botUids: ['bot_a', 'bot_a'] })
    const [, insertBinds] = query.mock.calls[0]!
    expect(insertBinds[insertBinds.length - 1]).toBe('[]')
  })

  it('binds an empty JSON array when no bots are carried (legacy zero-bot path)', async () => {
    query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([{ request_id: 'rotated-id-2', status: REQUEST_STATUS_PENDING }])
    await docAccessRequestRepo.submit(params) // no botUids
    const [, insertBinds] = query.mock.calls[0]!
    expect(insertBinds[insertBinds.length - 1]).toBe('[]')
  })
})

describe('docAccessRequestRepo read-back — bot_uids normalization (fail-closed)', () => {
  it('normalizes a stored JSON string on getByRequestId', async () => {
    query.mockResolvedValueOnce([
      { doc_id: 'd_1', uid: 'u', request_id: 'req_x', status: 1, requested_role: 1, bot_uids: '["bot_b","bot_a"]' },
    ])
    const row = await docAccessRequestRepo.getByRequestId('d_1', 'req_x')
    expect(row?.bot_uids).toEqual(['bot_a', 'bot_b'])
  })

  it('a NULL bot_uids column reads back as [] (backward compatible)', async () => {
    query.mockResolvedValueOnce([
      { doc_id: 'd_1', uid: 'u', request_id: 'req_x', status: 1, requested_role: 1, bot_uids: null },
    ])
    const row = await docAccessRequestRepo.getByRequestId('d_1', 'req_x')
    expect(row?.bot_uids).toEqual([])
  })

  it('a corrupt stored value reads back as [] (fail-closed, authorizes no bot)', async () => {
    query.mockResolvedValueOnce([
      { doc_id: 'd_1', uid: 'u', request_id: 'req_x', status: 1, requested_role: 1, bot_uids: '{not json' },
    ])
    const row = await docAccessRequestRepo.getByRequestId('d_1', 'req_x')
    expect(row?.bot_uids).toEqual([])
  })

  it('listByStatus fail-closes a corrupt (duplicate) snapshot to [] — no partial keep', async () => {
    query.mockResolvedValueOnce([
      { doc_id: 'd_1', uid: 'u1', request_id: 'r1', status: 1, requested_role: 1, bot_uids: ['bot_a', 'bot_a'] },
      { doc_id: 'd_1', uid: 'u2', request_id: 'r2', status: 1, requested_role: 1, bot_uids: null },
    ])
    const rows = await docAccessRequestRepo.listByStatus('d_1', 1)
    // A duplicate is a corrupt trusted value: the WHOLE snapshot fail-closes to []
    // (authorizes nothing), NOT a deduped partial list.
    expect(rows[0]!.bot_uids).toEqual([])
    expect(rows[1]!.bot_uids).toEqual([])
  })

  it('listByStatus keeps a clean stored snapshot (sorted)', async () => {
    query.mockResolvedValueOnce([
      { doc_id: 'd_1', uid: 'u1', request_id: 'r1', status: 1, requested_role: 1, bot_uids: ['bot_b', 'bot_a'] },
    ])
    const rows = await docAccessRequestRepo.listByStatus('d_1', 1)
    expect(rows[0]!.bot_uids).toEqual(['bot_a', 'bot_b'])
  })
})
