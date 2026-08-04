import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test: mock the auth guard and the MySQL pool. The real
// docCommentRepo runs against the mocked `query` / `transaction`, so the repo
// round-trip and the route handlers are exercised without live infra.
vi.mock('../src/api/guard.js', () => ({
  requireDocRole: vi.fn(),
}))
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async () => []),
  transaction: vi.fn(),
}))
// Keep the real anchor-resolution error classes (the route uses `instanceof`),
// but stub the live-doc resolver so these offline tests never open a connection.
vi.mock('../src/collab/anchorResolve.js', async () => {
  const actual = await vi.importActual<typeof import('../src/collab/anchorResolve.js')>(
    '../src/collab/anchorResolve.js',
  )
  return { ...actual, resolveAnchorFromLiveDoc: vi.fn() }
})

import {
  listCommentsHandler,
  listCommentMarkersHandler,
  getCommentThreadHandler,
  createCommentHandler,
  patchCommentHandler,
  deleteCommentHandler,
} from '../src/api/routes/comments.js'
import { requireDocRole } from '../src/api/guard.js'
import { docCommentRepo } from '../src/db/repos/docCommentRepo.js'
import { query, transaction } from '../src/db/pool.js'
import {
  resolveAnchorFromLiveDoc,
  AmbiguousAnchorError,
  AnchorTextNotFoundError,
} from '../src/collab/anchorResolve.js'

interface MockRes {
  statusCode: number
  body: unknown
  status(c: number): MockRes
  json(b: unknown): MockRes
}

function mockRes(): MockRes {
  const res = {
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
  return res
}

function req(opts: {
  uid?: string
  params?: Record<string, string>
  body?: unknown
  query?: Record<string, string>
}) {
  return {
    uid: opts.uid ?? 'u_reader',
    spaceId: 's1',
    params: opts.params ?? {},
    body: opts.body,
    query: opts.query ?? {},
  } as never
}

const readerGuard = { meta: { doc_id: 'd_1', document_name: 'octo:s:f:d_1', doc_type: 'doc' }, role: 'reader' } as never
const commenterGuard = { meta: { doc_id: 'd_1', document_name: 'octo:s:f:d_1', doc_type: 'doc' }, role: 'commenter' } as never
const writerGuard = { meta: { doc_id: 'd_1', document_name: 'octo:s:f:d_1', doc_type: 'doc' }, role: 'writer' } as never
const adminGuard = { meta: { doc_id: 'd_1', document_name: 'octo:s:f:d_1', doc_type: 'doc' }, role: 'admin' } as never

/** Make requireDocRole emulate a 403 the way the real guard does (write + null). */
function forbidGuard() {
  vi.mocked(requireDocRole).mockImplementation((async (res: MockRes) => {
    res.status(403).json({ error: 'forbidden' })
    return null
  }) as never)
}

/** Make requireDocRole emulate a doc-status block (404 missing/deleted, 409 archived). */
function blockGuard(code: number, error: string) {
  vi.mocked(requireDocRole).mockImplementation((async (res: MockRes) => {
    res.status(code).json({ error })
    return null
  }) as never)
}

/** Mock create()'s transaction so it returns a fixed insert id; capture INSERT args. */
let txQuery: ReturnType<typeof vi.fn>
function mockInsertId(id: number) {
  txQuery = vi.fn(async (sql: string) => (String(sql).includes('LAST_INSERT_ID') ? [{ id }] : []))
  vi.mocked(transaction).mockImplementation((async (fn: (tx: unknown) => unknown) =>
    fn({ query: txQuery })) as never)
}

/** A stored thread root row (snake_case, as mysql2 returns it). */
function rootRow(over: Record<string, unknown> = {}) {
  return {
    id: 10,
    doc_id: 'd_1',
    document_name: 'octo:s:f:d_1',
    parent_id: null,
    author_uid: 'u_author',
    body: 'hello',
    anchor_start: Buffer.from('start'),
    anchor_end: Buffer.from('end'),
    anchor_text: 'snap',
    resolved: 0,
    resolved_by: null,
    resolved_at: null,
    deleted: 0,
    created_at: new Date(0),
    updated_at: new Date(0),
    ...over,
  }
}

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(query).mockReset()
  vi.mocked(query).mockResolvedValue([] as never)
  vi.mocked(transaction).mockReset()
  vi.mocked(resolveAnchorFromLiveDoc).mockReset()
})

