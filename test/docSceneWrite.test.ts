import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'

// Offline unit test (mirrors docSheetWrite.test.ts): mock the auth guard, the
// MySQL pool, and the live-board boundary. editBoardScene's batch validation +
// the safety-snapshot orchestration run for real against the mocked live read.
vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/db/pool.js', () => ({ query: vi.fn(async () => []), transaction: vi.fn() }))
vi.mock('../src/collab/liveBoardWrite.js', () => ({
  readLiveBoard: vi.fn(),
  commitLiveBoardEdit: vi.fn(),
}))

import { patchDocSceneHandler } from '../src/api/routes/docScene.js'
import { requireDocRole } from '../src/api/guard.js'
import { transaction } from '../src/db/pool.js'
import { readLiveBoard, commitLiveBoardEdit } from '../src/collab/liveBoardWrite.js'
import { docVersionRepo, KIND_RESTORE_MARKER } from '../src/db/repos/docVersionRepo.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { encodeBaseVersion, parseBaseVersion, BaseVersionStaleError } from '../src/collab/docBodyEdit.js'
import { WB_SCHEMA_VERSION } from '../src/whiteboard/schema/index.js'
import { getElementsMap } from '../src/whiteboard/ydoc.js'
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
    body: undefined,
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
function req(
  params: Record<string, string>,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
) {
  return { uid: 'u_1', spaceId: 's1', params, body: opts.body, headers: opts.headers ?? {} } as never
}

const writerGuard = {
  meta: { doc_id: 'b_1', document_name: 'octo:s1:f_default:wb:b_1', doc_type: 'board', permission_epoch: 7 },
  role: 'writer',
} as never

function rect(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: 'rectangle', index: 'a0', x: 0, y: 0, width: 10, height: 10, version: 1, versionNonce: 1, ...over }
}

/** A live board {state, baseSV} from elements. */
function liveBoard(elements: Array<Record<string, unknown>> = []) {
  const doc = new Y.Doc()
  const elMap = getElementsMap(doc)
  doc.transact(() => {
    for (const el of elements) {
      const y = new Y.Map<unknown>()
      for (const [k, v] of Object.entries(el)) y.set(k, v)
      elMap.set(el.id as string, y)
    }
  })
  return { state: Y.encodeStateAsUpdate(doc), baseSV: Y.encodeStateVector(doc) }
}

/** transaction() mock routing SQL to a metaRow; role recheck spied separately. */
function mockTx(metaRow: { owner_id: string; permission_epoch: number; status: number } | null) {
  vi.mocked(transaction).mockImplementation(async (fn: never) => {
    const tx = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM yjs_document')) return []
        if (sql.includes('FROM doc_meta')) return metaRow ? [metaRow] : []
        return []
      }),
    }
    return (fn as unknown as (t: typeof tx) => Promise<unknown>)(tx)
  })
}

const okMeta = { owner_id: 'u_1', permission_epoch: 7, status: 1 }
function bodyFor(view: { baseSV: Uint8Array }, ops: Record<string, unknown>) {
  return { baseVersion: encodeBaseVersion(view.baseSV), ...ops }
}

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(transaction).mockReset()
  vi.mocked(readLiveBoard).mockReset()
  vi.mocked(commitLiveBoardEdit).mockReset()
})

// ── role gating ─────────────────────────────────────────────────────────────
describe('role gating (server authority)', () => {
  it('PATCH /scene requires writer in the caller space', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(null)
    await patchDocSceneHandler(req({ docId: 'b_1' }), mockRes() as never)
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('writer')
    expect(vi.mocked(readLiveBoard)).not.toHaveBeenCalled()
  })
})

// ── doc_type gate ─────────────────────────────────────────────────────────────
describe('doc_type gate', () => {
  it('rejects a non-board target with 409 unsupported_doc_type', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({
      meta: { doc_id: 'd_1', document_name: 'octo:s1:f_default:d_1', doc_type: 'sheet', permission_epoch: 1 },
      role: 'writer',
    } as never)
    const res = mockRes()
    await patchDocSceneHandler(
      req({ docId: 'd_1' }, { body: { baseVersion: 'x', elements: [rect('e1')] } }),
      res as never,
    )
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'unsupported_doc_type' })
    expect(vi.mocked(readLiveBoard)).not.toHaveBeenCalled()
  })
})

