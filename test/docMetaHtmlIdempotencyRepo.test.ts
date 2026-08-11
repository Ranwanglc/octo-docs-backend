import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/db/pool.js', () => ({ query: vi.fn(), transaction: vi.fn() }))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({ docMemberRepo: {
  upsertDirectTx: vi.fn(),
  insertDirectIfAbsentTx: vi.fn(),
} }))

import { query, transaction } from '../src/db/pool.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import {
  CanonicalHtmlArchivedError,
  CanonicalHtmlDeletedError,
  CanonicalHtmlLegacyConflictError,
  DocOwnershipError,
  docMetaRepo,
} from '../src/db/repos/docMetaRepo.js'

const input = {
  docId: 'd_new', documentName: 'octo:s_a:f_default:html:d_new', title: 'Initial title',
  ownerId: 'bot_a', spaceId: 's_a', folderId: 'f_default', docType: 'html',
  octoDocSlug: 'd_new', idempotencyKey: 'same', createdBy: 'bot_a',
}
const hash = createHash('sha256').update(input.idempotencyKey, 'utf8').digest()
const existing = {
  doc_id: 'd_existing', document_name: 'octo:s_a:f_default:html:d_existing', title: 'Original title',
  owner_id: 'bot_a', space_id: 's_a', folder_id: 'f_default', doc_type: 'html',
  octo_doc_slug: 'd_existing', html_idempotency_key_hash: hash, status: 1,
}

describe('docMetaRepo.createCanonicalHtml', () => {
  const tx = { query: vi.fn() }
  beforeEach(() => {
    vi.mocked(query).mockReset()
    tx.query.mockReset()
    vi.mocked(docMemberRepo.upsertDirectTx).mockReset()
    vi.mocked(transaction).mockReset().mockImplementation(async (fn) => fn(tx as never))
  })

  it('hashes the raw key and returns an existing canonical doc without mutating metadata', async () => {
    vi.mocked(query).mockResolvedValueOnce([existing] as never)
    const result = await docMetaRepo.createCanonicalHtml({ ...input, title: 'Changed title', humanOwnerUid: 'u_human' })
    expect(result).toEqual({ meta: existing, created: false })
    expect(query).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith(expect.stringContaining('html_idempotency_key_hash = ?'), [
      's_a', 'bot_a', hash,
    ])
    expect(transaction).not.toHaveBeenCalled()
    expect(docMemberRepo.upsertDirectTx).not.toHaveBeenCalled()
  })

  it('stores the generated id in both doc_id and octo_doc_slug and stores only the SHA-256 hash', async () => {
    vi.mocked(query).mockResolvedValueOnce([] as never)
    tx.query
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ ...existing, doc_id: 'd_new', octo_doc_slug: 'd_new' }] as never)
    const result = await docMetaRepo.createCanonicalHtml({ ...input, humanOwnerUid: 'u_human' })
    expect(result.created).toBe(true)
    const args = tx.query.mock.calls[0]![1] as unknown[]
    expect(args).toEqual([
      'd_new', input.documentName, 'Initial title', 'bot_a', 's_a', 'f_default',
      'html', 'd_new', hash, 'bot_a',
    ])
    expect(args).not.toContain(input.idempotencyKey)
    expect(docMemberRepo.upsertDirectTx).toHaveBeenCalledWith(tx, {
      docId: 'd_new', uid: 'u_human', roleNum: 3, grantedBy: 'bot_a',
    })
  })

  it('recovers a duplicate-key race by returning the winner without metadata mutation', async () => {
    const duplicate = Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY', errno: 1062 })
    vi.mocked(query).mockResolvedValueOnce([] as never).mockResolvedValueOnce([existing] as never)
    tx.query.mockRejectedValueOnce(duplicate)
    const result = await docMetaRepo.createCanonicalHtml({ ...input, title: 'Losing title', humanOwnerUid: 'u_human' })
    expect(result).toEqual({ meta: existing, created: false })
    expect(query).toHaveBeenCalledTimes(2)
    expect(docMemberRepo.upsertDirectTx).not.toHaveBeenCalled()
    expect([...vi.mocked(query).mock.calls, ...tx.query.mock.calls].some(([sql]) => /^\s*UPDATE\b/i.test(String(sql)))).toBe(false)
  })

  it('propagates the initial human-owner grant failure so the transaction rolls back', async () => {
    vi.mocked(query).mockResolvedValueOnce([] as never)
    tx.query.mockResolvedValueOnce([] as never)
    vi.mocked(docMemberRepo.upsertDirectTx).mockRejectedValueOnce(new Error('grant failed'))
    await expect(docMetaRepo.createCanonicalHtml({ ...input, humanOwnerUid: 'u_human' })).rejects.toThrow('grant failed')
  })

  it('rejects a retry whose canonical row was soft-deleted without mutating it', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ ...existing, status: 0 }] as never)
    await expect(docMetaRepo.createCanonicalHtml(input)).rejects.toBeInstanceOf(CanonicalHtmlDeletedError)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('rejects a retry whose canonical row was archived without mutating it', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ ...existing, status: 2 }] as never)
    await expect(docMetaRepo.createCanonicalHtml(input)).rejects.toBeInstanceOf(CanonicalHtmlArchivedError)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('rejects a duplicate-key race won by a soft-deleted canonical row', async () => {
    const duplicate = Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY', errno: 1062 })
    vi.mocked(query)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ ...existing, status: 0 }] as never)
    tx.query.mockRejectedValueOnce(duplicate)
    await expect(docMetaRepo.createCanonicalHtml(input)).rejects.toBeInstanceOf(CanonicalHtmlDeletedError)
    expect(vi.mocked(query).mock.calls.some(([sql]) => /^\s*UPDATE\b/i.test(String(sql)))).toBe(false)
  })

  it.each([
    ['publisher', { owner_id: 'BOT_A' }],
    ['space', { space_id: 'S_A' }],
  ])('rejects a collation-equivalent non-exact %s match', async (_label, mismatch) => {
    vi.mocked(query).mockResolvedValueOnce([{ ...existing, ...mismatch }] as never)
    await expect(docMetaRepo.createCanonicalHtml(input)).rejects.toBeInstanceOf(DocOwnershipError)
  })

  it('creates another doc for a different key even when the title is unchanged', async () => {
    const otherHash = createHash('sha256').update('other', 'utf8').digest()
    vi.mocked(query).mockResolvedValueOnce([] as never)
    tx.query
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ ...existing, doc_id: 'd_new', octo_doc_slug: 'd_new' }] as never)
    const result = await docMetaRepo.createCanonicalHtml({ ...input, idempotencyKey: 'other' })
    expect(result.created).toBe(true)
    expect(query).toHaveBeenNthCalledWith(1, expect.any(String), ['s_a', 'bot_a', otherHash])
  })

  it('scopes the same key independently by publisher and space', async () => {
    vi.mocked(query).mockResolvedValueOnce([] as never)
    tx.query
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ ...existing, doc_id: 'd_other', owner_id: 'bot_b', space_id: 's_b' }] as never)
    const other = { ...input, docId: 'd_other', octoDocSlug: 'd_other', ownerId: 'bot_b', createdBy: 'bot_b', spaceId: 's_b' }
    expect((await docMetaRepo.createCanonicalHtml(other)).created).toBe(true)
    expect(query).toHaveBeenNthCalledWith(1, expect.any(String), ['s_b', 'bot_b', hash])
  })
})