describe('POST create (commenter minimum)', () => {
  it('creates a root comment as a commenter and requests the commenter floor', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(commenterGuard)
    mockInsertId(123)
    const res = mockRes()
    await createCommentHandler(
      req({
        uid: 'u_reader',
        params: { docId: 'd_1' },
        body: { body: 'a note', anchorStart: Buffer.from('s').toString('base64'), anchorEnd: Buffer.from('e').toString('base64'), anchorText: 'sel' },
      }),
      res as never,
    )
    expect(res.statusCode).toBe(201)
    expect((res.body as { id: number }).id).toBe(123)
    // The space (4th arg) is threaded from req.spaceId; minRole is the 5th arg.
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('s1')
    expect(vi.mocked(requireDocRole).mock.calls[0]![4]).toBe('commenter')
  })

  it('reader is read-only and cannot create a comment', async () => {
    forbidGuard()
    const res = mockRes()
    await createCommentHandler(
      req({ params: { docId: 'd_1' }, body: { body: 'no', anchorStart: 'AA==', anchorEnd: 'AA==' } }),
      res as never,
    )
    expect(res.statusCode).toBe(403)
    expect(transaction).not.toHaveBeenCalled()
  })

  it('rejects a root comment with no anchors (root/reply anchor invariant)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    mockInsertId(1)
    const res = mockRes()
    await createCommentHandler(
      req({ params: { docId: 'd_1' }, body: { body: 'no anchor here' } }),
      res as never,
    )
    expect(res.statusCode).toBe(400)
    expect(vi.mocked(transaction)).not.toHaveBeenCalled()
  })

  it('rejects an empty body with 400', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    const res = mockRes()
    await createCommentHandler(
      req({ params: { docId: 'd_1' }, body: { body: '   ', anchorStart: 'AA==', anchorEnd: 'AA==' } }),
      res as never,
    )
    expect(res.statusCode).toBe(400)
  })

  it('rejects a malformed base64 anchor with 400 invalid_anchor (not stored as empty)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    mockInsertId(1)
    const res = mockRes()
    await createCommentHandler(
      req({ params: { docId: 'd_1' }, body: { body: 'note', anchorStart: '@@@@', anchorEnd: 'AA==' } }),
      res as never,
    )
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe('invalid_anchor')
    // Malformed anchor is rejected before any INSERT.
    expect(vi.mocked(transaction)).not.toHaveBeenCalled()
  })

  it('rejects an anchor with embedded whitespace with 400 invalid_anchor', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    mockInsertId(1)
    const res = mockRes()
    await createCommentHandler(
      req({ params: { docId: 'd_1' }, body: { body: 'note', anchorStart: 'AA ==', anchorEnd: 'AA==' } }),
      res as never,
    )
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe('invalid_anchor')
    expect(vi.mocked(transaction)).not.toHaveBeenCalled()
  })

  it('rejects an oversized anchor (> MAX_ANCHOR_BYTES) with 400 invalid_anchor', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    mockInsertId(1)
    // 4097 decoded bytes — one over the 4096 cap.
    const oversized = Buffer.alloc(4097).toString('base64')
    const res = mockRes()
    await createCommentHandler(
      req({ params: { docId: 'd_1' }, body: { body: 'note', anchorStart: oversized, anchorEnd: 'AA==' } }),
      res as never,
    )
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe('invalid_anchor')
    expect(vi.mocked(transaction)).not.toHaveBeenCalled()
  })

  it('accepts a valid base64 anchor at the size cap and creates the root', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    mockInsertId(321)
    // Exactly 4096 decoded bytes — at the cap, still allowed.
    const atCap = Buffer.alloc(4096).toString('base64')
    const res = mockRes()
    await createCommentHandler(
      req({ params: { docId: 'd_1' }, body: { body: 'note', anchorStart: atCap, anchorEnd: 'AA==' } }),
      res as never,
    )
    expect(res.statusCode).toBe(201)
    expect((res.body as { id: number }).id).toBe(321)
  })

  // ── bot path: anchorText resolution (feature #70) ──────────────────────────
  it('resolves anchorText via the live doc and stores the returned anchors', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    vi.mocked(resolveAnchorFromLiveDoc).mockResolvedValue({
      anchorStart: Buffer.from('RS'),
      anchorEnd: Buffer.from('RE'),
      blockPath: [0],
      from: 1,
      to: 5,
    })
    mockInsertId(777)
    const res = mockRes()
    await createCommentHandler(
      req({ params: { docId: 'd_1' }, body: { body: 'note', anchorText: 'hello' } }),
      res as never,
    )
    expect(res.statusCode).toBe(201)
    expect((res.body as { id: number }).id).toBe(777)
    // Resolver was called with the doc name from the guard + no disambiguation.
    expect(vi.mocked(resolveAnchorFromLiveDoc)).toHaveBeenCalledWith('octo:s:f:d_1', {
      anchorText: 'hello',
      blockPath: undefined,
      occurrence: undefined,
    })
    // The resolver's anchor bytes are what got persisted.
    const insert = txQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO doc_comment'))!
    const args = insert[1] as unknown[]
    expect((args[5] as Buffer).equals(Buffer.from('RS'))).toBe(true) // anchor_start
    expect((args[6] as Buffer).equals(Buffer.from('RE'))).toBe(true) // anchor_end
  })

  it('threads blockPath + occurrence disambiguation through to the resolver', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    vi.mocked(resolveAnchorFromLiveDoc).mockResolvedValue({
      anchorStart: Buffer.from('a'),
      anchorEnd: Buffer.from('b'),
      blockPath: [1],
      from: 3,
      to: 4,
    })
    mockInsertId(1)
    const res = mockRes()
    await createCommentHandler(
      req({
        params: { docId: 'd_1' },
        body: { body: 'note', anchorText: 'x', blockPath: '1,0', occurrence: 2 },
      }),
      res as never,
    )
    expect(res.statusCode).toBe(201)
    expect(vi.mocked(resolveAnchorFromLiveDoc)).toHaveBeenCalledWith('octo:s:f:d_1', {
      anchorText: 'x',
      blockPath: [1, 0],
      occurrence: 2,
    })
  })

  it('maps an ambiguous anchorText to 422 ambiguous_anchor (fail-loud, no INSERT)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    vi.mocked(resolveAnchorFromLiveDoc).mockRejectedValue(new AmbiguousAnchorError([[0], [1]]))
    mockInsertId(1)
    const res = mockRes()
    await createCommentHandler(
      req({ params: { docId: 'd_1' }, body: { body: 'note', anchorText: 'dup' } }),
      res as never,
    )
    expect(res.statusCode).toBe(422)
    expect((res.body as { error: string }).error).toBe('ambiguous_anchor')
    expect((res.body as { matches: number[][] }).matches).toEqual([[0], [1]])
    expect(vi.mocked(transaction)).not.toHaveBeenCalled()
  })

  it('maps a missing anchorText to 422 anchor_text_not_found (no INSERT)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    vi.mocked(resolveAnchorFromLiveDoc).mockRejectedValue(new AnchorTextNotFoundError())
    mockInsertId(1)
    const res = mockRes()
    await createCommentHandler(
      req({ params: { docId: 'd_1' }, body: { body: 'note', anchorText: 'ghost' } }),
      res as never,
    )
    expect(res.statusCode).toBe(422)
    expect((res.body as { error: string }).error).toBe('anchor_text_not_found')
    expect(vi.mocked(transaction)).not.toHaveBeenCalled()
  })

  it('rejects a malformed blockPath with 400 invalid_block_path (never calls resolver)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    const res = mockRes()
    await createCommentHandler(
      req({ params: { docId: 'd_1' }, body: { body: 'note', anchorText: 'x', blockPath: 'a,b' } }),
      res as never,
    )
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe('invalid_block_path')
    expect(vi.mocked(resolveAnchorFromLiveDoc)).not.toHaveBeenCalled()
  })

  it('rejects a non-positive occurrence with 400 invalid_occurrence', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    const res = mockRes()
    await createCommentHandler(
      req({ params: { docId: 'd_1' }, body: { body: 'note', anchorText: 'x', occurrence: 0 } }),
      res as never,
    )
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe('invalid_occurrence')
    expect(vi.mocked(resolveAnchorFromLiveDoc)).not.toHaveBeenCalled()
  })

  it('legacy explicit anchors take precedence over anchorText (front-end path unchanged)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    mockInsertId(55)
    const res = mockRes()
    // Old front-end sends BOTH the encoded anchors and a text snapshot.
    await createCommentHandler(
      req({
        params: { docId: 'd_1' },
        body: {
          body: 'note',
          anchorStart: Buffer.from('s').toString('base64'),
          anchorEnd: Buffer.from('e').toString('base64'),
          anchorText: 'snapshot text',
        },
      }),
      res as never,
    )
    expect(res.statusCode).toBe(201)
    // The resolver is NOT invoked when explicit anchors are present.
    expect(vi.mocked(resolveAnchorFromLiveDoc)).not.toHaveBeenCalled()
    const insert = txQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO doc_comment'))!
    const args = insert[1] as unknown[]
    expect((args[5] as Buffer).equals(Buffer.from('s'))).toBe(true)
    expect((args[6] as Buffer).equals(Buffer.from('e'))).toBe(true)
  })

  it('creates a reply and stores NULL anchors (reply anchor invariant)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    mockInsertId(200)
    txQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FOR UPDATE')) return [{ id: 10 }]
      if (String(sql).includes('LAST_INSERT_ID')) return [{ id: 200 }]
      return []
    })
    const res = mockRes()
    await createCommentHandler(
      req({ params: { docId: 'd_1' }, body: { body: 'a reply', parentId: 10 } }),
      res as never,
    )
    expect(res.statusCode).toBe(201)
    expect((res.body as { id: number }).id).toBe(200)
    // INSERT args: parent_id = 10, both anchors NULL.
    const insert = txQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO doc_comment'))!
    const args = insert[1] as unknown[]
    expect(args[2]).toBe(10) // parent_id
    expect(String(insert[0])).toContain('NULL, NULL')
  })

  it('rejects a reply to a non-root (single-level nesting only)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    mockInsertId(0)
    const res = mockRes()
    await createCommentHandler(
      req({ params: { docId: 'd_1' }, body: { body: 'nested', parentId: 11 } }),
      res as never,
    )
    expect(res.statusCode).toBe(404)
  })

  it('404s when the reply parent belongs to a different doc (no leak)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    mockInsertId(0)
    const res = mockRes()
    await createCommentHandler(
      req({ params: { docId: 'd_1' }, body: { body: 'x', parentId: 12 } }),
      res as never,
    )
    expect(res.statusCode).toBe(404)
  })
})

