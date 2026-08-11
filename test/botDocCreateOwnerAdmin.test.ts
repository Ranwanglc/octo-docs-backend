import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// Integration test for the bot doc-create owner-grant (XIN-576): when a bot
// creates a doc via POST /v1/bot/docs, the bot's human owner (robot.creator_uid,
// surfaced by verifyBot as ownerUid) must be auto-added as an admin member so the
// owner can see the doc. The repos and epoch broadcast are mocked so no MySQL /
// Redis is needed; the create handler and both mounts run for real.
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  // Mirror the real typed error so the handler's `instanceof DocOwnershipError`
  // branch (403 mapping) is exercised against the same constructor the test throws.
  DocOwnershipError: class DocOwnershipError extends Error {
    constructor(message = 'forbidden') {
      super(message)
      this.name = 'DocOwnershipError'
    }
  },
  CanonicalHtmlDeletedError: class CanonicalHtmlDeletedError extends Error {},
  CanonicalHtmlArchivedError: class CanonicalHtmlArchivedError extends Error {},
  CanonicalHtmlLegacyConflictError: class CanonicalHtmlLegacyConflictError extends Error {},
  docMetaRepo: {
    create: vi.fn(async () => undefined),
    getByDocId: vi.fn(async () => ({ title: 'T', created_at: new Date(0) })),
    getByOctoDocSlug: vi.fn(async () => null),
    upsertHtmlByOctoDocSlug: vi.fn(async (input) => ({
      meta: {
        doc_id: input.docId,
        document_name: input.documentName,
        title: input.title,
        owner_id: input.ownerId,
        space_id: input.spaceId,
        folder_id: input.folderId,
        doc_type: input.docType,
        octo_doc_slug: input.octoDocSlug,
        status: 1,
        permission_epoch: 0,
        created_at: new Date(0),
        updated_at: new Date(0),
        created_by: input.createdBy,
        updated_by: '',
      },
      created: true,
    })),
    createCanonicalHtml: vi.fn(),
    listForUser: vi.fn(async () => ({ total: 0, items: [] })),
    rename: vi.fn(async () => undefined),
    softDelete: vi.fn(async () => ({ documentName: 'octo:s_1:f_default:html:d_html', permissionEpoch: 1 })),
  },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: {
    upsertDirect: vi.fn(async () => undefined),
  },
}))
// Stub the epoch side-effects (Redis publish) — the create path calls bumpEpoch
// after adding the owner; we only assert it fires, not its broadcast.
vi.mock('../src/permission/epoch.js', () => ({
  bumpEpoch: vi.fn(async () => 1),
  refreshAndPublish: vi.fn(async () => undefined),
}))
const { enqueueDocIndexMock } = vi.hoisted(() => ({
  enqueueDocIndexMock: vi.fn(async () => true),
}))
vi.mock('../src/search/docIndexQueue.js', () => ({
  enqueueDocIndex: enqueueDocIndexMock,
  isSearchIndexedDoc: vi.fn(() => true),
}))

import { createApp } from '../src/api/app.js'
import { createDocHandler } from '../src/api/routes/docs.js'
import { setOctoIdentity, type OctoIdentity, type OctoUser } from '../src/auth/octoIdentity.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { bumpEpoch } from '../src/permission/epoch.js'
import { refreshAndPublish } from '../src/permission/epoch.js'
import { ROLE_ADMIN } from '../src/permission/role.js'
import { CanonicalHtmlDeletedError, DocOwnershipError } from '../src/db/repos/docMetaRepo.js'
import { config } from '../src/config/env.js'

const upsertDirect = vi.mocked(docMemberRepo.upsertDirect)
const create = vi.mocked(docMetaRepo.create)
const upsertHtmlByOctoDocSlug = vi.mocked(docMetaRepo.upsertHtmlByOctoDocSlug)
const createCanonicalHtml = vi.mocked(docMetaRepo.createCanonicalHtml)
const getByDocId = vi.mocked(docMetaRepo.getByDocId)
const getByOctoDocSlug = vi.mocked(docMetaRepo.getByOctoDocSlug)
const listForUser = vi.mocked(docMetaRepo.listForUser)
const rename = vi.mocked(docMetaRepo.rename)
const softDelete = vi.mocked(docMetaRepo.softDelete)
const bumpEpochMock = vi.mocked(bumpEpoch)
const refreshAndPublishMock = vi.mocked(refreshAndPublish)