describe('docMetaRepo.upsertHtmlByOctoDocSlug canonical isolation', () => {
  const legacy = { ...input, octoDocSlug: 'legacy-slug' }
  const legacyWithHuman = { ...legacy, humanOwnerUid: 'u_human' }
  const tx = { query: vi.fn(), execute: vi.fn() }

  beforeEach(() => {
    vi.mocked(query).mockReset()
    tx.query.mockReset()
    vi.mocked(transaction).mockReset().mockImplementation(async (fn) => fn(tx as never))
    vi.mocked(docMemberRepo.upsertDirectTx).mockReset()
    vi.mocked(docMemberRepo.insertDirectIfAbsentTx).mockReset()
  })

  it('creates legacy metadata and the initial human-owner admin in one transaction', async () => {
    vi.mocked(query).mockResolvedValueOnce([] as never)
    tx.query
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ ...existing, doc_id: 'd_new', octo_doc_slug: 'legacy-slug' }] as never)
    const result = await docMetaRepo.upsertHtmlByOctoDocSlug(legacyWithHuman)
    expect(result.created).toBe(true)
    expect(docMemberRepo.upsertDirectTx).toHaveBeenCalledWith(tx, {
      docId: 'd_new', uid: 'u_human', roleNum: 3, grantedBy: 'bot_a',
    })
    expect(docMemberRepo.insertDirectIfAbsentTx).not.toHaveBeenCalled()
  })

  it('propagates a fresh legacy member failure from the create transaction', async () => {
    vi.mocked(query).mockResolvedValueOnce([] as never)
    tx.query.mockResolvedValueOnce([] as never)
    vi.mocked(docMemberRepo.upsertDirectTx).mockRejectedValueOnce(new Error('member failed'))
    await expect(docMetaRepo.upsertHtmlByOctoDocSlug(legacyWithHuman)).rejects.toThrow('member failed')
    expect(transaction).toHaveBeenCalledTimes(1)
  })

  it.each([1, 4, 2, 3])('leaves an existing human-owner role %s untouched on legacy replay', async () => {
    const row = { ...existing, octo_doc_slug: 'legacy-slug', html_idempotency_key_hash: null }
    vi.mocked(query).mockResolvedValueOnce([row] as never)
    tx.query.mockResolvedValueOnce([] as never).mockResolvedValueOnce([row] as never)
    vi.mocked(docMemberRepo.insertDirectIfAbsentTx).mockResolvedValueOnce(false)
    const result = await docMetaRepo.upsertHtmlByOctoDocSlug(legacyWithHuman)
    expect(result.memberReconciled).toBe(false)
    expect(docMemberRepo.insertDirectIfAbsentTx).toHaveBeenCalledWith(tx, {
      docId: row.doc_id, uid: 'u_human', roleNum: 3, grantedBy: 'bot_a',
    })
    expect(tx.query.mock.calls.some(([sql]) => String(sql).includes('permission_epoch = permission_epoch + 1'))).toBe(false)
    expect(docMemberRepo.upsertDirectTx).not.toHaveBeenCalled()
  })

  it('reconciles a historically missing human owner once and bumps the epoch in the transaction', async () => {
    const row = { ...existing, octo_doc_slug: 'legacy-slug', html_idempotency_key_hash: null }
    vi.mocked(query).mockResolvedValueOnce([row] as never)
    tx.query
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ ...row, permission_epoch: 8 }] as never)
    vi.mocked(docMemberRepo.insertDirectIfAbsentTx).mockResolvedValueOnce(true)
    const result = await docMetaRepo.upsertHtmlByOctoDocSlug(legacyWithHuman)
    expect(result).toMatchObject({ created: false, memberReconciled: true, permissionEpoch: 8 })
    expect(tx.query.mock.calls.filter(([sql]) => String(sql).includes('permission_epoch = permission_epoch + 1'))).toHaveLength(1)
  })

  it('makes repeated legacy replay a no-op after the historical member exists', async () => {
    const row = { ...existing, octo_doc_slug: 'legacy-slug', html_idempotency_key_hash: null }
    vi.mocked(query).mockResolvedValue([row] as never)
    tx.query.mockResolvedValue([row] as never)
    vi.mocked(docMemberRepo.insertDirectIfAbsentTx).mockResolvedValue(false)
    const first = await docMetaRepo.upsertHtmlByOctoDocSlug(legacyWithHuman)
    const second = await docMetaRepo.upsertHtmlByOctoDocSlug(legacyWithHuman)
    expect(first.memberReconciled).toBe(false)
    expect(second.memberReconciled).toBe(false)
    expect(tx.query.mock.calls.some(([sql]) => String(sql).includes('permission_epoch = permission_epoch + 1'))).toBe(false)
  })

  it.each([
    ['active', 1, CanonicalHtmlLegacyConflictError],
    ['archived', 2, CanonicalHtmlArchivedError],
    ['deleted', 0, CanonicalHtmlDeletedError],
  ])('does not update a %s canonical row through the legacy slug path', async (_label, status, ErrorType) => {
    vi.mocked(query).mockResolvedValueOnce([{ ...existing, octo_doc_slug: 'legacy-slug', status }] as never)
    await expect(docMetaRepo.upsertHtmlByOctoDocSlug(legacy)).rejects.toBeInstanceOf(ErrorType)
    expect(vi.mocked(query).mock.calls.some(([sql]) => /^\s*UPDATE\b/i.test(String(sql)))).toBe(false)
  })

  it('continues to update and revive a genuine legacy slug row', async () => {
    const row = { ...existing, octo_doc_slug: 'legacy-slug', html_idempotency_key_hash: null, status: 0 }
    vi.mocked(query).mockResolvedValueOnce([row] as never)
    tx.query
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ ...row, title: 'Initial title', status: 1 }] as never)
    const result = await docMetaRepo.upsertHtmlByOctoDocSlug(legacy)
    expect(result.created).toBe(false)
    expect(tx.query.mock.calls[0]![0]).toContain('status = 1')
  })
})
