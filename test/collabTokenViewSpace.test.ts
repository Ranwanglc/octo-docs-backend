import { describe, it, expect, vi, beforeEach } from 'vitest'

// Recent-view space 口径统一, updated for the remove-sp §7.1 verified-or-skip
// contract.
//
// The read side (GET /docs/recent) filters doc_view_history rows by the VIEWER's
// verified current space. The only ingest for a doc opened from a chat share link
// is the collab-token fallback in issueCollabToken. Phase-1 tightens the write:
//
//   - it records under the VIEWER's supplied current space ONLY after confirming
//     the caller is an active member of that space (so it matches the read
//     filter);
//   - it NO LONGER falls back to the document's home space when no viewer space
//     is supplied (or the header is blank / unverified) — it SKIPS the write.
//
// This closes the "unverified header writes an arbitrary space" hole while
// keeping same-space opens (member of their current space) working.
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

// The document lives in its OWN home space; the viewer is currently working in a
// DIFFERENT space (e.g. opened the doc from a chat share link).
const DOC_SPACE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const VIEWER_SPACE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const FOLDER = 'f_default'
const DOC_ID = 'd_share123'
const DOC_KEY = `octo:${DOC_SPACE}:${FOLDER}:${DOC_ID}`

const docMeta = (ownerId: string) =>
  ({
    doc_id: DOC_ID,
    document_name: DOC_KEY,
    owner_id: ownerId,
    space_id: DOC_SPACE,
    folder_id: FOLDER,
    doc_type: 'doc',
    status: 1,
    permission_epoch: 2,
  }) as never

/** Inject an identity for uid whose isSpaceMember returns `member`. */
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

describe('issueCollabToken — verified-or-skip recent-view space (remove-sp §7.1)', () => {
  it('records under the VIEWER current space when membership is CONFIRMED', async () => {
    asUser('u_viewer', true)
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('reader') // read-only share open still counts

    // Viewer opens the shared doc while in VIEWER_SPACE (passed by the caller
    // from the collab-token request's X-Space-Id header) AND is a member of it.
    const out = await issueCollabToken('octo_session_viewer', DOC_KEY, VIEWER_SPACE)
    expect(out.ok).toBe(true)
    await new Promise((r) => setImmediate(r))
    expect(docViewHistoryRepo.upsertViewWithPrune).toHaveBeenCalledTimes(1)
    const arg = vi.mocked(docViewHistoryRepo.upsertViewWithPrune).mock.calls[0]![0]
    expect(arg.uid).toBe('u_viewer')
    expect(arg.docId).toBe(DOC_ID)
    // The write space MUST equal the viewer's verified current space so the read
    // (filtered by X-Space-Id) can return this row — never the doc home space.
    expect(arg.spaceId).toBe(VIEWER_SPACE)
    expect(arg.spaceId).not.toBe(DOC_SPACE)
  })

  it('SKIPS the write (no home-space fallback) when no viewer space is supplied', async () => {
    asUser('u_viewer', true)
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('reader')

    const out = await issueCollabToken('octo_session_viewer', DOC_KEY)
    expect(out.ok).toBe(true)
    await new Promise((r) => setImmediate(r))
    // Phase-1: no fallback to DOC_SPACE — the row is simply not written.
    expect(docViewHistoryRepo.upsertViewWithPrune).not.toHaveBeenCalled()
  })

  it('SKIPS the write for a blank viewer space (no home-space fallback)', async () => {
    asUser('u_viewer', true)
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('reader')

    const out = await issueCollabToken('octo_session_viewer', DOC_KEY, '   ')
    expect(out.ok).toBe(true)
    await new Promise((r) => setImmediate(r))
    expect(docViewHistoryRepo.upsertViewWithPrune).not.toHaveBeenCalled()
  })

  it('SKIPS the write when the viewer is NOT a member of the supplied space', async () => {
    asUser('u_viewer', false) // isSpaceMember => false
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('reader')

    const out = await issueCollabToken('octo_session_viewer', DOC_KEY, VIEWER_SPACE)
    expect(out.ok).toBe(true)
    await new Promise((r) => setImmediate(r))
    expect(docViewHistoryRepo.upsertViewWithPrune).not.toHaveBeenCalled()
  })
})