// ── bot anchorText path: doc_type gate + unexpected-error handling (P1-2) ─────────
describe('POST create — anchorText resolution guards (P1-2)', () => {
  const whiteboardGuard = {
    meta: { doc_id: 'd_1', document_name: 'octo:s:f:d_1', doc_type: 'whiteboard' },
    role: 'reader',
  } as never

  it('rejects anchorText on a non-doc doc_type with 409 unsupported_doc_type (never resolves)', async () => {
    // A sheet/board/whiteboard stores a non-ProseMirror Y.Doc shape, so resolving
    // anchorText against it would throw inside initProseMirrorDoc. The gate must
    // fire BEFORE the live-doc resolver is ever touched (mirrors docContent.ts).
    vi.mocked(requireDocRole).mockResolvedValue(whiteboardGuard)
    mockInsertId(1)
    const res = mockRes()
    await createCommentHandler(
      req({ params: { docId: 'd_1' }, body: { body: 'note', anchorText: 'hello' } }),
      res as never,
    )
    expect(res.statusCode).toBe(409)
    expect((res.body as { error: string }).error).toBe('unsupported_doc_type')
    expect(vi.mocked(resolveAnchorFromLiveDoc)).not.toHaveBeenCalled()
    expect(vi.mocked(transaction)).not.toHaveBeenCalled()
  })

  it('maps an unexpected resolver failure to 500 internal_error (no hung request, no INSERT)', async () => {
    // A non-contract error (e.g. initProseMirrorDoc throwing on a bad fragment)
    // must become a 500 through the handler, not a re-thrown rejection: this
    // handler is a bare async Express handler, so an escaping rejection would
    // become an unhandled rejection and hang the client request until timeout.
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    vi.mocked(resolveAnchorFromLiveDoc).mockRejectedValue(new Error('live doc read failed'))
    mockInsertId(1)
    const res = mockRes()
    await createCommentHandler(
      req({ params: { docId: 'd_1' }, body: { body: 'note', anchorText: 'hello' } }),
      res as never,
    )
    expect(res.statusCode).toBe(500)
    expect((res.body as { error: string }).error).toBe('internal_error')
    expect(vi.mocked(transaction)).not.toHaveBeenCalled()
  })

  it('a partial explicit anchor (start only) + anchorText does NOT fall through to resolution → 400', async () => {
    // Precedence guard: a half-supplied legacy pair must be rejected outright,
    // never silently resolved via the anchorText path. Documents the current
    // (correct) precedence so a future reorder cannot regress it silently.
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    mockInsertId(1)
    const res = mockRes()
    await createCommentHandler(
      req({
        params: { docId: 'd_1' },
        body: {
          body: 'note',
          anchorStart: Buffer.from('s').toString('base64'),
          anchorText: 'fallback text',
        },
      }),
      res as never,
    )
    expect(res.statusCode).toBe(400)
    expect(vi.mocked(resolveAnchorFromLiveDoc)).not.toHaveBeenCalled()
    expect(vi.mocked(transaction)).not.toHaveBeenCalled()
  })
})

