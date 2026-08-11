import { describe, it, expect, vi, beforeEach } from 'vitest'

// Route-level regression for the per-route caller-token threading (#64/#68).
//
// Unlike shareRoutes.test.ts (which mocks requireDocRole and so never exercises
// the guard's membership resolution), this suite runs the REAL requireDocRole ->
// resolveEffectiveRole -> isSpaceMember chain and mocks only the layers BELOW it
// (doc_meta / doc_member rows + the octo identity seam). The injected
// isSpaceMember returns true ONLY when the route hands it the caller's session
// token, so a route that forgets `token: req.octoToken` resolves the human to a
// non-member and fails closed to 403 — exactly the bug this change fixes.
//
// Setup: a share-only human (no doc_member row -> direct role 'none') on an
// `anyone_in_space` / edit doc. Pre-fix, comments/versions/attachments/linkCard/
// export/boardExport/GET docs/share-dialog dropped the token and 403'd this human;
// post-fix each route threads it and the human passes the reader/writer gate.
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { getByDocId: vi.fn() },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: { getRole: vi.fn() },
}))
// Downstream repos for the reader routes that cleanly reach 200. They must be
// mocked so the handler bodies past the guard run offline.
vi.mock('../src/db/repos/docCommentRepo.js', () => ({
  docCommentRepo: {
    listRoots: vi.fn(async () => []),
    listRepliesForRoots: vi.fn(async () => []),
  },
}))
vi.mock('../src/db/repos/docVersionRepo.js', () => ({
  docVersionRepo: {
    listByDoc: vi.fn(async () => ({ items: [], nextCursor: null })),
    countsByKind: vi.fn(async () => ({ manual: 0, auto: 0, total: 0 })),
  },
}))
vi.mock('../src/db/repos/docAttachmentRepo.js', () => ({
  docAttachmentRepo: { getById: vi.fn(async () => null) },
}))
// Export goes through the Typst queue immediately after the guard; force the
// slot to be unavailable so the handler returns 503 without touching persistence
// / the typst binary. Keep the real error classes (the handler uses instanceof).
vi.mock('../src/export/typstService.js', async () => {
  const actual = await vi.importActual<typeof import('../src/export/typstService.js')>(
    '../src/export/typstService.js',
  )
  return {
    ...actual,
    acquireSlot: vi.fn(async () => {
      throw new actual.TypstQueueFullError()
    }),
  }
})

import { getDocHandler, getShareHandler } from '../src/api/routes/docs.js'
import { listCommentsHandler } from '../src/api/routes/comments.js'
import { listVersionsHandler, createVersionHandler } from '../src/api/routes/versions.js'
import { readHandler, presignHandler } from '../src/api/routes/attachments.js'
import { linkCardHandler } from '../src/api/routes/linkCard.js'
import { exportPdfHandler } from '../src/api/routes/export.js'
import { exportBoardHandler } from '../src/api/routes/boardExport.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { setOctoIdentity } from '../src/auth/octoIdentity.js'

const DOC = 'd_1'
const SPACE = 's1'
const HUMAN = 'u_share_only' // not the owner, no doc_member row -> direct 'none'
const CALLER_TOKEN = 'human-session-token'

interface MockRes {
  statusCode: number
  body: unknown
  headers: Record<string, string>
  status(c: number): MockRes
  json(b: unknown): MockRes
  setHeader(k: string, v: string): MockRes
  type(t: string): MockRes
  send(b: unknown): MockRes
}
function mockRes(): MockRes {
  return {
    statusCode: 0,
    body: undefined as unknown,
    headers: {},
    status(c: number) {
      this.statusCode = c
      return this
    },
    json(b: unknown) {
      this.body = b
      return this
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v
      return this
    },
    type(_t: string) {
      return this
    },
    send(b: unknown) {
      this.body = b
      return this
    },
  }
}

// An `anyone_in_space` / edit doc so the share path can raise a member to writer.
const anyoneEditMeta = (over: Record<string, unknown> = {}) => ({
  doc_id: DOC,
  document_name: 'octo:s1:f_default:d_1',
  owner_id: 'u_owner',
  space_id: SPACE,
  folder_id: 'f_default',
  doc_type: 'doc',
  status: 1,
  permission_epoch: 1,
  share_scope: 1, // anyone_in_space
  share_role: 2, // edit
  ...over,
})

/** The token the identity seam was last asked to verify membership with. */
let seenToken: string | undefined
/** Inject an identity whose isSpaceMember only confirms the RIGHT token. */
function installIdentity() {
  seenToken = undefined
  setOctoIdentity({
    isSpaceMember: async (_uid: string, _spaceId: string, token: string) => {
      seenToken = token
      return token === CALLER_TOKEN
    },
  } as never)
}

