import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test for the FEAT-B MF2 fallback ingest wired into
// issueCollabToken: every document open — read-only included — goes through the
// collab-token issuance, so a best-effort UPSERT here guarantees "open == viewed"
// even if the front-end never calls POST /docs/{id}/view. It must be
// fire-and-forget: fired only on the authorized (role != none) branch, and a
// failing ingest must NOT break token issuance.
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

function asUser(uid: string | null) {
  setOctoIdentity({
    verifyToken: async (token: string) => (token && uid ? { uid } : null),
    getUser: async () => null,
    getUsers: async () => [],
  })
}

beforeEach(() => {
  vi.mocked(docMetaRepo.getByDocId).mockReset()
  vi.mocked(docMetaRepo.getByDocumentName).mockReset()
  vi.mocked(docMemberRepo.getRole).mockReset()
  vi.mocked(docViewHistoryRepo.upsertViewWithPrune).mockReset()
  vi.mocked(docViewHistoryRepo.upsertViewWithPrune).mockResolvedValue(new Date())
})

// The ingest fires inside a NON-AWAITED async block whose await-depth before
// upsertViewWithPrune is an implementation detail. A fixed 2x setImmediate flush
// would silently become vacuous if a future refactor adds an await layer, turning
// the negative `not.toHaveBeenCalled()` assertions into always-pass. Drain the
// event loop to idle (N far exceeds any plausible depth) so the block fully
// settles regardless of depth.
async function drainMicrotasks(iterations = 10) {
  for (let i = 0; i < iterations; i++) {
    await new Promise((r) => setImmediate(r))
  }
}

describe('issueCollabToken — MF2 recent-view fallback ingest', () => {
  it('fires a best-effort UPSERT with the trusted uid + doc_id + space_id on the authorized branch', async () => {
    asUser('u_doc')
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('reader') // read-only open still counts

    const out = await issueCollabToken('octo_session_doc', DOC_KEY)
    expect(out.ok).toBe(true)
    await vi.waitFor(() => expect(docViewHistoryRepo.upsertViewWithPrune).toHaveBeenCalledTimes(1))
    const arg = vi.mocked(docViewHistoryRepo.upsertViewWithPrune).mock.calls[0]![0]
    expect(arg.uid).toBe('u_doc')
    expect(arg.docId).toBe(DOC_ID)
    expect(arg.spaceId).toBe(SPACE)
    // retention config is threaded through (defaults 200 / 90).
    expect(typeof arg.retainCount).toBe('number')
    expect(typeof arg.retainDays).toBe('number')
  })

  it('does NOT ingest when the caller has no role (403 branch)', async () => {
    asUser('stranger')
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMemberRepo.getRole).mockResolvedValue(undefined) // none

    const out = await issueCollabToken('octo_session_x', DOC_KEY)
    expect(out).toEqual({ ok: false, status: 403, error: 'forbidden' })
    // The 403 result above IS the sentinel that issuance ran to its terminal
    // (pre-ingest) decision; draining then confirms no deferred write appears.
    await drainMicrotasks()
    expect(docViewHistoryRepo.upsertViewWithPrune).not.toHaveBeenCalled()
  })

  it('does NOT ingest when the doc is missing (404 branch)', async () => {
    asUser('u_doc')
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(null)
    const out = await issueCollabToken('octo_session_doc', DOC_KEY)
    expect(out.ok).toBe(false)
    // 404 result is the sentinel that issuance reached its terminal decision.
    await drainMicrotasks()
    expect(docViewHistoryRepo.upsertViewWithPrune).not.toHaveBeenCalled()
  })

  it('is best-effort: a failing ingest never breaks token issuance', async () => {
    asUser('u_doc')
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('reader')
    vi.mocked(docViewHistoryRepo.upsertViewWithPrune).mockRejectedValue(new Error('db down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const out = await issueCollabToken('octo_session_doc', DOC_KEY)
    expect(out.ok).toBe(true) // issuance unaffected
    // let the fire-and-forget rejection settle into its .catch (warn).
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    warn.mockRestore()
  })
})