// ── request-shape validation ──────────────────────────────────────────────────
describe('request shape', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(writerGuard))

  it('400 when baseVersion (If-Match / body) is absent', async () => {
    const res = mockRes()
    await patchDocSceneHandler(req({ docId: 'b_1' }, { body: { elements: [rect('e1')] } }), res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_body' })
    expect(vi.mocked(readLiveBoard)).not.toHaveBeenCalled()
  })

  it('400 when the ops batch is empty or malformed', async () => {
    for (const ops of [{}, { elements: [] }, { elements: 'x' }, { deletedElementIds: 'x' }, { files: [] }]) {
      const res = mockRes()
      await patchDocSceneHandler(req({ docId: 'b_1' }, { body: { baseVersion: 'v', ...ops } }), res as never)
      expect(res.statusCode).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_body' })
    }
    expect(vi.mocked(readLiveBoard)).not.toHaveBeenCalled()
  })

  it('accepts the base version from the If-Match header', async () => {
    const view = liveBoard()
    vi.mocked(readLiveBoard).mockResolvedValue(view)
    vi.mocked(commitLiveBoardEdit).mockResolvedValue({ newSV: Y.encodeStateVector(new Y.Doc()), bytes: 12 })
    vi.spyOn(docVersionRepo, 'createTx').mockResolvedValue(5)
    mockTx(okMeta)

    const token = encodeBaseVersion(view.baseSV)
    const res = mockRes()
    await patchDocSceneHandler(
      req({ docId: 'b_1' }, { body: { elements: [rect('e1')] }, headers: { 'if-match': `"${token}"` } }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    // The guard compared the CLIENT token, quotes stripped.
    expect(vi.mocked(commitLiveBoardEdit).mock.calls[0]![2]).toEqual(parseBaseVersion(token))
  })

  it('413 too_many_elements when the batch exceeds the cap', async () => {
    const original = config.boardSceneWrite.maxElements
    config.boardSceneWrite.maxElements = 2
    try {
      const res = mockRes()
      await patchDocSceneHandler(
        req({ docId: 'b_1' }, { body: { baseVersion: 'v', elements: [rect('a'), rect('b'), rect('c')] } }),
        res as never,
      )
      expect(res.statusCode).toBe(413)
      expect(res.body).toEqual({ error: 'too_many_elements' })
      expect(vi.mocked(readLiveBoard)).not.toHaveBeenCalled()
    } finally {
      config.boardSceneWrite.maxElements = original
    }
  })

  it('413 element_too_large when a single element payload exceeds the cap', async () => {
    const original = config.boardSceneWrite.maxElementContentBytes
    config.boardSceneWrite.maxElementContentBytes = 40
    try {
      const res = mockRes()
      await patchDocSceneHandler(
        req({ docId: 'b_1' }, { body: { baseVersion: 'v', elements: [rect('e1', { note: 'x'.repeat(200) })] } }),
        res as never,
      )
      expect(res.statusCode).toBe(413)
      expect(res.body).toEqual({ error: 'element_too_large' })
    } finally {
      config.boardSceneWrite.maxElementContentBytes = original
    }
  })
})

// ── happy path: batch write + safety snapshot ─────────────────────────────────
describe('PATCH /scene — batch write', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(writerGuard))

  it('upserts an element, records a KIND_RESTORE_MARKER safety snapshot (WB schema), returns the new base version', async () => {
    const view = liveBoard([rect('e0', { version: 1 })])
    vi.mocked(readLiveBoard).mockResolvedValue(view)
    const newSV = Y.encodeStateVector((() => { const d = new Y.Doc(); d.getMap('x').set('a', 1); return d })())
    vi.mocked(commitLiveBoardEdit).mockResolvedValue({ newSV, bytes: 321 })
    const createSpy = vi.spyOn(docVersionRepo, 'createTx').mockResolvedValue(42)
    mockTx(okMeta)

    const res = mockRes()
    await patchDocSceneHandler(
      req({ docId: 'b_1' }, { body: bodyFor(view, { elements: [rect('e1', { x: 5, version: 2 })] }) }),
      res as never,
    )

    expect(res.statusCode).toBe(200)
    const body = res.body as { docId: string; bytes: number; baseVersion: string; newDocVersionSeq: number }
    expect(body.docId).toBe('b_1')
    expect(body.bytes).toBe(321)
    expect(body.baseVersion).toBe(encodeBaseVersion(newSV))
    expect(body.newDocVersionSeq).toBe(42)

    // Safety snapshot is a KIND_RESTORE_MARKER of the PRE-edit state, stamped WB schema.
    expect(createSpy).toHaveBeenCalledTimes(1)
    const snap = createSpy.mock.calls[0]![1]
    expect(snap.kind).toBe(KIND_RESTORE_MARKER)
    expect(snap.state).toBe(view.state)
    expect(snap.schemaVersion).toBe(WB_SCHEMA_VERSION)
    // commitLiveBoardEdit got the acting uid + the validated batch.
    expect(vi.mocked(commitLiveBoardEdit).mock.calls[0]![1]).toBe('u_1')
    const validated = vi.mocked(commitLiveBoardEdit).mock.calls[0]![3] as { upserts: Array<{ id: string }> }
    expect(validated.upserts.map((e) => e.id)).toEqual(['e1'])
  })

  it('supports deleting an element via deletedElementIds', async () => {
    const view = liveBoard([rect('e1')])
    vi.mocked(readLiveBoard).mockResolvedValue(view)
    vi.mocked(commitLiveBoardEdit).mockResolvedValue({ newSV: Y.encodeStateVector(new Y.Doc()), bytes: 10 })
    vi.spyOn(docVersionRepo, 'createTx').mockResolvedValue(1)
    mockTx(okMeta)

    const res = mockRes()
    await patchDocSceneHandler(
      req({ docId: 'b_1' }, { body: bodyFor(view, { deletedElementIds: ['e1'] }) }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    const validated = vi.mocked(commitLiveBoardEdit).mock.calls[0]![3] as { deletes: string[] }
    expect(validated.deletes).toEqual(['e1'])
  })
})

// ── element whitelist / file ref contract (fail-closed → 422) ─────────────────
describe('scene contract validation', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(writerGuard))

  it('422 board_element_invalid on a non-whitelisted element type, before any lock/write', async () => {
    const view = liveBoard()
    vi.mocked(readLiveBoard).mockResolvedValue(view)
    const createSpy = vi.spyOn(docVersionRepo, 'createTx')
    mockTx(okMeta)

    const res = mockRes()
    await patchDocSceneHandler(
      req({ docId: 'b_1' }, { body: bodyFor(view, { elements: [{ id: 'e1', type: 'malicious' }] }) }),
      res as never,
    )
    expect(res.statusCode).toBe(422)
    expect(res.body).toEqual({ error: 'board_element_invalid' })
    expect(createSpy).not.toHaveBeenCalled()
    expect(vi.mocked(commitLiveBoardEdit)).not.toHaveBeenCalled()
  })

  it('422 board_file_invalid on a file ref with no usable attachId', async () => {
    const view = liveBoard()
    vi.mocked(readLiveBoard).mockResolvedValue(view)
    mockTx(okMeta)

    const res = mockRes()
    await patchDocSceneHandler(
      req({ docId: 'b_1' }, { body: bodyFor(view, { files: { f1: { mimeType: 'image/png' } } }) }),
      res as never,
    )
    expect(res.statusCode).toBe(422)
    expect(res.body).toEqual({ error: 'board_file_invalid' })
    expect(vi.mocked(commitLiveBoardEdit)).not.toHaveBeenCalled()
  })
})