describe('PATCH resolve / body edit', () => {
  it('requires writer to resolve a thread (reader blocked above the floor)', async () => {
    // Caller clears the reader floor but lacks writer for the resolve branch.
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    vi.mocked(query).mockResolvedValueOnce([rootRow()] as never)
    const res = mockRes()
    await patchCommentHandler(
      req({ uid: 'u_reader', params: { docId: 'd_1', id: '10' }, body: { resolved: true } }),
      res as never,
    )
    expect(res.statusCode).toBe(403)
    // Single guard call: the floor gate with the commenter minimum; writer is
    // enforced from guard.role, not a second requireDocRole call.
    expect(vi.mocked(requireDocRole).mock.calls).toHaveLength(1)
    expect(vi.mocked(requireDocRole).mock.calls[0]![4]).toBe('commenter')
  })

  it('resolves a thread for a writer and stamps resolved_by', async () => {
    vi.mocked(query).mockResolvedValueOnce([rootRow()] as never)
    vi.mocked(requireDocRole).mockResolvedValue(writerGuard)
    const res = mockRes()
    await patchCommentHandler(
      req({ uid: 'u_writer', params: { docId: 'd_1', id: '10' }, body: { resolved: true } }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    const update = vi.mocked(query).mock.calls.find((c) => String(c[0]).includes('resolved = 1'))
    expect(update).toBeTruthy()
  })

  it('requires the author to edit the body', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(writerGuard)
    vi.mocked(query).mockResolvedValueOnce([rootRow({ author_uid: 'u_author' })] as never)
    const res = mockRes()
    await patchCommentHandler(
      req({ uid: 'u_other', params: { docId: 'd_1', id: '10' }, body: { body: 'hijack' } }),
      res as never,
    )
    expect(res.statusCode).toBe(403)
  })

  it('lets a writer edit their own comment body', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(writerGuard)
    vi.mocked(query).mockResolvedValueOnce([rootRow({ author_uid: 'u_author' })] as never)
    const res = mockRes()
    await patchCommentHandler(
      req({ uid: 'u_author', params: { docId: 'd_1', id: '10' }, body: { body: 'edited' } }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    const update = vi.mocked(query).mock.calls.find((c) => String(c[0]).includes('SET body = ?'))
    expect(update).toBeTruthy()
  })

  it('404s a cross-doc comment id (no leak)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(writerGuard)
    vi.mocked(query).mockResolvedValueOnce([rootRow({ doc_id: 'd_OTHER' })] as never)
    const res = mockRes()
    await patchCommentHandler(
      req({ uid: 'u_author', params: { docId: 'd_1', id: '10' }, body: { body: 'edit' } }),
      res as never,
    )
    expect(res.statusCode).toBe(404)
  })
})

describe('DELETE soft / hard', () => {
  it('lets the author soft-delete their own comment', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(commenterGuard)
    vi.mocked(query).mockResolvedValueOnce([rootRow({ author_uid: 'u_author' })] as never)
    const res = mockRes()
    await deleteCommentHandler(
      req({ uid: 'u_author', params: { docId: 'd_1', id: '10' } }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    const update = vi.mocked(query).mock.calls.find((c) => String(c[0]).includes('SET deleted = 1'))
    expect(update).toBeTruthy()
  })

  it('rejects a soft delete by a non-author', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(commenterGuard)
    vi.mocked(query).mockResolvedValueOnce([rootRow({ author_uid: 'u_author' })] as never)
    const res = mockRes()
    await deleteCommentHandler(
      req({ uid: 'u_other', params: { docId: 'd_1', id: '10' } }),
      res as never,
    )
    expect(res.statusCode).toBe(403)
  })

  it('requires admin for a hard delete (commenter blocked above the floor)', async () => {
    // Caller clears the commenter floor but lacks admin for the hard-delete branch.
    vi.mocked(requireDocRole).mockResolvedValue(commenterGuard)
    vi.mocked(query).mockResolvedValueOnce([rootRow({ author_uid: 'u_author' })] as never)
    const res = mockRes()
    await deleteCommentHandler(
      req({ uid: 'u_author', params: { docId: 'd_1', id: '10' }, query: { hard: '1' } }),
      res as never,
    )
    expect(res.statusCode).toBe(403)
    expect(vi.mocked(requireDocRole).mock.calls).toHaveLength(1)
    expect(vi.mocked(requireDocRole).mock.calls[0]![4]).toBe('commenter')
  })

  it('hard-deletes for an admin', async () => {
    vi.mocked(query).mockResolvedValueOnce([rootRow()] as never)
    vi.mocked(requireDocRole).mockResolvedValue(adminGuard)
    // hardDelete runs its cascade DELETE inside transaction(); capture tx.query.
    const txQ = vi.fn(async () => [])
    vi.mocked(transaction).mockImplementation((async (fn: (tx: unknown) => unknown) =>
      fn({ query: txQ })) as never)
    const res = mockRes()
    await deleteCommentHandler(
      req({ uid: 'u_admin', params: { docId: 'd_1', id: '10' }, query: { hard: '1' } }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    const lock = txQ.mock.calls.find((c) => String(c[0]).includes('FOR UPDATE'))
    expect(lock?.[1]).toEqual([10, 'd_1'])
    const del = txQ.mock.calls.find((c) => String(c[0]).includes('DELETE FROM doc_comment'))
    expect(del).toBeTruthy()
    // The cascade is bounded by the authoritative doc_id from the guard.
    expect(String(del![0])).toContain('AND doc_id = ?')
    expect(del![1]).toEqual([10, 10, 'd_1'])
  })
})

describe('commenter floor gate on body-edit / soft-delete (revoked author + doc status)', () => {
  it('403s a revoked (role:none) author editing their OWN comment body', async () => {
    // requireDocRole writes 403 and returns null for a role:'none' caller.
    // The floor gate must run BEFORE the author check, so even the author is blocked.
    forbidGuard()
    const res = mockRes()
    await patchCommentHandler(
      req({ uid: 'u_author', params: { docId: 'd_1', id: '10' }, body: { body: 'edit after revoke' } }),
      res as never,
    )
    expect(res.statusCode).toBe(403)
    // The floor gate fired (commenter minimum) and short-circuited before getById.
    expect(vi.mocked(requireDocRole).mock.calls).toHaveLength(1)
    expect(vi.mocked(requireDocRole).mock.calls[0]![4]).toBe('commenter')
    // No DB read of the comment happened — the gate blocked first.
    expect(vi.mocked(query)).not.toHaveBeenCalled()
  })

  it('403s a revoked (role:none) author soft-deleting their OWN comment', async () => {
    forbidGuard()
    const res = mockRes()
    await deleteCommentHandler(
      req({ uid: 'u_author', params: { docId: 'd_1', id: '10' } }),
      res as never,
    )
    expect(res.statusCode).toBe(403)
    expect(vi.mocked(requireDocRole).mock.calls).toHaveLength(1)
    expect(vi.mocked(requireDocRole).mock.calls[0]![4]).toBe('commenter')
    expect(vi.mocked(query)).not.toHaveBeenCalled()
  })

  it('keeps a commenter body read-only even when they authored the comment', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(commenterGuard)
    vi.mocked(query).mockResolvedValueOnce([rootRow({ author_uid: 'u_author' })] as never)
    const res = mockRes()
    await patchCommentHandler(
      req({ uid: 'u_author', params: { docId: 'd_1', id: '10' }, body: { body: 'still blocked' } }),
      res as never,
    )
    expect(res.statusCode).toBe(403)
  })

  it('still lets a current commenter author soft-delete their own comment (200)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(commenterGuard)
    vi.mocked(query).mockResolvedValueOnce([rootRow({ author_uid: 'u_author' })] as never)
    const res = mockRes()
    await deleteCommentHandler(
      req({ uid: 'u_author', params: { docId: 'd_1', id: '10' } }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
  })

  it('404s a body edit on a missing/deleted doc (doc-status semantics restored)', async () => {
    blockGuard(404, 'not_found')
    const res = mockRes()
    await patchCommentHandler(
      req({ uid: 'u_author', params: { docId: 'd_1', id: '10' }, body: { body: 'edit' } }),
      res as never,
    )
    expect(res.statusCode).toBe(404)
  })

  it('409s a soft delete on an archived doc (doc-status semantics restored)', async () => {
    blockGuard(409, 'conflict')
    const res = mockRes()
    await deleteCommentHandler(
      req({ uid: 'u_author', params: { docId: 'd_1', id: '10' } }),
      res as never,
    )
    expect(res.statusCode).toBe(409)
  })
})

describe('GET one grouped comment thread', () => {
  it('returns a root and replies by marker id with reader access', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    vi.mocked(query)
      .mockResolvedValueOnce([rootRow({ id: 10 })] as never)
      .mockResolvedValueOnce([rootRow({ id: 11, parent_id: 10, anchor_start: null, anchor_end: null })] as never)
    const res = mockRes()
    await getCommentThreadHandler(req({ params: { docId: 'd_1', id: '10' } }), res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ id: 10, replies: [{ id: 11, parentId: 10 }] })
    expect(vi.mocked(requireDocRole).mock.calls[0]![4]).toBe('reader')
  })

  it('404s cross-doc ids and reply ids without loading replies', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    vi.mocked(query).mockResolvedValueOnce([rootRow({ doc_id: 'd_OTHER' })] as never)
    const crossDoc = mockRes()
    await getCommentThreadHandler(req({ params: { docId: 'd_1', id: '10' } }), crossDoc as never)
    expect(crossDoc.statusCode).toBe(404)
    expect(query).toHaveBeenCalledTimes(1)

    vi.mocked(query).mockReset()
    vi.mocked(query).mockResolvedValueOnce([rootRow({ id: 11, parent_id: 10 })] as never)
    const reply = mockRes()
    await getCommentThreadHandler(req({ params: { docId: 'd_1', id: '11' } }), reply as never)
    expect(reply.statusCode).toBe(404)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('applies the reader floor before looking up the comment', async () => {
    forbidGuard()
    const res = mockRes()
    await getCommentThreadHandler(req({ params: { docId: 'd_1', id: '10' } }), res as never)
    expect(res.statusCode).toBe(403)
    expect(query).not.toHaveBeenCalled()
  })
})

describe('GET board marker list', () => {
  const boardGuard = {
    meta: { doc_id: 'd_1', document_name: 'octo:s:f:d_1', doc_type: 'board' }, role: 'reader',
  } as never

  it('returns a lightweight cursor page of every unresolved root', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(boardGuard)
    vi.mocked(query).mockResolvedValueOnce([
      rootRow({ id: 10 }), rootRow({ id: 20, anchor_text: 'second' }),
    ] as never)
    const res = mockRes()
    await listCommentMarkersHandler(
      req({ params: { docId: 'd_1' }, query: { cursor: '5', limit: '2' } }), res as never,
    )
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({
      items: [
        { id: 10, anchorText: 'snap', resolved: false },
        { id: 20, anchorText: 'second', resolved: false },
      ],
      nextCursor: 20,
    })
    const [sql, args] = vi.mocked(query).mock.calls[0]!
    expect(String(sql)).toContain('parent_id IS NULL AND deleted = 0 AND resolved = 0 AND id > ?')
    expect(args).toEqual(['d_1', 5])
    expect(Object.keys((res.body as { items: Record<string, unknown>[] }).items[0]!)).toEqual([
      'id', 'anchorStart', 'anchorEnd', 'anchorText', 'resolved', 'updatedAt',
    ])
  })

  it('requires reader access before querying', async () => {
    forbidGuard()
    const res = mockRes()
    await listCommentMarkersHandler(req({ params: { docId: 'd_1' } }), res as never)
    expect(res.statusCode).toBe(403)
    expect(query).not.toHaveBeenCalled()
  })

  it('rejects non-board docs and malformed cursors', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    const wrongType = mockRes()
    await listCommentMarkersHandler(req({ params: { docId: 'd_1' } }), wrongType as never)
    expect(wrongType.statusCode).toBe(409)

    vi.mocked(requireDocRole).mockResolvedValue(boardGuard)
    const badCursor = mockRes()
    await listCommentMarkersHandler(
      req({ params: { docId: 'd_1' }, query: { cursor: 'bad' } }), badCursor as never,
    )
    expect(badCursor.statusCode).toBe(400)
    expect(query).not.toHaveBeenCalled()
  })
})

