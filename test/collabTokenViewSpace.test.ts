import { describe, it, expect, vi, beforeEach } from 'vitest'

// XIN-1237 — recent-view space 口径统一 (write/read space must agree).
//
// The read side (GET /docs/recent) filters doc_view_history rows by the VIEWER's
// CURRENT space (the X-Space-Id header). For a doc opened from a chat share link
// the standalone page never calls POST /docs/{id}/view; the only ingest is the
// collab-token fallback in issueCollabToken. If that fallback records the row
// under the DOCUMENT's home space (meta.space_id) instead of the viewer's current
// space, the read-by-current-space never returns it — exactly the bug from
// XIN-1234.
//
// Contract asserted here: when the collab-token request carries the viewer's
// current space, the fallback ingest MUST record under THAT space (so it matches
// the read filter). When it does not (legacy client), it falls back to the
// document's home space — no regression for same-space opens.
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

function asUser(uid: string | null, isSpaceMember?: (u: string, s: string, t: string) => Promise<boolean>) {
  // Wrap the membership resolver in a spy so negative tests can assert the
  // POSITIVE sentinel "the gate was actually reached" (isSpaceMember called),
  // proving the drain waited past the decision point rather than asserting early.
  const spy = vi.fn(isSpaceMember ?? (async () => true))
  setOctoIdentity({
    verifyToken: async (token: string) => (token && uid ? { uid } : null),
    getUser: async () => null,
    getUsers: async () => [],
    // Default: viewer is a member of any space we ask about, unless a test
    // overrides this to model a non-member / failing lookup. Callers whose
    // assertions do not depend on membership keep the permissive default.
    isSpaceMember: spy,
  } as never)
  return spy
}

beforeEach(() => {
  vi.mocked(docMetaRepo.getByDocId).mockReset()
  vi.mocked(docMetaRepo.getByDocumentName).mockReset()
  vi.mocked(docMemberRepo.getRole).mockReset()
  vi.mocked(docViewHistoryRepo.upsertViewWithPrune).mockReset()
  vi.mocked(docViewHistoryRepo.upsertViewWithPrune).mockResolvedValue(new Date())
})

// The ingest fires inside a NON-AWAITED async block whose depth (number of
// awaits before upsertViewWithPrune) is an implementation detail: today it is
// `await isSpaceMember -> await upsert`, but a future refactor could add layers.
// A fixed 2x setImmediate flush would then resolve BEFORE the write decision and
// silently turn every `not.toHaveBeenCalled()` into a vacuous pass. Instead we
// drain the event loop until it is idle (N iterations, N chosen far larger than
// any plausible await depth) so the block fully settles regardless of depth.
// Negative assertions additionally carry a positive SENTINEL (isSpaceMember was
// called / the block ran) so "nothing happened" can never be mistaken for
// "we asserted too early".
async function drainMicrotasks(iterations = 10) {
  for (let i = 0; i < iterations; i++) {
    await new Promise((r) => setImmediate(r))
  }
}