function humanReq(over: Record<string, unknown> = {}) {
  return {
    uid: HUMAN,
    spaceId: SPACE,
    // Human open-context mount policy (remove-sp §6): locate by docId, resolve
    // anyone_in_space membership against the doc home space via req.octoToken.
    docSpaceScope: { mode: 'human' as const },
    params: { docId: DOC },
    query: {},
    body: undefined,
    botToken: undefined,
    octoToken: CALLER_TOKEN,
    ...over,
  } as never
}

beforeEach(() => {
  vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(anyoneEditMeta() as never)
  vi.mocked(docMemberRepo.getRole).mockResolvedValue(null as never) // no direct role
  installIdentity()
})

// Each route is driven to a deterministic point PAST its reader/writer gate.
// `expectStatus` is either an exact 200 (routes with no heavy downstream) or a
// post-guard status the handler settles on offline (404/400/409/503) — the point
// is that it is NEVER 403, and that the membership seam was handed CALLER_TOKEN.
describe('share-only human threads the caller token through every reader/writer route (#68)', () => {
  const cases: Array<{
    name: string
    run: (res: MockRes) => Promise<void>
    expectStatus: number
    gate: 'reader' | 'writer'
  }> = [
    {
      name: 'GET /docs/:docId (share dialog metadata)',
      run: (res) => getDocHandler(humanReq(), res as never),
      expectStatus: 200,
      gate: 'reader',
    },
    {
      name: 'GET /docs/:docId/share',
      run: (res) => getShareHandler(humanReq(), res as never),
      expectStatus: 200,
      gate: 'reader',
    },
    {
      name: 'GET /docs/:docId/comments',
      run: (res) => listCommentsHandler(humanReq(), res as never),
      expectStatus: 200,
      gate: 'reader',
    },
    {
      name: 'GET /docs/:docId/versions',
      run: (res) => listVersionsHandler(humanReq(), res as never),
      expectStatus: 200,
      gate: 'reader',
    },
    {
      name: 'GET /docs/:docId/attachments/:attachId',
      // getById -> null => 404 not_found, which only runs once the guard passed.
      run: (res) => readHandler(humanReq({ params: { docId: DOC, attachId: 'a_missing' } }), res as never),
      expectStatus: 404,
      gate: 'reader',
    },
    {
      name: 'POST /docs/:docId/link-card',
      // Empty body => 400 url_required, reached only past the reader gate.
      run: (res) => linkCardHandler(humanReq({ body: {} }), res as never),
      expectStatus: 400,
      gate: 'reader',
    },
    {
      name: 'POST /docs/:docId/export/pdf',
      // Queue forced full => 503 export_busy, reached only past the reader gate.
      run: (res) => exportPdfHandler(humanReq({ body: {} }), res as never),
      expectStatus: 503,
      gate: 'reader',
    },
    {
      name: 'GET /docs/:docId/export (board)',
      // doc_type 'doc' (not a whiteboard) => 409 unsupported_doc_type, past gate.
      run: (res) => exportBoardHandler(humanReq({ query: { format: 'svg' } }), res as never),
      expectStatus: 409,
      gate: 'reader',
    },
    {
      name: 'POST /docs/:docId/versions (writer gate)',
      // Invalid label => 400 invalid_name, reached only past the WRITER gate
      // (a share edit member must resolve to writer here).
      run: (res) => createVersionHandler(humanReq({ body: { label: 123 } }), res as never),
      expectStatus: 400,
      gate: 'writer',
    },
    {
      name: 'POST /docs/:docId/attachments/presign (writer gate)',
      // Missing fileName => 400, reached only past the WRITER gate.
      run: (res) => presignHandler(humanReq({ body: {} }), res as never),
      expectStatus: 400,
      gate: 'writer',
    },
  ]

  for (const c of cases) {
    it(`${c.name} — ${c.gate} gate lets the share-only human through (not 403)`, async () => {
      const res = mockRes()
      await c.run(res)
      expect(res.statusCode).not.toBe(403)
      expect(res.statusCode).toBe(c.expectStatus)
      // The crux: the route handed the human's session token to the membership
      // seam. Without `token: req.octoToken`, this would be '' and the human
      // would fail closed to a non-member (403 above).
      expect(seenToken).toBe(CALLER_TOKEN)
    })
  }
})

// Fail-closed control: when NO token reaches the seam (the pre-fix behavior a
// dropped `token: req.octoToken` reproduces), the same share-only human is 403.
describe('the reader gate fails closed to 403 when the caller token is not threaded (#68)', () => {
  it('GET /docs/:docId 403s the share-only human when octoToken is absent', async () => {
    const res = mockRes()
    await getDocHandler(humanReq({ octoToken: undefined }), res as never)
    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({ error: 'forbidden' })
    expect(seenToken).toBe('') // resolveEffectiveRole coalesces undefined -> ''
  })
})