describe('GET list', () => {
  it('returns roots with their replies and a nextCursor', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    // listRoots -> one root; then listReplies -> one reply.
    vi.mocked(query)
      .mockResolvedValueOnce([rootRow({ id: 10 })] as never)
      .mockResolvedValueOnce([rootRow({ id: 11, parent_id: 10, anchor_start: null, anchor_end: null })] as never)
    const res = mockRes()
    await listCommentsHandler(
      req({ params: { docId: 'd_1' }, query: { limit: '1' } }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    const body = res.body as { items: Array<{ id: number; anchorStart: string | null; replies: unknown[] }>; nextCursor: number | null }
    expect(body.items).toHaveLength(1)
    expect(body.items[0]!.id).toBe(10)
    expect(body.items[0]!.anchorStart).toBe(Buffer.from('start').toString('base64'))
    expect(body.items[0]!.replies).toHaveLength(1)
    // limit was filled (1 root) => nextCursor is the last root id.
    expect(body.nextCursor).toBe(10)
  })

  it('batches replies for multiple roots in ONE query and groups them by parent', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    // First query: listRoots -> two roots. Second query: listRepliesForRoots ->
    // all replies for both roots in a single flat result (id asc).
    vi.mocked(query)
      .mockResolvedValueOnce([rootRow({ id: 10 }), rootRow({ id: 20 })] as never)
      .mockResolvedValueOnce([
        rootRow({ id: 11, parent_id: 10, anchor_start: null, anchor_end: null }),
        rootRow({ id: 12, parent_id: 10, anchor_start: null, anchor_end: null }),
        rootRow({ id: 21, parent_id: 20, anchor_start: null, anchor_end: null }),
      ] as never)
    const res = mockRes()
    await listCommentsHandler(
      req({ params: { docId: 'd_1' }, query: { limit: '50' } }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    // Exactly two queries total: one for roots, one batched for ALL replies (no N+1).
    expect(vi.mocked(query).mock.calls).toHaveLength(2)
    const batchSql = String(vi.mocked(query).mock.calls[1]![0])
    // One placeholder PER root id (expanded), and a FLAT param list — mysql2's
    // `.execute()` path does not expand an array bound to a single `IN (?)`.
    expect(batchSql).toContain('parent_id IN (?, ?)')
    expect(vi.mocked(query).mock.calls[1]![1]).toEqual([10, 20])

    const body = res.body as { items: Array<{ id: number; replies: Array<{ id: number }> }> }
    expect(body.items).toHaveLength(2)
    // Root 10 gets its two replies in id-asc order; root 20 gets its one.
    expect(body.items[0]!.replies.map((r) => r.id)).toEqual([11, 12])
    expect(body.items[1]!.replies.map((r) => r.id)).toEqual([21])
  })

  it('does not query for replies when there are no roots', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    vi.mocked(query).mockResolvedValueOnce([] as never)
    const res = mockRes()
    await listCommentsHandler(
      req({ params: { docId: 'd_1' }, query: { limit: '50' } }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    const body = res.body as { items: unknown[]; nextCursor: number | null }
    expect(body.items).toHaveLength(0)
    expect(body.nextCursor).toBeNull()
    // No roots => listRepliesForRoots short-circuits without a second query.
    expect(vi.mocked(query).mock.calls).toHaveLength(1)
  })
})

describe('docCommentRepo (§3.4)', () => {
  it('create inserts the mapped columns and returns the DB-assigned id', async () => {
    mockInsertId(777)
    const id = await docCommentRepo.create({
      docId: 'd_1',
      documentName: 'octo:s:f:d_1',
      parentId: null,
      authorUid: 'u_1',
      body: 'hi',
      anchorStart: Buffer.from('s'),
      anchorEnd: Buffer.from('e'),
      anchorText: 'sel',
    })
    expect(id).toBe(777)
    const insert = txQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO doc_comment'))!
    expect((insert[1] as unknown[])[0]).toBe('d_1')
  })

  it('getById maps snake_case columns to camelCase', async () => {
    vi.mocked(query).mockResolvedValue([rootRow({ id: 10, resolved: 1, resolved_by: 'u_w' })] as never)
    const got = await docCommentRepo.getById(10)
    expect(got).toMatchObject({ id: 10, docId: 'd_1', parentId: null, resolved: true, resolvedBy: 'u_w', deleted: false })
  })

  it('listRoots filters out resolved threads unless includeResolved', async () => {
    vi.mocked(query).mockResolvedValue([] as never)
    await docCommentRepo.listRoots('d_1', { includeResolved: false, cursor: null, limit: 50 })
    const sql = String(vi.mocked(query).mock.calls[0]![0])
    expect(sql).toContain('parent_id IS NULL')
    expect(sql).toContain('resolved = 0')
  })

  it('listRepliesForRoots expands one placeholder per id with FLAT params', async () => {
    // Empty input short-circuits without touching the DB (avoids `IN ()`).
    expect(await docCommentRepo.listRepliesForRoots([])).toEqual([])
    expect(vi.mocked(query)).not.toHaveBeenCalled()

    // Two ids => `IN (?, ?)` and a FLAT [10, 20] param list. The pool's query()
    // runs on `.execute()` (a prepared statement), which does NOT expand an
    // array bound to a single `IN (?)`; binding the nested [[10, 20]] would
    // match zero rows and silently drop every reply. This asserts the FIXED
    // shape and fails on the single-`?` / nested-array regression. (A live
    // round-trip against MySQL is the belt-and-suspenders check; no usable DB
    // is reachable in this offline test env, so we assert the shape instead.)
    vi.mocked(query).mockResolvedValueOnce([rootRow({ id: 11, parent_id: 10 })] as never)
    const replies = await docCommentRepo.listRepliesForRoots([10, 20])
    const sql2 = String(vi.mocked(query).mock.calls[0]![0])
    expect(sql2).toContain('parent_id IN (?, ?)')
    expect(sql2).not.toContain('IN (?)') // not the un-expanded single placeholder
    expect(sql2).toContain('ORDER BY id ASC')
    expect(vi.mocked(query).mock.calls[0]![1]).toEqual([10, 20]) // FLAT, not [[10, 20]]
    expect(replies[0]!.parentId).toBe(10)

    // One id => a single `IN (?)` placeholder and a FLAT [10] param list.
    vi.mocked(query).mockReset()
    vi.mocked(query).mockResolvedValueOnce([rootRow({ id: 11, parent_id: 10 })] as never)
    await docCommentRepo.listRepliesForRoots([10])
    const sql1 = String(vi.mocked(query).mock.calls[0]![0])
    expect(sql1).toContain('parent_id IN (?)')
    expect(vi.mocked(query).mock.calls[0]![1]).toEqual([10]) // FLAT, not [[10]]
  })

  it('hardDelete cascades to child replies in one transaction (reply target deletes only itself)', async () => {
    // hardDelete runs a single cascade DELETE inside transaction(); capture it.
    const txQ = vi.fn(async () => [])
    vi.mocked(transaction).mockImplementation((async (fn: (tx: unknown) => unknown) =>
      fn({ query: txQ })) as never)

    // Root target (id=10): the statement removes the root AND any row whose
    // parent_id is 10 (its replies) — no orphans left behind. Scoped to doc_id.
    await docCommentRepo.hardDelete(10, 'd_1')
    expect(txQ).toHaveBeenCalledTimes(2)
    expect(String(txQ.mock.calls[0]![0])).toContain('FOR UPDATE')
    expect(txQ.mock.calls[0]![1]).toEqual([10, 'd_1'])
    const sql = String(txQ.mock.calls[1]![0])
    expect(sql).toContain('DELETE FROM doc_comment')
    expect(sql).toContain('(id = ? OR parent_id = ?) AND doc_id = ?')
    expect(txQ.mock.calls[1]![1]).toEqual([10, 10, 'd_1'])

    // Reply target (id=11): same statement; since no row has parent_id = 11
    // (single-level nesting), only the reply row itself is deleted.
    txQ.mockClear()
    await docCommentRepo.hardDelete(11, 'd_1')
    expect(txQ.mock.calls[0]![1]).toEqual([11, 'd_1'])
    expect(txQ.mock.calls[1]![1]).toEqual([11, 11, 'd_1'])
  })

  it('hardDelete cascade is doc-scoped: the doc_id bound makes it impossible to touch another doc', async () => {
    // Defense-in-depth: deleting root A in doc d_1 can only ever match rows in
    // d_1. The doc_id is part of the WHERE bound and a param — so root B and its
    // replies living in another doc can never be caught by this cascade, even if
    // an id collided. The statement is structurally incapable of crossing docs.
    const txQ = vi.fn(async () => [])
    vi.mocked(transaction).mockImplementation((async (fn: (tx: unknown) => unknown) =>
      fn({ query: txQ })) as never)

    await docCommentRepo.hardDelete(10, 'd_1')
    const sql = String(txQ.mock.calls[1]![0])
    const params = txQ.mock.calls[1]![1] as unknown[]
    expect(sql).toContain('AND doc_id = ?')
    expect(params).toContain('d_1')
    // No other doc's id appears in the bound — the delete cannot reach d_OTHER.
    expect(params).not.toContain('d_OTHER')
  })
})
