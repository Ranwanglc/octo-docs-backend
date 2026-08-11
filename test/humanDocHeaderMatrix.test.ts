import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { getByDocId: vi.fn() },
  DocOwnershipError: class DocOwnershipError extends Error {},
}))
vi.mock('../src/permission/resolveRole.js', () => ({
  resolveRole: vi.fn(),
  resolveDocMetaByName: vi.fn(),
}))
vi.mock('../src/db/repos/docAccessRequestRepo.js', () => ({
  REQUEST_STATUS_PENDING: 0,
  REQUEST_STATUS_APPROVED: 1,
  REQUEST_STATUS_DENIED: 2,
  docAccessRequestRepo: { submit: vi.fn(async () => ({ requestId: 'r_1' })) },
}))
vi.mock('../src/api/services/docsNotify.js', () => ({ notifyDocAccessRequested: vi.fn(async () => undefined) }))

import { humanDocSpaceScopeMiddleware } from '../src/api/middleware/docSpaceScope.js'
import { documentResourceRouter } from '../src/api/routes/docs.js'
import { membersRouter } from '../src/api/routes/members.js'
import { forwardGrantRouter } from '../src/api/routes/forwardGrant.js'
import { accessRequestsRouter } from '../src/api/routes/accessRequests.js'
import { invitesRouter } from '../src/api/routes/invites.js'
import { attachmentsRouter } from '../src/api/routes/attachments.js'
import { linkCardRouter } from '../src/api/routes/linkCard.js'
import { commentsRouter } from '../src/api/routes/comments.js'
import { versionsRouter } from '../src/api/routes/versions.js'
import { docContentRouter } from '../src/api/routes/docContent.js'
import { docSheetRouter } from '../src/api/routes/docSheet.js'
import { docSceneRouter } from '../src/api/routes/docScene.js'
import { exportRouter } from '../src/api/routes/export.js'
import { boardExportRouter } from '../src/api/routes/boardExport.js'
import { importRouter } from '../src/api/routes/import.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { resolveRole } from '../src/permission/resolveRole.js'
import { docAccessRequestRepo } from '../src/db/repos/docAccessRequestRepo.js'
import { setOctoIdentity } from '../src/auth/octoIdentity.js'
import { verifyCollabToken } from '../src/auth/collabToken.js'

const DOC_ID = 'd_matrix'
const meta = {
  doc_id: DOC_ID,
  document_name: 'octo:s_home:f_default:d_matrix',
  title: 'Secret title',
  owner_id: 'u_owner',
  space_id: 's_home',
  folder_id: 'f_default',
  doc_type: 'doc',
  status: 1,
  permission_epoch: 3,
  share_scope: 0,
  share_role: 0,
}

