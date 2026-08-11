import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test for the recent-view ingest wired into issueCollabToken, now
// VERIFIED-OR-SKIP (remove-sp §7.1). Every document open — read-only included —
// still passes through collab-token issuance, so this stays the reliable
// "open == viewed" seam. But phase-1 no longer writes an UNVERIFIED viewer Space
// and no longer falls back to the document's home Space: the row lands ONLY when
// the caller is a confirmed ACTIVE member of the viewer Space they supplied
// (X-Space-Id). A missing header / non-member / lookup failure => SKIP the write
// (issuance still succeeds). It must remain fire-and-forget: a failing ingest
// must NOT break token issuance.
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { getByDocId: vi.fn(), getByDocumentName: vi.fn() },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: { getRole: vi.fn() },
}))
vi.mock('../src/db/repos/docViewHistoryRepo.js', () => ({
  docViewHistoryRepo: { upsertViewWithPrune: vi.fn() },
}))

import { issueCollabToken } from '../src/auth/issueCollabToken.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { docViewHistoryRepo } from '../src/db/repos/docViewHistoryRepo.js'
import { setOctoIdentity } from '../src/auth/octoIdentity.js'

const SPACE = '6fd5d5cf10b14d6ebe814b63a856766d'
const FOLDER = 'f_default'
const DOC_ID = 'd_abc123'
const DOC_KEY = `octo:${SPACE}:${FOLDER}:${DOC_ID}`

const docMeta = (ownerId: string) =>
  ({
    doc_id: DOC_ID,
    document_name: DOC_KEY,
    owner_id: ownerId,
    space_id: SPACE,
    folder_id: FOLDER,
    doc_type: 'doc',
    status: 1,
    permission_epoch: 2,
  }) as never

/**
 * Inject an identity for uid, whose isSpaceMember returns `member`. The
 * verified-or-skip write only lands when isSpaceMember confirms the viewer Space.
 */
function asUser(uid: string | null, member = true) {
  setOctoIdentity({
    verifyToken: async (token: string) => (token && uid ? { uid } : null),
    getUser: async () => null,
    getUsers: async () => [],
    isSpaceMember: async () => member,
  })
}

beforeEach(() => {
  vi.mocked(docMetaRepo.getByDocId).mockReset()
  vi.mocked(docMetaRepo.getByDocumentName).mockReset()
  vi.mocked(docMemberRepo.getRole).mockReset()
  vi.mocked(docViewHistoryRepo.upsertViewWithPrune).mockReset()
  vi.mocked(docViewHistoryRepo.upsertViewWithPrune).mockResolvedValue(new Date())
})

describe('issueCollabToken — verified-or-skip recent-view ingest (remove-sp §7.1)', () => {
  it('writes under the CONFIRMED viewer Space (member) with the trusted uid + doc_id', async () => {
    asUser('u_doc', true)
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('reader') // read-only open still counts

    // Caller supplies their current (viewer) Space and IS an active member of it.
    const out = await issueCollabToken('octo_session_doc', DOC_KEY, SPACE)
    expect(out.ok).toBe(true)
    // fire-and-forget: let the .then settle.
    await new Promise((r) => setImmediate(r))
    expect(docViewHistoryRepo.upsertViewWithPrune).toHaveBeenCalledTimes(1)
    const arg = vi.mocked(docViewHistoryRepo.upsertViewWithPrune).mock.calls[0]![0]
    expect(arg.uid).toBe('u_doc')
    expect(arg.docId).toBe(DOC_ID)
    expect(arg.spaceId).toBe(SPACE)
    // retention config is threaded through (defaults 200 / 90).
    expect(typeof arg.retainCount).toBe('number')
    expect(typeof arg.retainDays).toBe('number')
  })

  it('SKIPS the write when NO viewer Space is supplied (no home-Space fallback, §7.1)', async () => {
    asUser('u_doc', true)
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('reader')

    const out = await issueCollabToken('octo_session_doc', DOC_KEY) // no viewerSpaceId
    expect(out.ok).toBe(true)
    await new Promise((r) => setImmediate(r))
    expect(docViewHistoryRepo.upsertViewWithPrune).not.toHaveBeenCalled()
  })

  it('SKIPS the write when the caller is NOT a member of the supplied viewer Space', async () => {
    asUser('u_doc', false) // isSpaceMember => false
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('reader')

    const out = await issueCollabToken('octo_session_doc', DOC_KEY, SPACE)
    expect(out.ok).toBe(true)
    await new Promise((r) => setImmediate(r))
    expect(docViewHistoryRepo.upsertViewWithPrune).not.toHaveBeenCalled()
  })

  it('does NOT ingest when the caller has no role (403 branch)', async () => {
    asUser('stranger', true)
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMemberRepo.getRole).mockResolvedValue(undefined) // none

    const out = await issueCollabToken('octo_session_x', DOC_KEY, SPACE)
    expect(out).toEqual({ ok: false, status: 403, error: 'forbidden' })
    expect(docViewHistoryRepo.upsertViewWithPrune).not.toHaveBeenCalled()
  })

  it('does NOT ingest when the doc is missing (404 branch)', async () => {
    asUser('u_doc', true)
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(null)
    const out = await issueCollabToken('octo_session_doc', DOC_KEY, SPACE)
    expect(out.ok).toBe(false)
    expect(docViewHistoryRepo.upsertViewWithPrune).not.toHaveBeenCalled()
  })

  it('is best-effort: a failing ingest never breaks token issuance', async () => {
    asUser('u_doc', true)
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('reader')
    vi.mocked(docViewHistoryRepo.upsertViewWithPrune).mockRejectedValue(new Error('db down'))

    const out = await issueCollabToken('octo_session_doc', DOC_KEY, SPACE)
    expect(out.ok).toBe(true) // issuance unaffected
    // let the fire-and-forget rejection settle into recordVerifiedRecentView's catch.
    await new Promise((r) => setImmediate(r))
  })
})