// ── optimistic concurrency + safety contract ──────────────────────────────────
describe('optimistic concurrency & safety contract', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(writerGuard))

  it('412 base_version_stale in the pre-flight when the token no longer matches', async () => {
    const view = liveBoard([rect('e1')])
    vi.mocked(readLiveBoard).mockResolvedValue(view)
    const createSpy = vi.spyOn(docVersionRepo, 'createTx')
    mockTx(okMeta)

    const stale = encodeBaseVersion(Y.encodeStateVector(new Y.Doc()))
    const res = mockRes()
    await patchDocSceneHandler(
      req({ docId: 'b_1' }, { body: { baseVersion: stale, elements: [rect('e1', { version: 2 })] } }),
      res as never,
    )
    expect(res.statusCode).toBe(412)
    expect(res.body).toEqual({ error: 'base_version_stale' })
    expect(createSpy).not.toHaveBeenCalled()
    expect(vi.mocked(commitLiveBoardEdit)).not.toHaveBeenCalled()
  })

  it('412 from the live guard compensates the safety snapshot', async () => {
    const view = liveBoard([rect('e1')])
    vi.mocked(readLiveBoard).mockResolvedValue(view)
    vi.mocked(commitLiveBoardEdit).mockRejectedValue(new BaseVersionStaleError())
    vi.spyOn(docVersionRepo, 'createTx').mockResolvedValue(77)
    const delSpy = vi.spyOn(docVersionRepo, 'deleteById').mockResolvedValue(undefined)
    mockTx(okMeta)

    const res = mockRes()
    await patchDocSceneHandler(
      req({ docId: 'b_1' }, { body: bodyFor(view, { elements: [rect('e1', { version: 2 })] }) }),
      res as never,
    )
    expect(res.statusCode).toBe(412)
    expect(res.body).toEqual({ error: 'base_version_stale' })
    expect(delSpy).toHaveBeenCalledWith(77)
  })

  it('409 epoch_changed when permission_epoch moved under the lock', async () => {
    const view = liveBoard()
    vi.mocked(readLiveBoard).mockResolvedValue(view)
    const createSpy = vi.spyOn(docVersionRepo, 'createTx')
    mockTx({ owner_id: 'u_1', permission_epoch: 8, status: 1 })

    const res = mockRes()
    await patchDocSceneHandler(
      req({ docId: 'b_1' }, { body: bodyFor(view, { elements: [rect('e1')] }) }),
      res as never,
    )
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'epoch_changed' })
    expect(createSpy).not.toHaveBeenCalled()
    expect(vi.mocked(commitLiveBoardEdit)).not.toHaveBeenCalled()
  })

  it('403 forbidden when the re-checked role is below writer', async () => {
    const view = liveBoard()
    vi.mocked(readLiveBoard).mockResolvedValue(view)
    mockTx({ owner_id: 'someone_else', permission_epoch: 7, status: 1 })
    vi.spyOn(docMemberRepo, 'getRoleTx').mockResolvedValue('reader')

    const res = mockRes()
    await patchDocSceneHandler(
      req({ docId: 'b_1' }, { body: bodyFor(view, { elements: [rect('e1')] }) }),
      res as never,
    )
    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({ error: 'forbidden' })
    expect(vi.mocked(commitLiveBoardEdit)).not.toHaveBeenCalled()
  })

  it('404 not_found when the row is missing/deleted under the lock', async () => {
    const view = liveBoard()
    vi.mocked(readLiveBoard).mockResolvedValue(view)
    mockTx({ owner_id: 'u_1', permission_epoch: 7, status: 0 })

    const res = mockRes()
    await patchDocSceneHandler(req({ docId: 'b_1' }, { body: bodyFor(view, { elements: [rect('e1')] }) }), res as never)
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
  })
})