function stub(overrides: Partial<OctoIdentity>): OctoIdentity {
  return {
    verifyToken: async () => null,
    verifyBot: async () => null,
    getUser: async (): Promise<OctoUser | null> => null,
    getUserAsBot: async (): Promise<OctoUser | null> => null,
    getUsers: async (): Promise<OctoUser[]> => [],
    // Fail-closed default, matching the production gate: a test must opt IN to
    // membership to exercise a human-mount happy path.
    isSpaceMember: async () => false,
    ...overrides,
  }
}

let server: Server
let base: string

function mockHandlerRes() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this },
    json(body: unknown) { this.body = body; return this },
  }
}

beforeAll(async () => {
  const app = createApp()
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
})

beforeEach(() => {
  upsertDirect.mockClear()
  create.mockClear()
  upsertHtmlByOctoDocSlug.mockClear()
  createCanonicalHtml.mockReset()
  getByDocId.mockClear()
  getByOctoDocSlug.mockClear()
  listForUser.mockClear()
  rename.mockClear()
  softDelete.mockClear()
  bumpEpochMock.mockClear()
  refreshAndPublishMock.mockClear()
  enqueueDocIndexMock.mockClear()
  ;(config as unknown as { search: { indexEnabled: boolean } }).search.indexEnabled = false
  getByDocId.mockResolvedValue({ title: 'T', created_at: new Date(0) } as never)
  getByOctoDocSlug.mockResolvedValue(null as never)
  listForUser.mockResolvedValue({ total: 0, items: [] } as never)
})

describe('bot doc create auto-grants the bot owner admin (XIN-576)', () => {
  it('adds the bot owner as an admin member when the bot creates a doc', async () => {
    setOctoIdentity(
      stub({ verifyBot: async () => ({ uid: 's_tmos_bot', spaceId: 's_1', ownerUid: 'u_human' }) }),
    )
    const res = await fetch(`${base}/v1/bot/docs`, {
      method: 'POST',
      headers: { authorization: 'Bearer bot-tok', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Bot Doc' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { docId: string; ownerId: string }
    // Doc owner is still the bot (existing behavior unchanged).
    expect(body.ownerId).toBe('s_tmos_bot')
    // The human owner was added as an admin member on top.
    expect(upsertDirect).toHaveBeenCalledTimes(1)
    expect(upsertDirect.mock.calls[0]![0]).toMatchObject({
      docId: body.docId,
      uid: 'u_human',
      roleNum: ROLE_ADMIN,
      grantedBy: 's_tmos_bot',
    })
    // Membership change bumps the epoch for the added owner.
    expect(bumpEpochMock).toHaveBeenCalledTimes(1)
    expect(bumpEpochMock.mock.calls[0]![2]).toBe('u_human')
  })

  it('skips the grant when the bot has no distinct human owner (owner == bot)', async () => {
    setOctoIdentity(
      stub({ verifyBot: async () => ({ uid: 's_plat_bot', spaceId: 's_1', ownerUid: 's_plat_bot' }) }),
    )
    const res = await fetch(`${base}/v1/bot/docs`, {
      method: 'POST',
      headers: { authorization: 'Bearer bot-tok', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Platform Doc' }),
    })
    expect(res.status).toBe(201)
    expect(upsertDirect).not.toHaveBeenCalled()
    expect(bumpEpochMock).not.toHaveBeenCalled()
  })

  it('skips the grant when the bot has no human owner at all (ownerUid absent)', async () => {
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 's_bot', spaceId: 's_1' }) }))
    const res = await fetch(`${base}/v1/bot/docs`, {
      method: 'POST',
      headers: { authorization: 'Bearer bot-tok', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'No Owner Doc' }),
    })
    expect(res.status).toBe(201)
    expect(upsertDirect).not.toHaveBeenCalled()
    expect(bumpEpochMock).not.toHaveBeenCalled()
  })

  it('does not grant on the human create path (owner is already the creator)', async () => {
    // Human mount: X-Space-Id is gated on a confirmed space membership
    // (spaceContextMiddleware), so this path needs isSpaceMember => true to
    // reach the create handler at all.
    setOctoIdentity(stub({ verifyToken: async () => ({ uid: 'u_1' }), isSpaceMember: async () => true }))
    const res = await fetch(`${base}/api/v1/docs`, {
      method: 'POST',
      headers: { token: 'user-tok', 'X-Space-Id': 's_human', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Human Doc' }),
    })
    expect(res.status).toBe(201)
    expect(create).toHaveBeenCalledTimes(1)
    // No botOwnerUid on the human path => no extra member write, no epoch bump.
    expect(upsertDirect).not.toHaveBeenCalled()
    expect(bumpEpochMock).not.toHaveBeenCalled()
  })
})