describe('issueCollabToken — recent-view space 口径统一 (XIN-1237)', () => {
  it('records the view under the VIEWER current space, not the document home space', async () => {
    asUser('u_viewer')
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('reader') // read-only share open still counts

    // Viewer opens the shared doc while in VIEWER_SPACE (passed by the caller
    // from the collab-token request's X-Space-Id header).
    const out = await issueCollabToken('octo_session_viewer', DOC_KEY, VIEWER_SPACE)
    expect(out.ok).toBe(true)
    await vi.waitFor(() => expect(docViewHistoryRepo.upsertViewWithPrune).toHaveBeenCalledTimes(1))
    const arg = vi.mocked(docViewHistoryRepo.upsertViewWithPrune).mock.calls[0]![0]
    expect(arg.uid).toBe('u_viewer')
    expect(arg.docId).toBe(DOC_ID)
    // The write space MUST equal the viewer's current space so the read
    // (filtered by X-Space-Id) can return this row. This is the bug fix.
    expect(arg.spaceId).toBe(VIEWER_SPACE)
    expect(arg.spaceId).not.toBe(DOC_SPACE)
  })

  it('falls back to the document home space when no viewer space is supplied (legacy client, no regression)', async () => {
    asUser('u_viewer')
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('reader')

    const out = await issueCollabToken('octo_session_viewer', DOC_KEY)
    expect(out.ok).toBe(true)
    await vi.waitFor(() => expect(docViewHistoryRepo.upsertViewWithPrune).toHaveBeenCalledTimes(1))
    const arg = vi.mocked(docViewHistoryRepo.upsertViewWithPrune).mock.calls[0]![0]
    expect(arg.spaceId).toBe(DOC_SPACE)
  })

  it('ignores an empty viewer space and falls back to the document home space', async () => {
    asUser('u_viewer')
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('reader')

    const out = await issueCollabToken('octo_session_viewer', DOC_KEY, '   ')
    expect(out.ok).toBe(true)
    await vi.waitFor(() => expect(docViewHistoryRepo.upsertViewWithPrune).toHaveBeenCalledTimes(1))
    const arg = vi.mocked(docViewHistoryRepo.upsertViewWithPrune).mock.calls[0]![0]
    expect(arg.spaceId).toBe(DOC_SPACE)
  })

  // --- membership gate on the viewer header space (space-guard fix) ---

  it('① writes under the viewer space when the viewer is a REAL member of it', async () => {
    // Explicit member override for clarity (default is also true).
    asUser('u_viewer', async (_u, s) => s === VIEWER_SPACE)
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('reader')

    const out = await issueCollabToken('octo_session_viewer', DOC_KEY, VIEWER_SPACE)
    expect(out.ok).toBe(true)
    await vi.waitFor(() => expect(docViewHistoryRepo.upsertViewWithPrune).toHaveBeenCalledTimes(1))
    expect(vi.mocked(docViewHistoryRepo.upsertViewWithPrune).mock.calls[0]![0].spaceId).toBe(VIEWER_SPACE)
  })

  it('② does NOT write at all when the viewer is NOT a member of the header space (no fallback to home space)', async () => {
    const member = asUser('u_viewer', async () => false) // not a member of anything
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('reader') // has doc access, but not space member

    const out = await issueCollabToken('octo_session_viewer', DOC_KEY, VIEWER_SPACE)
    expect(out.ok).toBe(true) // token still issued (doc role is enough)
    // Drain to idle, then SENTINEL: the gate was actually evaluated (isSpaceMember
    // ran). This makes the negative assertion meaningful — it fires only after
    // "everything that should happen has happened", not because we asserted early.
    await drainMicrotasks()
    await vi.waitFor(() => expect(member).toHaveBeenCalledWith('u_viewer', VIEWER_SPACE, expect.anything()))
    // Strict policy: a non-member header must NOT write, and must NOT fall back
    // to meta.space_id either.
    expect(docViewHistoryRepo.upsertViewWithPrune).not.toHaveBeenCalled()
  })

  it('③ skips the write but still issues the token (200) when the membership lookup REJECTS', async () => {
    const member = asUser('u_viewer', async () => {
      throw new Error('identity service down')
    })
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('reader')

    const out = await issueCollabToken('octo_session_viewer', DOC_KEY, VIEWER_SPACE)
    expect(out.ok).toBe(true) // issuance unaffected by the best-effort ingest
    await drainMicrotasks()
    await vi.waitFor(() => expect(member).toHaveBeenCalledWith('u_viewer', VIEWER_SPACE, expect.anything()))
    expect(docViewHistoryRepo.upsertViewWithPrune).not.toHaveBeenCalled()
  })

  it('⑤ does NOT write when header === meta.space_id but the viewer is not a member (no "equal ⇒ skip check" shortcut)', async () => {
    // Viewer opens the doc while in its HOME space, but is not actually a member
    // of that space (e.g. only a direct doc_member / invited reader). The equal-
    // space case must STILL be gated by isSpaceMember, not written blindly.
    const member = asUser('u_viewer', async () => false)
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('reader') // doc access, non-member

    // meta.share_scope is NOT anyone_in_space here, so the issuance-time
    // spaceMember probe never ran (spaceMember stays false) — the fix must not
    // treat that unset `false` as "confirmed member" and must not treat
    // header===home as an auto-pass.
    const out = await issueCollabToken('octo_session_viewer', DOC_KEY, DOC_SPACE)
    expect(out.ok).toBe(true)
    await drainMicrotasks()
    await vi.waitFor(() => expect(member).toHaveBeenCalledWith('u_viewer', DOC_SPACE, expect.anything()))
    expect(docViewHistoryRepo.upsertViewWithPrune).not.toHaveBeenCalled()
  })
})