const routes = [
  ['metadata get', 'GET', `/${DOC_ID}`],
  ['metadata rename', 'PATCH', `/${DOC_ID}`],
  ['metadata delete', 'DELETE', `/${DOC_ID}`],
  ['view record', 'POST', `/${DOC_ID}/view`],
  ['share get', 'GET', `/${DOC_ID}/share`],
  ['share update', 'PUT', `/${DOC_ID}/share`],
  ['members list', 'GET', `/${DOC_ID}/members`],
  ['members upsert', 'PUT', `/${DOC_ID}/members`],
  ['members remove', 'DELETE', `/${DOC_ID}/members/u_2`],
  ['forward grant', 'POST', `/${DOC_ID}/forward-grant`],
  ['access-request list', 'GET', `/${DOC_ID}/access-requests`],
  ['access-request approve', 'POST', `/${DOC_ID}/access-requests/r_1/approve`],
  ['access-request deny', 'POST', `/${DOC_ID}/access-requests/r_1/deny`],
  ['invites list', 'GET', `/${DOC_ID}/invites`],
  ['invites create', 'POST', `/${DOC_ID}/invites`],
  ['invites revoke', 'DELETE', `/${DOC_ID}/invites/invite_1`],
  ['attachments get', 'GET', `/${DOC_ID}/attachments/a_1`],
  ['attachments presign', 'POST', `/${DOC_ID}/attachments/presign`],
  ['attachments svg', 'POST', `/${DOC_ID}/attachments/svg`],
  ['attachments resolve', 'POST', `/${DOC_ID}/attachments/resolve`],
  ['attachments copy', 'POST', `/${DOC_ID}/attachments/copy`],
  ['attachments ingest', 'POST', `/${DOC_ID}/attachments/ingest`],
  ['link-card', 'POST', `/${DOC_ID}/link-card`],
  ['comments list', 'GET', `/${DOC_ID}/comments`],
  ['comments markers', 'GET', `/${DOC_ID}/comments/markers`],
  ['comments thread', 'GET', `/${DOC_ID}/comments/c_1/thread`],
  ['comments create', 'POST', `/${DOC_ID}/comments`],
  ['comments update', 'PATCH', `/${DOC_ID}/comments/c_1`],
  ['comments delete', 'DELETE', `/${DOC_ID}/comments/c_1`],
  ['versions list', 'GET', `/${DOC_ID}/versions`],
  ['versions create', 'POST', `/${DOC_ID}/versions`],
  ['versions state', 'GET', `/${DOC_ID}/versions/v_1/state`],
  ['versions rename', 'PATCH', `/${DOC_ID}/versions/v_1`],
  ['versions delete', 'DELETE', `/${DOC_ID}/versions/v_1`],
  ['versions restore', 'POST', `/${DOC_ID}/versions/v_1/restore`],
  ['content get', 'GET', `/${DOC_ID}/content`],
  ['content patch', 'PATCH', `/${DOC_ID}/content`],
  ['sheet get', 'GET', `/${DOC_ID}/sheet`],
  ['sheet patch', 'PATCH', `/${DOC_ID}/sheet`],
  ['scene get', 'GET', `/${DOC_ID}/scene`],
  ['scene patch', 'PATCH', `/${DOC_ID}/scene`],
  ['PDF export', 'POST', `/${DOC_ID}/export/pdf`],
  ['file export', 'GET', `/${DOC_ID}/export/file?format=md`],
  ['board export', 'GET', `/${DOC_ID}/export?format=svg`],
  ['Excalidraw import', 'POST', `/${DOC_ID}/import/excalidraw`],
  ['DOCX import', 'POST', `/${DOC_ID}/import/docx`],
  ['Markdown import', 'POST', `/${DOC_ID}/import/markdown`],
  ['XLSX import', 'POST', `/${DOC_ID}/import/xlsx`],
] as const

let server: Server
let base: string

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.uid = 'u_none'
    req.octoToken = 'session'
    next()
  })
  app.use(humanDocSpaceScopeMiddleware)
  app.use(documentResourceRouter)
  app.use(membersRouter)
  app.use(forwardGrantRouter)
  app.use(accessRequestsRouter)
  app.use(invitesRouter)
  app.use(attachmentsRouter)
  app.use(linkCardRouter)
  app.use(commentsRouter)
  app.use(versionsRouter)
  app.use(docContentRouter)
  app.use(docSheetRouter)
  app.use(docSceneRouter)
  app.use(exportRouter)
  app.use(boardExportRouter)
  app.use(importRouter)
  app.use((_req, res) => { res.status(404).json({ error: 'not_found' }) })
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

beforeEach(() => {
  vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta as never)
  vi.mocked(resolveRole).mockResolvedValue('none')
  vi.mocked(docAccessRequestRepo.submit).mockClear()
  setOctoIdentity({
    verifyToken: async () => ({ uid: 'u_none' }),
    verifyBot: async () => null,
    getUser: async () => null,
    getUsers: async () => [],
    isSpaceMember: async () => false,
  })
})

function headers(space: 'missing' | 'correct' | 'wrong'): Record<string, string> {
  if (space === 'missing') return { 'content-type': 'application/json' }
  return { 'content-type': 'application/json', 'X-Space-Id': space === 'correct' ? 's_home' : 's_spoofed' }
}

async function request(method: string, path: string, space: 'missing' | 'correct' | 'wrong') {
  const needsBody = !['GET', 'HEAD'].includes(method)
  const response = await fetch(`${base}${path}`, {
    method,
    headers: headers(space),
    ...(needsBody ? { body: '{}' } : {}),
  })
  return { status: response.status, body: await response.json() }
}