describe('bot html doc registration', () => {
  const htmlMeta = {
    doc_id: 'd_html',
    document_name: 'octo:s_1:f_default:html:d_html',
    title: 'HTML Doc',
    owner_id: 's_tmos_bot',
    space_id: 's_1',
    folder_id: 'f_default',
    doc_type: 'html',
    octo_doc_slug: 'html-slug-1',
    status: 1,
    permission_epoch: 0,
    created_at: new Date(0),
    updated_at: new Date(0),
    created_by: 's_tmos_bot',
    updated_by: '',
  }

  it.each([
    ['missing', {}],
    ['empty string', { mountType: '' }],
    ['null', { mountType: null }],
  ])('creates an unmounted canonical HTML doc when mountType is %s', async (_label, mount) => {
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 's_tmos_bot', spaceId: 's_1', ownerUid: 'u_human' }) }))
    createCanonicalHtml.mockResolvedValue({
      meta: { ...htmlMeta, doc_id: 'd_canonical', octo_doc_slug: 'd_canonical' }, created: true,
    } as never)

    const response = await fetch(`${base}/v1/bot/docs`, {
      method: 'POST', headers: { authorization: 'Bearer bot-tok', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'First title', docType: 'html', idempotencyKey: 'run-42', ...mount }),
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      docId: 'd_canonical', octoDocSlug: 'd_canonical', created: true,
      publisherUid: 's_tmos_bot', spaceId: 's_1', folderId: 'f_default',
      documentName: 'octo:s_1:f_default:html:d_html',
    })
    expect(createCanonicalHtml).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'run-42', ownerId: 's_tmos_bot', humanOwnerUid: 'u_human',
      spaceId: 's_1', folderId: 'f_default', octoDocSlug: expect.stringMatching(/^d_/),
      documentName: expect.stringMatching(/^octo:s_1:f_default:html:d_/),
    }))
    expect(createCanonicalHtml.mock.calls[0]![0]).not.toHaveProperty('mountType')
    expect(createCanonicalHtml.mock.calls[0]![0]).not.toHaveProperty('groupId')
    expect(createCanonicalHtml.mock.calls[0]![0]).not.toHaveProperty('threadId')
    expect(upsertHtmlByOctoDocSlug).not.toHaveBeenCalled()
    expect(upsertDirect).not.toHaveBeenCalled()
  })

  it('rejects mixing a canonical idempotencyKey with a legacy octoDocSlug', async () => {
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 's_tmos_bot', spaceId: 's_1', ownerUid: 'u_human' }) }))

    const mixed = await fetch(`${base}/v1/bot/docs`, {
      method: 'POST', headers: { authorization: 'Bearer bot-tok', 'content-type': 'application/json' },
      body: JSON.stringify({ docType: 'html', idempotencyKey: 'run-43', octoDocSlug: 'legacy', mountType: 'group' }),
    })
    expect(mixed.status).toBe(400)
    expect(createCanonicalHtml).not.toHaveBeenCalled()
  })

  it('leaves membership and epoch untouched on a canonical retry without enqueueing before content is ready', async () => {
    ;(config as unknown as { search: { indexEnabled: boolean } }).search.indexEnabled = true
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 's_tmos_bot', spaceId: 's_1', ownerUid: 'u_human' }) }))
    createCanonicalHtml.mockResolvedValue({
      meta: { ...htmlMeta, doc_id: 'd_existing', octo_doc_slug: 'd_existing', title: 'Original title' }, created: false,
    } as never)
    const res = await fetch(`${base}/v1/bot/docs`, {
      method: 'POST', headers: { authorization: 'Bearer bot-tok', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Replacement title', docType: 'html', idempotencyKey: 'run-42', mountType: 'thread' }),
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ docId: 'd_existing', title: 'Original title', created: false })
    expect(upsertDirect).not.toHaveBeenCalled()
    expect(bumpEpochMock).not.toHaveBeenCalled()
    expect(enqueueDocIndexMock).not.toHaveBeenCalled()
  })

  it('does not restore or bump an adjusted owner role on canonical replay', async () => {
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 's_tmos_bot', spaceId: 's_1', ownerUid: 'u_human' }) }))
    createCanonicalHtml.mockResolvedValue({ meta: { ...htmlMeta, doc_id: 'd_existing', octo_doc_slug: 'd_existing' }, created: false } as never)
    const res = await fetch(`${base}/v1/bot/docs`, {
      method: 'POST', headers: { authorization: 'Bearer bot-tok', 'content-type': 'application/json' },
      body: JSON.stringify({ docType: 'html', idempotencyKey: 'same', mountType: 'group' }),
    })
    expect(res.status).toBe(201)
    expect(upsertDirect).not.toHaveBeenCalled()
    expect(bumpEpochMock).not.toHaveBeenCalled()
  })

  it('does not attempt an out-of-transaction grant for a canonical create', async () => {
    createCanonicalHtml.mockResolvedValueOnce({ meta: { ...htmlMeta, doc_id: 'd_atomic', octo_doc_slug: 'd_atomic' }, created: true } as never)
    const response = mockHandlerRes()
    await createDocHandler({
      uid: 's_tmos_bot', spaceId: 's_1', botToken: 'bot', botOwnerUid: 'u_human', params: {}, query: {},
      body: { docType: 'html', idempotencyKey: 'atomic', mountType: 'group' },
    } as never, response as never)
    expect(response.statusCode).toBe(201)
    expect(upsertDirect).not.toHaveBeenCalled()
    expect(createCanonicalHtml).toHaveBeenCalledWith(expect.objectContaining({ humanOwnerUid: 'u_human' }))
  })

  it('trims a bounded idempotency key and rejects invalid/non-html uses', async () => {
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 's_tmos_bot', spaceId: 's_1', ownerUid: 'u_human' }) }))
    createCanonicalHtml.mockResolvedValue({ meta: { ...htmlMeta, doc_id: 'd_trim', octo_doc_slug: 'd_trim' }, created: true } as never)
    const post = (body: object) => fetch(`${base}/v1/bot/docs`, {
      method: 'POST', headers: { authorization: 'Bearer bot', 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    expect((await post({ docType: 'html', idempotencyKey: '  key  ', mountType: 'group' })).status).toBe(201)
    expect(createCanonicalHtml).toHaveBeenLastCalledWith(expect.objectContaining({ idempotencyKey: 'key' }))
    expect((await post({ docType: 'html', idempotencyKey: '   ', mountType: 'group' })).status).toBe(400)
    expect((await post({ docType: 'html', idempotencyKey: 'x'.repeat(129), mountType: 'group' })).status).toBe(400)
    const invalidMount = await post({ docType: 'html', idempotencyKey: 'key', mountType: 'channel' })
    expect(invalidMount.status).toBe(400)
    expect(await invalidMount.json()).toEqual({ error: 'mountType must be group, space, or thread' })
    expect((await post({ docType: 'doc', idempotencyKey: 'key' })).status).toBe(400)
  })

  it('publishes content by doc_id, optionally syncs title, and reindexes idempotently', async () => {
    ;(config as unknown as { search: { indexEnabled: boolean } }).search.indexEnabled = true
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 's_tmos_bot', spaceId: 's_1' }) }))
    getByDocId.mockResolvedValue({ ...htmlMeta, octo_doc_slug: 'd_html', html_idempotency_key_hash: Buffer.alloc(32) } as never)
    const request = () => fetch(`${base}/v1/bot/docs/d_html/published`, {
      method: 'POST', headers: { authorization: 'Bearer bot-tok', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Content title' }),
    })
    expect((await request()).status).toBe(200)
    expect((await request()).status).toBe(200)
    expect(rename).toHaveBeenCalledTimes(2)
    expect(rename).toHaveBeenCalledWith('d_html', 'Content title', 's_tmos_bot')
    expect(enqueueDocIndexMock).toHaveBeenCalledTimes(2)
    expect(enqueueDocIndexMock).toHaveBeenCalledWith(htmlMeta.document_name)
  })

  it('rejects published notification from the human mount and for wrong kind', async () => {
    setOctoIdentity(stub({ verifyToken: async () => ({ uid: 's_tmos_bot' }) }))
    let res = await fetch(`${base}/api/v1/docs/d_html/published`, {
      method: 'POST', headers: { token: 'user', 'X-Space-Id': 's_1', 'content-type': 'application/json' }, body: '{}',
    })
    expect(res.status).toBe(404)
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 's_tmos_bot', spaceId: 's_1' }) }))
    getByDocId.mockResolvedValue({ ...htmlMeta, doc_type: 'doc' } as never)
    res = await fetch(`${base}/v1/bot/docs/d_html/published`, {
      method: 'POST', headers: { authorization: 'Bearer bot', 'content-type': 'application/json' }, body: '{}',
    })
    expect(res.status).toBe(409)
  })

  it('returns stable 410 when a repeated canonical key belongs to a deleted doc', async () => {
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 's_tmos_bot', spaceId: 's_1', ownerUid: 'u_human' }) }))
    createCanonicalHtml.mockRejectedValue(new CanonicalHtmlDeletedError())
    const res = await fetch(`${base}/v1/bot/docs`, {
      method: 'POST', headers: { authorization: 'Bearer bot-tok', 'content-type': 'application/json' },
      body: JSON.stringify({ docType: 'html', idempotencyKey: 'run-deleted', mountType: 'group' }),
    })
    expect(res.status).toBe(410)
    expect(await res.json()).toEqual({ error: 'canonical_document_deleted' })
    expect(upsertDirect).not.toHaveBeenCalled()
    expect(enqueueDocIndexMock).not.toHaveBeenCalled()
  })

  it('registers an html doc with docType=html and stores the octo-doc slug', async () => {
    ;(config as unknown as { search: { indexEnabled: boolean } }).search.indexEnabled = true
    setOctoIdentity(
      stub({ verifyBot: async () => ({ uid: 's_tmos_bot', spaceId: 's_1', ownerUid: 'u_human' }) }),
    )
    upsertHtmlByOctoDocSlug.mockResolvedValue({ meta: htmlMeta, created: true } as never)

    const res = await fetch(`${base}/v1/bot/docs`, {
      method: 'POST',
      headers: { authorization: 'Bearer bot-tok', 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'HTML Doc',
        docType: 'html',
        octoDocSlug: 'html-slug-1',
        mountType: 'group',
      }),
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      docId: string
      documentName: string
      docType: string
      octoDocSlug: string
      created: boolean
    }
    expect(body.docId).toBe('d_html')
    expect(body.documentName).toBe('octo:s_1:f_default:html:d_html')
    expect(body.docType).toBe('html')
    expect(body.octoDocSlug).toBe('html-slug-1')
    expect(body.created).toBe(true)
    expect(upsertHtmlByOctoDocSlug).toHaveBeenCalledTimes(1)
    expect(upsertHtmlByOctoDocSlug.mock.calls[0]![0]).toMatchObject({
      docType: 'html',
      octoDocSlug: 'html-slug-1',
      spaceId: 's_1',
      folderId: 'f_default',
      ownerId: 's_tmos_bot',
      humanOwnerUid: 'u_human',
    })
    expect(upsertHtmlByOctoDocSlug.mock.calls[0]![0].documentName).toMatch(/^octo:s_1:f_default:html:/)
    expect(upsertDirect).not.toHaveBeenCalled()
    expect(enqueueDocIndexMock).toHaveBeenCalledWith(htmlMeta.document_name)
  })

  it('keeps healing owner admin on the legacy octoDocSlug recovery path (created:false)', async () => {
    // Legacy octoDocSlug registration retains its recovery behavior: a prior
    // partial failure could have written doc_meta but never granted the human
    // owner admin. This is intentionally distinct from canonical idempotencyKey
    // retries, which are read-only at the handler boundary.
    setOctoIdentity(
      stub({ verifyBot: async () => ({ uid: 's_tmos_bot', spaceId: 's_1', ownerUid: 'u_human' }) }),
    )
    upsertHtmlByOctoDocSlug.mockResolvedValue({
      meta: { ...htmlMeta, title: 'Renamed', permission_epoch: 8 },
      created: false,
      memberReconciled: true,
      permissionEpoch: 8,
    } as never)

    const res = await fetch(`${base}/v1/bot/docs`, {
      method: 'POST',
      headers: { authorization: 'Bearer bot-tok', 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Renamed',
        docType: 'html',
        octoDocSlug: 'html-slug-1',
        mountType: 'space',
      }),
    })

    expect(res.status).toBe(201)
    expect((await res.json()) as { docId: string; title: string; octoDocSlug: string; created: boolean }).toMatchObject({
      docId: 'd_html',
      title: 'Renamed',
      octoDocSlug: 'html-slug-1',
      created: false,
    })
    expect(upsertHtmlByOctoDocSlug).toHaveBeenCalledTimes(1)
    expect(upsertDirect).not.toHaveBeenCalled()
    expect(bumpEpochMock).not.toHaveBeenCalled()
    expect(refreshAndPublishMock).toHaveBeenCalledWith(htmlMeta.document_name, 8, 'u_human')
  })

  it('does not grant on the recovery path when the bot has no distinct human owner (owner == bot)', async () => {
    // grantBotOwnerAdmin still self-no-ops on recovery when there is no distinct
    // human owner, so the unconditional call adds no spurious self-membership.
    setOctoIdentity(
      stub({ verifyBot: async () => ({ uid: 's_tmos_bot', spaceId: 's_1', ownerUid: 's_tmos_bot' }) }),
    )
    upsertHtmlByOctoDocSlug.mockResolvedValue({ meta: htmlMeta, created: false } as never)

    const res = await fetch(`${base}/v1/bot/docs`, {
      method: 'POST',
      headers: { authorization: 'Bearer bot-tok', 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Renamed',
        docType: 'html',
        octoDocSlug: 'html-slug-1',
        mountType: 'space',
      }),
    })

    expect(res.status).toBe(201)
    expect(upsertDirect).not.toHaveBeenCalled()
    expect(bumpEpochMock).not.toHaveBeenCalled()
  })

  it('registers thread-mounted html docs idempotently and grants the human owner admin', async () => {
    setOctoIdentity(
      stub({ verifyBot: async () => ({ uid: 's_tmos_bot', spaceId: 's_1', ownerUid: 'u_human' }) }),
    )
    upsertHtmlByOctoDocSlug
      .mockResolvedValueOnce({ meta: htmlMeta, created: true } as never)
      .mockResolvedValueOnce({ meta: htmlMeta, created: false } as never)

    const request = () =>
      fetch(`${base}/v1/bot/docs`, {
        method: 'POST',
        headers: { authorization: 'Bearer bot-tok', 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'HTML Doc',
          docType: 'html',
          octoDocSlug: 'html-slug-1',
          mountType: 'thread',
        }),
      })

    const firstRes = await request()
    const repeatRes = await request()

    expect(firstRes.status).toBe(201)
    expect(repeatRes.status).toBe(201)
    expect(await firstRes.json()).toMatchObject({ docId: 'd_html', octoDocSlug: 'html-slug-1', created: true })
    expect(await repeatRes.json()).toMatchObject({ docId: 'd_html', octoDocSlug: 'html-slug-1', created: false })
    expect(upsertHtmlByOctoDocSlug).toHaveBeenCalledTimes(2)
    expect(upsertHtmlByOctoDocSlug.mock.calls[0]![0]).toMatchObject({
      docType: 'html',
      octoDocSlug: 'html-slug-1',
      spaceId: 's_1',
      ownerId: 's_tmos_bot',
    })
    expect(create).not.toHaveBeenCalled()
    expect(upsertDirect).not.toHaveBeenCalled()
    expect(refreshAndPublishMock).not.toHaveBeenCalled()
  })

  it.each([
    [undefined, 'mountType must be group, space, or thread'],
    ['channel', 'mountType must be group, space, or thread'],
  ])('rejects html registration with unsupported mountType %s before writing', async (mountType, error) => {
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 's_tmos_bot', spaceId: 's_1', ownerUid: 'u_human' }) }))

    const res = await fetch(`${base}/v1/bot/docs`, {
      method: 'POST',
      headers: { authorization: 'Bearer bot-tok', 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'HTML Doc',
        docType: 'html',
        octoDocSlug: 'html-slug-1',
        ...(mountType === undefined ? {} : { mountType }),
      }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error })
    expect(upsertHtmlByOctoDocSlug).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(upsertDirect).not.toHaveBeenCalled()
    expect(bumpEpochMock).not.toHaveBeenCalled()
  })

  it('rejects html registration with an octo-doc slug longer than 128 chars before writing', async () => {
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 's_tmos_bot', spaceId: 's_1' }) }))

    const res = await fetch(`${base}/v1/bot/docs`, {
      method: 'POST',
      headers: { authorization: 'Bearer bot-tok', 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'HTML Doc',
        docType: 'html',
        octoDocSlug: 'x'.repeat(129),
        mountType: 'group',
      }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'octoDocSlug too long' })
    expect(upsertHtmlByOctoDocSlug).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('includes html docs in list results with docType and octoDocSlug', async () => {
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 'u_human', spaceId: 's_1' }) }))
    listForUser.mockResolvedValue({
      total: 1,
      items: [{ ...htmlMeta, owner_id: 's_tmos_bot', role: 3 }],
    } as never)

    const res = await fetch(`${base}/v1/bot/docs`, { headers: { authorization: 'Bearer bot-tok' } })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { total: number; items: Array<{ docType: string; octoDocSlug: string }> }
    expect(body.total).toBe(1)
    expect(body.items[0]).toMatchObject({ docType: 'html', octoDocSlug: 'html-slug-1' })
  })

  it('registers the same slug in a different space as that space (no cross-tenant hit/leak, P0)', async () => {
    // Cross-tenant regression: space A already owns slug S (some other row). A
    // bot in space B registers the SAME slug S. With the P0 per-space scoping,
    // upsertHtmlByOctoDocSlug is driven by the caller's OWN space (s_B) — it can
    // never resolve/rewrite A's row, and the response only ever carries B's own
    // doc_id/space_id/owner_id, never A's. We assert the handler threads the
    // enforced bot space into the repo call and that the response echoes B.
    setOctoIdentity(
      stub({ verifyBot: async () => ({ uid: 's_bot_b', spaceId: 's_B', ownerUid: 'u_owner_b' }) }),
    )
    const bMeta = {
      ...htmlMeta,
      doc_id: 'd_html_B',
      document_name: 'octo:s_B:f_default:html:d_html_B',
      owner_id: 's_bot_b',
      space_id: 's_B',
      created_by: 's_bot_b',
    }
    upsertHtmlByOctoDocSlug.mockResolvedValue({ meta: bMeta, created: true } as never)

    const res = await fetch(`${base}/v1/bot/docs`, {
      method: 'POST',
      headers: { authorization: 'Bearer bot-tok', 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'B doc',
        docType: 'html',
        octoDocSlug: 'html-slug-1', // same slug space A owns
        mountType: 'group',
      }),
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      docId: string
      spaceId: string
      ownerId: string
      shareUrl: string
    }
    // The upsert ran against B's enforced space, not a global slug lookup.
    expect(upsertHtmlByOctoDocSlug.mock.calls[0]![0]).toMatchObject({
      octoDocSlug: 'html-slug-1',
      spaceId: 's_B',
      ownerId: 's_bot_b',
    })
    // The response is B's own row — it must not leak A's identifiers.
    expect(body.docId).toBe('d_html_B')
    expect(body.spaceId).toBe('s_B')
    expect(body.ownerId).toBe('s_bot_b')
    expect(body.docId).not.toBe('d_html')
    expect(body.spaceId).not.toBe('s_1')
    // Ordinary shareUrl uses the canonical response doc and never serializes Space.
    expect(body.shareUrl).toContain('d_html_B')
    expect(body.shareUrl).not.toContain('sp=')
    expect(body.shareUrl).not.toContain('sid=')
  })

  it('renames and soft-deletes html docs by octo-doc slug', async () => {
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 's_tmos_bot', spaceId: 's_1' }) }))
    getByOctoDocSlug.mockResolvedValue(htmlMeta as never)
    getByDocId.mockResolvedValue(htmlMeta as never)

    const renameRes = await fetch(`${base}/v1/bot/docs/octo-doc/${encodeURIComponent('html-slug-1')}`, {
      method: 'PATCH',
      headers: { authorization: 'Bearer bot-tok', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'HTML Renamed' }),
    })

    expect(renameRes.status).toBe(200)
    expect(rename).toHaveBeenCalledWith('d_html', 'HTML Renamed', 's_tmos_bot')

    const deleteRes = await fetch(`${base}/v1/bot/docs/octo-doc/${encodeURIComponent('html-slug-1')}`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer bot-tok' },
    })

    expect(deleteRes.status).toBe(200)
    expect(softDelete).toHaveBeenCalledWith('d_html')
    expect(refreshAndPublishMock).toHaveBeenCalledWith('octo:s_1:f_default:html:d_html', 1)
  })

  it('treats an owner retry of a canonical html delete as success without deleting twice', async () => {
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 's_tmos_bot', spaceId: 's_1' }) }))
    getByOctoDocSlug.mockResolvedValue({ ...htmlMeta, octo_doc_slug: htmlMeta.doc_id, status: 0 } as never)

    const res = await fetch(`${base}/v1/bot/docs/octo-doc/${encodeURIComponent('html-slug-1')}`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer bot-tok' },
    })

    expect(res.status).toBe(204)
    expect(softDelete).not.toHaveBeenCalled()
    expect(refreshAndPublishMock).not.toHaveBeenCalled()
  })

  it('does not turn another principal deletion of a deleted canonical html doc into success', async () => {
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 's_other_bot', spaceId: 's_1' }) }))
    getByOctoDocSlug.mockResolvedValue({ ...htmlMeta, octo_doc_slug: htmlMeta.doc_id, status: 0 } as never)

    const res = await fetch(`${base}/v1/bot/docs/octo-doc/${encodeURIComponent('html-slug-1')}`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer bot-tok' },
    })

    expect(res.status).toBe(404)
    expect(softDelete).not.toHaveBeenCalled()
  })

  it('keeps deleted historical slug registrations non-idempotent', async () => {
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 's_tmos_bot', spaceId: 's_1' }) }))
    getByOctoDocSlug.mockResolvedValue({ ...htmlMeta, status: 0 } as never)

    const res = await fetch(`${base}/v1/bot/docs/octo-doc/${encodeURIComponent('html-slug-1')}`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer bot-tok' },
    })

    expect(res.status).toBe(404)
    expect(softDelete).not.toHaveBeenCalled()
  })

  // Broken-object-level-authorization regression (PR #93, P0). A non-owner bot
  // POSTing another bot's existing slug must be rejected 403 at the route, and
  // the owner-grant side effects must NOT fire (fail-closed). The repo owner gate
  // signals this via DocOwnershipError; the handler maps it to 403 forbidden.
  it('rejects a non-owner html upsert of an existing slug with 403 (no side effects)', async () => {
    setOctoIdentity(
      stub({ verifyBot: async () => ({ uid: 's_bot_b', spaceId: 's_1', ownerUid: 'u_owner_b' }) }),
    )
    upsertHtmlByOctoDocSlug.mockRejectedValue(new DocOwnershipError())

    const res = await fetch(`${base}/v1/bot/docs`, {
      method: 'POST',
      headers: { authorization: 'Bearer bot-tok', 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'B overwrite',
        docType: 'html',
        octoDocSlug: 'html-slug-1', // slug bot A already registered
        mountType: 'group',
      }),
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden' })
    // Fail-closed: no owner-admin grant, no epoch broadcast on a rejected write.
    expect(upsertDirect).not.toHaveBeenCalled()
    expect(bumpEpochMock).not.toHaveBeenCalled()
  })
})
