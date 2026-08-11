import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// The ONE disclosure that lets the `/d/:docId` no-access landing page name the document it is asking
// the viewer to request access to: GET /docs/:docId/open-context answers a role=none caller with
// 403 { error: 'forbidden', title }. Without it the page can only say 无法访问此文档 and offer 申请访问 —
// asking for access to something it will not identify.
//
// Product decision (leader). What these tests pin is the BOUNDARY, not a safety argument that does
// not hold here: open-context locates by docId alone and has NO same-space gate, so a 403 on this
// route can reach a caller from any Space or none. The title therefore goes to any holder of the
// docId who already learned the doc exists from getting 403 rather than 404. So the cases below fix
// exactly where the field may and may not appear:
//   - 403 (role=none)      → title present
//   - 404 (missing/deleted/malformed docId) → bare, no title. This is the response that hides a
//     doc's existence; a title on it would hand out the one bit 404 exists to withhold.
//   - 409 (archived)       → bare, and only reachable by an authorized caller anyway
//   - 200 (authorized)     → unchanged full context
//   - blank stored title   → field OMITTED, not `""`, so the client can tell "nothing disclosed"
//     from "the title is empty" and never renders a placeholder as the document's name.
//
// Same isolation as humanDocHeaderMatrix.test.ts: repo + resolveRole mocked, the real router and
// the real human docSpaceScope middleware run.
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { getByDocId: vi.fn() },
  DocOwnershipError: class DocOwnershipError extends Error {},
}))
vi.mock('../src/permission/resolveRole.js', () => ({
  resolveRole: vi.fn(),
  resolveDocMetaByName: vi.fn(),
}))

import { humanDocSpaceScopeMiddleware } from '../src/api/middleware/docSpaceScope.js'
import { documentResourceRouter } from '../src/api/routes/docs.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { resolveRole } from '../src/permission/resolveRole.js'
import { setOctoIdentity } from '../src/auth/octoIdentity.js'

const DOC_ID = 'd_forbidden'
const TITLE = 'Q3 规划'

/** A live (status===1) doc_meta row in space 's_home'. */
function metaRow(over: Record<string, unknown> = {}) {
  return {
    doc_id: DOC_ID,
    document_name: `octo:s_home:f_default:${DOC_ID}`,
    title: TITLE,
    owner_id: 'u_owner',
    space_id: 's_home',
    folder_id: 'f_default',
    doc_type: 'doc',
    status: 1,
    permission_epoch: 7,
    share_scope: 0,
    share_role: 0,
    created_at: new Date(0),
    updated_at: new Date(1000),
    created_by: 'u_owner',
    updated_by: 'u_owner',
    ...over,
  }
}

let server: Server
let base: string

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.uid = 'u_outsider'
    req.octoToken = 'session'
    next()
  })
  app.use(humanDocSpaceScopeMiddleware)
  app.use(documentResourceRouter)
  app.use((_req, res) => { res.status(404).json({ error: 'not_found' }) })
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

beforeEach(() => {
  vi.mocked(docMetaRepo.getByDocId).mockReset()
  vi.mocked(resolveRole).mockReset()
  vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow() as never)
  vi.mocked(resolveRole).mockResolvedValue('none' as never)
  // No Space membership anywhere: the caller cannot reach reader via anyone_in_space either, so
  // role=none is the branch under test rather than an accident of share resolution.
  setOctoIdentity({
    verifyToken: async () => ({ uid: 'u_outsider' }),
    verifyBot: async () => null,
    getUser: async () => null,
    getUsers: async () => [],
    isSpaceMember: async () => false,
  } as never)
})

async function openContext(docId = DOC_ID) {
  const response = await fetch(`${base}/${docId}/open-context`)
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe('open-context 403 names the refused document', () => {
  it('discloses the title to a role=none caller', async () => {
    expect(await openContext()).toEqual({ status: 403, body: { error: 'forbidden', title: TITLE } })
  })

  it('discloses nothing else — no Space, documentName, role, epoch or folder', async () => {
    const { body } = await openContext()
    expect(Object.keys(body).sort()).toEqual(['error', 'title'])
  })

  it('omits the field entirely for a blank stored title, rather than sending ""', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow({ title: '' }) as never)
    const { status, body } = await openContext()
    expect(status).toBe(403)
    expect(body).toEqual({ error: 'forbidden' })
    expect(body).not.toHaveProperty('title')
  })

  it('omits the field for a whitespace-only title — the web side must not render it as a name', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow({ title: '   ' }) as never)
    expect((await openContext()).body).toEqual({ error: 'forbidden' })
  })

  it('omits the field when the stored title is null', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow({ title: null }) as never)
    expect((await openContext()).body).toEqual({ error: 'forbidden' })
  })
})

describe('the disclosure cannot escape the 403', () => {
  it('a missing doc still 404s with no title', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(null as never)
    expect(await openContext()).toEqual({ status: 404, body: { error: 'not_found' } })
  })

  it('a soft-deleted doc still 404s with no title', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow({ status: 0 }) as never)
    expect(await openContext()).toEqual({ status: 404, body: { error: 'not_found' } })
  })

  it('a malformed docId 404s before the repo is ever consulted', async () => {
    expect(await openContext('bad id!')).toEqual({ status: 404, body: { error: 'not_found' } })
    expect(vi.mocked(docMetaRepo.getByDocId)).not.toHaveBeenCalled()
  })

  it('archived still 409s bare, and only after the role gate has passed', async () => {
    vi.mocked(resolveRole).mockResolvedValue('reader' as never)
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow({ status: 2 }) as never)
    expect(await openContext()).toEqual({ status: 409, body: { error: 'conflict' } })
  })

  it('an archived doc a role=none caller asks for is still 403 — status order is unchanged', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow({ status: 2 }) as never)
    const { status, body } = await openContext()
    expect(status).toBe(403)
    expect(body).toEqual({ error: 'forbidden', title: TITLE })
  })

  it('the authorized 200 context is untouched', async () => {
    vi.mocked(resolveRole).mockResolvedValue('reader' as never)
    const { status, body } = await openContext()
    expect(status).toBe(200)
    expect(body).toMatchObject({
      docId: DOC_ID,
      homeSpaceId: 's_home',
      documentName: `octo:s_home:f_default:${DOC_ID}`,
      role: 'reader',
      title: TITLE,
      permissionEpoch: 7,
    })
  })
})
