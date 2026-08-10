import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockConfig, newDocId } = vi.hoisted(() => ({
  mockConfig: {
    htmlRegistration: { token: 'trusted-html-token' },
    webOrigin: 'https://docs.example.test',
  },
  newDocId: vi.fn(() => 'd_new'),
}))

vi.mock('../src/config/env.js', () => ({ config: mockConfig }))
vi.mock('../src/util/ids.js', () => ({ newDocId }))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  DocOwnershipError: class DocOwnershipError extends Error {},
  docMetaRepo: { upsertHtmlByOctoDocSlug: vi.fn() },
}))

import { internalHtmlRegistrationHandler } from '../src/api/routes/internalHtmlRegistration.js'
import { DocOwnershipError, docMetaRepo } from '../src/db/repos/docMetaRepo.js'

interface MockRes {
  statusCode: number
  body: unknown
  status(code: number): MockRes
  json(body: unknown): MockRes
}

function response(): MockRes {
  return {
    statusCode: 0,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

function request(body: Record<string, unknown>, token = 'trusted-html-token') {
  return {
    body,
    header: (name: string) => name.toLowerCase() === 'x-internal-token' ? token : undefined,
  }
}

const input = {
  octoDocSlug: 'published-page',
  spaceId: 'space-1',
  owner: 'user-1',
  title: 'Published page',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockConfig.htmlRegistration.token = 'trusted-html-token'
})

describe('trusted user HTML registration', () => {
  it.each(['', 'wrong-token'])('rejects a missing or invalid internal credential', async (token) => {
    const res = response()
    await internalHtmlRegistrationHandler(request(input, token) as never, res as never)
    expect(res.statusCode).toBe(401)
    expect(docMetaRepo.upsertHtmlByOctoDocSlug).not.toHaveBeenCalled()
  })

  it('registers fixed html/space metadata for the supplied trusted owner', async () => {
    vi.mocked(docMetaRepo.upsertHtmlByOctoDocSlug).mockResolvedValue({
      meta: {
        doc_id: 'd_new', document_name: 'octo:space-1:f_default:html:d_new',
        owner_id: 'user-1', space_id: 'space-1', title: 'Published page',
      },
      created: true,
    } as never)
    const res = response()

    await internalHtmlRegistrationHandler(request({ ...input, docType: 'doc', mountType: 'group' }) as never, res as never)

    expect(res.statusCode).toBe(201)
    expect(docMetaRepo.upsertHtmlByOctoDocSlug).toHaveBeenCalledWith(expect.objectContaining({
      docId: 'd_new', documentName: 'octo:space-1:f_default:html:d_new',
      docType: 'html', folderId: 'f_default', octoDocSlug: 'published-page',
      spaceId: 'space-1', ownerId: 'user-1', createdBy: 'user-1', title: 'Published page',
    }))
    expect(res.body).toMatchObject({
      docId: 'd_new', docType: 'html', mountType: 'space', created: true,
      shareUrl: 'https://docs.example.test/d/d_new?sp=space-1',
    })
  })

  it('is idempotent and returns the existing docId', async () => {
    vi.mocked(docMetaRepo.upsertHtmlByOctoDocSlug).mockResolvedValue({
      meta: {
        doc_id: 'd_existing', document_name: 'octo:space-1:f_default:html:d_existing',
        owner_id: 'user-1', space_id: 'space-1', title: 'Updated',
      },
      created: false,
    } as never)
    const res = response()
    await internalHtmlRegistrationHandler(request(input) as never, res as never)
    expect(res.body).toMatchObject({ docId: 'd_existing', created: false })
  })

  it('returns 403 when the slug belongs to a different owner', async () => {
    vi.mocked(docMetaRepo.upsertHtmlByOctoDocSlug).mockRejectedValue(new DocOwnershipError())
    const res = response()
    await internalHtmlRegistrationHandler(request(input) as never, res as never)
    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({ error: 'forbidden' })
  })

  it('trims owner, spaceId, and slug before validation and persistence', async () => {
    vi.mocked(docMetaRepo.upsertHtmlByOctoDocSlug).mockResolvedValue({
      meta: {
        doc_id: 'd_new', document_name: 'octo:space-1:f_default:html:d_new',
        owner_id: 'user-1', space_id: 'space-1', title: 'Published page',
      },
      created: true,
    } as never)
    const res = response()

    await internalHtmlRegistrationHandler(request({
      ...input,
      octoDocSlug: '  published-page  ',
      spaceId: '  space-1  ',
      owner: '  user-1  ',
    }) as never, res as never)

    expect(res.statusCode).toBe(201)
    expect(docMetaRepo.upsertHtmlByOctoDocSlug).toHaveBeenCalledWith(expect.objectContaining({
      octoDocSlug: 'published-page', spaceId: 'space-1', ownerId: 'user-1', createdBy: 'user-1',
    }))
    expect(res.body).toMatchObject({ octoDocSlug: 'published-page', spaceId: 'space-1', owner: 'user-1' })
  })

  it.each([
    ['empty owner after trimming', { owner: '   ' }],
    ['invalid owner characters', { owner: 'user:1' }],
    ['owner over the database limit', { owner: 'u'.repeat(65) }],
    ['empty spaceId after trimming', { spaceId: '   ' }],
    ['invalid spaceId characters', { spaceId: 'space/1' }],
    ['spaceId over the database limit', { spaceId: 's'.repeat(65) }],
    ['empty slug after trimming', { octoDocSlug: '   ' }],
    ['invalid slug characters', { octoDocSlug: 'published page' }],
    ['slug over the database limit', { octoDocSlug: 's'.repeat(129) }],
    ['non-string title', { title: 123 }],
    ['title over the database limit', { title: 't'.repeat(513) }],
  ])('rejects %s before writing', async (_case, override) => {
    const res = response()
    await internalHtmlRegistrationHandler(request({ ...input, ...override }) as never, res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_body' })
    expect(docMetaRepo.upsertHtmlByOctoDocSlug).not.toHaveBeenCalled()
  })
})
