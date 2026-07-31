import { describe, it, expect, vi, beforeEach } from 'vitest'

// Regression test for the rename -> search-reindex signal (§3.3a).
//
// Titles live in the search index (matched as title^2, returned as
// _source.title), so a rename MUST enqueue a reindex signal or the new title is
// missed / the stale one keeps showing until an unrelated body edit reindexes.
// This asserts renameDocById enqueues a doc-index signal keyed by the doc's
// documentName when search indexing is enabled, and does NOT enqueue when the
// gate is off or the doc has no searchable body (html).
//
// Offline style mirrors docsSearch.test.ts: mock the guard, the config gate, the
// doc_meta repo, and the index-queue producer, then drive the exported
// docsRouter PATCH '/:docId' layer directly (renameDocById is private).
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { search: { indexEnabled: true } },
}))
vi.mock('../src/config/env.js', () => ({ config: mockConfig }))

vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))

vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: {
    rename: vi.fn(async () => undefined),
    resolveDocumentName: vi.fn(async () => 'octo:s1:f_default:d_1'),
  },
  DocOwnershipError: class extends Error {},
}))

const { enqueueDocIndexMock } = vi.hoisted(() => ({ enqueueDocIndexMock: vi.fn(async () => true) }))
vi.mock('../src/search/docIndexQueue.js', () => ({
  enqueueDocIndex: enqueueDocIndexMock,
  // Real gate: document (4-seg), whiteboard (:wb:), and html (5-seg) all
  // qualify as searchable now. Match the real function shape closely enough
  // for these rename tests (segment count is a reliable proxy here).
  isSearchIndexedDoc: (name: string) => {
    const segs = name.split(':')
    return segs.length === 4 || segs.length === 5
  },
}))

import { docsRouter } from '../src/api/routes/docs.js'
import { requireDocRole } from '../src/api/guard.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { config } from '../src/config/env.js'

interface MockRes {
  statusCode: number
  body: unknown
  status(c: number): MockRes
  json(b: unknown): MockRes
}

function mockRes(): MockRes {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c
      return this
    },
    json(b: unknown) {
      this.body = b
      return this
    },
  }
}

interface RouterLayer {
  route?: {
    path: string
    methods: Record<string, boolean>
    stack: Array<{ handle: (...a: unknown[]) => unknown }>
  }
}

// Invoke the PATCH '/:docId' rename layer the same way Express would, without
// spinning up an HTTP server. Finds the router layer whose route matches
// PATCH /:docId and calls its handler with our fake req/res.
async function callRenameByDocId(reqObj: unknown, res: MockRes): Promise<void> {
  const stack = (docsRouter as unknown as { stack: RouterLayer[] }).stack
  const layer = stack.find((l) => l.route?.path === '/:docId' && l.route.methods.patch)
  if (!layer?.route) throw new Error('PATCH /:docId route not found')
  await layer.route.stack[0]!.handle(reqObj, res, () => {})
}

function req(docId: string, title: string) {
  return { uid: 'u_1', spaceId: 's1', params: { docId }, body: { title }, query: {} } as never
}

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  enqueueDocIndexMock.mockClear()
  vi.mocked(docMetaRepo.rename).mockClear()
  vi.mocked(docMetaRepo.resolveDocumentName).mockClear()
  ;(config as unknown as { search: { indexEnabled: boolean } }).search.indexEnabled = true
})

describe('rename -> search reindex signal (§3.3a)', () => {
  it('enqueues a doc-index signal keyed by documentName after a rename', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({ role: 'admin' } as never)
    vi.mocked(docMetaRepo.resolveDocumentName).mockResolvedValue('octo:s1:f_default:d_1')

    const res = mockRes()
    await callRenameByDocId(req('d_1', 'New Title'), res)

    expect(res.statusCode).toBe(200)
    expect(vi.mocked(docMetaRepo.rename)).toHaveBeenCalledWith('d_1', 'New Title', 'u_1')
    // The rename must feed the search index so the new title is discoverable.
    expect(enqueueDocIndexMock).toHaveBeenCalledTimes(1)
    expect(enqueueDocIndexMock).toHaveBeenCalledWith('octo:s1:f_default:d_1')
  })

  it('does NOT enqueue when search indexing is disabled', async () => {
    ;(config as unknown as { search: { indexEnabled: boolean } }).search.indexEnabled = false
    vi.mocked(requireDocRole).mockResolvedValue({ role: 'admin' } as never)

    const res = mockRes()
    await callRenameByDocId(req('d_1', 'New Title'), res)

    expect(res.statusCode).toBe(200)
    expect(vi.mocked(docMetaRepo.rename)).toHaveBeenCalledOnce()
    expect(enqueueDocIndexMock).not.toHaveBeenCalled()
  })

  it('DOES enqueue for an html doc — body resolved from octo-docs-html S3 by the indexer', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({ role: 'admin' } as never)
    // 5-seg html key -> isSearchIndexedDoc now returns true; rename should enqueue.
    vi.mocked(docMetaRepo.resolveDocumentName).mockResolvedValue('octo:s1:f_default:html:d_1')

    const res = mockRes()
    await callRenameByDocId(req('d_1', 'New Title'), res)

    expect(res.statusCode).toBe(200)
    expect(enqueueDocIndexMock).toHaveBeenCalledOnce()
  })
})