// ── size gate: reject an oversized result BEFORE the live commit ───────────────
describe('cumulative size gate', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(writerGuard))

  it('413 doc_too_large when the post-edit Y.Doc would exceed maxDocBytes, before any snapshot/commit', async () => {
    const view = liveBoard([rect('e0')])
    vi.mocked(readLiveBoard).mockResolvedValue(view)
    const createSpy = vi.spyOn(docVersionRepo, 'createTx')
    mockTx(okMeta)

    const original = config.maxDocBytes
    config.maxDocBytes = 40
    try {
      const res = mockRes()
      await patchDocSceneHandler(
        req({ docId: 'b_1' }, { body: bodyFor(view, { elements: [rect('e1', { version: 2 })] }) }),
        res as never,
      )
      expect(res.statusCode).toBe(413)
      const body = res.body as { error: string; docBytes: number; limit: number }
      expect(body.error).toBe('doc_too_large')
      expect(body.limit).toBe(40)
      expect(body.docBytes).toBeGreaterThan(40)
      expect(createSpy).not.toHaveBeenCalled()
      expect(vi.mocked(commitLiveBoardEdit)).not.toHaveBeenCalled()
    } finally {
      config.maxDocBytes = original
    }
  })
})

// ── store-time failure preserves the safety snapshot ──────────────────────────
describe('compensation delete is scoped to pre-mutation guard errors', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(writerGuard))

  it('keeps the safety snapshot + 500 when the live commit fails AFTER the mutation/broadcast', async () => {
    const view = liveBoard([rect('e1')])
    vi.mocked(readLiveBoard).mockResolvedValue(view)
    vi.mocked(commitLiveBoardEdit).mockRejectedValue(new Error('store overflow after broadcast'))
    vi.spyOn(docVersionRepo, 'createTx').mockResolvedValue(88)
    const delSpy = vi.spyOn(docVersionRepo, 'deleteById').mockResolvedValue(undefined)
    mockTx(okMeta)

    const res = mockRes()
    await patchDocSceneHandler(
      req({ docId: 'b_1' }, { body: bodyFor(view, { elements: [rect('e1', { version: 2 })] }) }),
      res as never,
    )
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ error: 'internal_error' })
    expect(delSpy).not.toHaveBeenCalled()
  })
})