describe('Human single-document X-Space-Id tri-state router matrix (remove-sp Step 2)', () => {
  it.each(routes)('%s has identical authorization with missing/correct/wrong headers', async (_name, method, path) => {
    const outcomes = await Promise.all([
      request(method, path, 'missing'),
      request(method, path, 'correct'),
      request(method, path, 'wrong'),
    ])
    expect(outcomes).toEqual([
      { status: 403, body: { error: 'forbidden' } },
      { status: 403, body: { error: 'forbidden' } },
      { status: 403, body: { error: 'forbidden' } },
    ])
  })

  it.each(['missing', 'correct', 'wrong'] as const)('authorized metadata GET is header-independent with %s header', async (space) => {
    vi.mocked(resolveRole).mockResolvedValue('reader')
    expect(await request('GET', `/${DOC_ID}`, space)).toEqual({
      status: 200,
      body: expect.objectContaining({ docId: DOC_ID, spaceId: 's_home', role: 'reader' }),
    })
  })

  it.each(['PATCH', 'DELETE'] as const)('human %s /octo-doc/:slug is not exposed', async (method) => {
    vi.mocked(resolveRole).mockResolvedValue('admin')
    expect(await request(method, '/octo-doc/html-slug-1', 'correct'))
      .toEqual({ status: 404, body: { error: 'not_found' } })
  })

  it.each(['missing', 'correct', 'wrong'] as const)('open-context returns non-leaking 403 with %s header', async (space) => {
    const outcome = await request('GET', `/${DOC_ID}/open-context`, space)
    expect(outcome).toEqual({ status: 403, body: { error: 'forbidden' } })
    expect(outcome.body).not.toHaveProperty('title')
    expect(outcome.body).not.toHaveProperty('homeSpaceId')
    expect(outcome.body).not.toHaveProperty('documentName')
  })

  it.each(['missing', 'correct', 'wrong'] as const)('docId collab-token returns non-leaking 403 with %s header', async (space) => {
    expect(await request('POST', `/${DOC_ID}/collab-token`, space))
      .toEqual({ status: 403, body: { error: 'forbidden' } })
  })

  it('access-request submit is header-independent on the Human mount', async () => {
    const outcomes = await Promise.all([
      request('POST', `/${DOC_ID}/access-requests`, 'missing'),
      request('POST', `/${DOC_ID}/access-requests`, 'correct'),
      request('POST', `/${DOC_ID}/access-requests`, 'wrong'),
    ])
    expect(outcomes).toEqual([
      { status: 201, body: { requestId: 'r_1', status: 'pending' } },
      { status: 201, body: { requestId: 'r_1', status: 'pending' } },
      { status: 201, body: { requestId: 'r_1', status: 'pending' } },
    ])
  })

  it.each(['missing', 'correct', 'wrong'] as const)('open-context returns 404 without metadata for a missing doc with %s header', async (space) => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(null as never)
    expect(await request('GET', `/${DOC_ID}/open-context`, space))
      .toEqual({ status: 404, body: { error: 'not_found' } })
  })

  it.each(['missing', 'correct', 'wrong'] as const)('open-context reveals archived state only to an authorized caller with %s header', async (space) => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({ ...meta, status: 2 } as never)
    vi.mocked(resolveRole).mockResolvedValue('reader')
    expect(await request('GET', `/${DOC_ID}/open-context`, space))
      .toEqual({ status: 409, body: { error: 'conflict' } })
  })

  it('docId collab-token uses canonical DB claims and rejects archived documents', async () => {
    vi.mocked(resolveRole).mockResolvedValue('admin')
    const issued = await request('POST', `/${DOC_ID}/collab-token`, 'wrong')
    expect(issued.status).toBe(200)
    const claims = verifyCollabToken((issued.body as { token: string }).token)
    expect(claims).toMatchObject({
      ver: 2,
      docId: DOC_ID,
      documentName: meta.document_name,
      homeSpaceId: meta.space_id,
      role: 'admin',
      permission_epoch: meta.permission_epoch,
    })

    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue({ ...meta, status: 2 } as never)
    expect(await request('POST', `/${DOC_ID}/collab-token`, 'missing'))
      .toEqual({ status: 409, body: { error: 'conflict' } })
  })
})
