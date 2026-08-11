import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { COLLAB_FIELD } from '../src/schema/index.js'

// Offline unit test (mirrors docContent.test.ts / docSheet-side): mock the auth
// guard and the live-board read boundary. decodeBoardSnapshot runs for real.
vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/collab/liveBoardWrite.js', () => ({
  readLiveBoard: vi.fn(),
  commitLiveBoardEdit: vi.fn(),
}))

import { getDocSceneHandler } from '../src/api/routes/docScene.js'
import { requireDocRole } from '../src/api/guard.js'
import { readLiveBoard } from '../src/collab/liveBoardWrite.js'
import { encodeBaseVersion } from '../src/collab/docBodyEdit.js'
import { WB_SCHEMA_VERSION } from '../src/whiteboard/schema/index.js'
import { getElementsMap, getFilesMap } from '../src/whiteboard/ydoc.js'

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
function req(params: Record<string, string>) {
  return { uid: 'u_1', spaceId: 's1', params, query: {}, headers: {} } as never
}

const boardGuard = {
  meta: { doc_id: 'b_1', document_name: 'octo:s1:f_default:wb:b_1', doc_type: 'board', permission_epoch: 1 },
  role: 'reader',
} as never

function rect(id: string, index: string, x = 0): Record<string, unknown> {
  return { id, type: 'rectangle', index, x, y: 0, width: 100, height: 50, version: 1, versionNonce: 1 }
}

/** A live board {state, baseSV} built from elements + files. */
function liveBoard(
  elements: Array<Record<string, unknown>> = [],
  files: Record<string, Record<string, unknown>> = {},
) {
  const doc = new Y.Doc()
  const elMap = getElementsMap(doc)
  const fMap = getFilesMap(doc)
  doc.transact(() => {
    for (const el of elements) {
      const y = new Y.Map<unknown>()
      for (const [k, v] of Object.entries(el)) y.set(k, v)
      elMap.set(el.id as string, y)
    }
    for (const [fid, f] of Object.entries(files)) {
      const y = new Y.Map<unknown>()
      for (const [k, v] of Object.entries(f)) y.set(k, v)
      fMap.set(fid, y)
    }
  })
  return { state: Y.encodeStateAsUpdate(doc), baseSV: Y.encodeStateVector(doc) }
}

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(readLiveBoard).mockReset()
})

describe('GET /scene — role gating', () => {
  it('requires reader in the caller space and short-circuits when blocked', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(null)
    await getDocSceneHandler(req({ docId: 'b_1' }), mockRes() as never)
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('reader')
    expect(vi.mocked(readLiveBoard)).not.toHaveBeenCalled()
  })
})

describe('GET /scene — doc_type gate', () => {
  it('rejects a non-board target with 409 unsupported_doc_type', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({
      meta: { doc_id: 'd_1', document_name: 'octo:s1:f_default:d_1', doc_type: 'doc', permission_epoch: 1 },
      role: 'reader',
    } as never)
    const res = mockRes()
    await getDocSceneHandler(req({ docId: 'd_1' }), res as never)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'unsupported_doc_type' })
    expect(vi.mocked(readLiveBoard)).not.toHaveBeenCalled()
  })
})

describe('GET /scene — read live scene', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(boardGuard))

  it('returns elements (fractional-index order), files, base version + schema version', async () => {
    // Deliberately out of z-order to prove the handler returns index order.
    const view = liveBoard(
      [rect('e2', 'a2', 20), rect('e1', 'a1', 10)],
      { f1: { attachId: 'a1', mimeType: 'image/png', status: 'saved' } },
    )
    vi.mocked(readLiveBoard).mockResolvedValue(view)

    const res = mockRes()
    await getDocSceneHandler(req({ docId: 'b_1' }), res as never)

    expect(res.statusCode).toBe(200)
    const body = res.body as {
      docId: string
      elements: Array<Record<string, unknown>>
      files: Record<string, unknown>
      baseVersion: string
      schemaVersion: number
    }
    expect(body.docId).toBe('b_1')
    expect(body.elements.map((e) => e.id)).toEqual(['e1', 'e2'])
    expect(body.files.f1).toMatchObject({ attachId: 'a1' })
    expect(body.baseVersion).toBe(encodeBaseVersion(view.baseSV))
    expect(body.schemaVersion).toBe(WB_SCHEMA_VERSION)
  })

  it('returns an empty scene for a brand-new board', async () => {
    vi.mocked(readLiveBoard).mockResolvedValue(liveBoard())
    const res = mockRes()
    await getDocSceneHandler(req({ docId: 'b_1' }), res as never)
    expect(res.statusCode).toBe(200)
    const body = res.body as { elements: unknown[]; files: Record<string, unknown> }
    expect(body.elements).toEqual([])
    expect(body.files).toEqual({})
  })

  it('409 board_snapshot_invalid when the live state is a wrong-kind blob', async () => {
    // A ProseMirror doc (COLLAB_FIELD fragment) mis-routed as a board: assertBoardShape
    // inside decodeBoardSnapshot throws, and the handler maps it to 409.
    const doc = new Y.Doc()
    doc.get(COLLAB_FIELD, Y.XmlFragment)
    doc.transact(() => doc.getXmlFragment(COLLAB_FIELD).insert(0, [new Y.XmlElement('paragraph')]))
    vi.mocked(readLiveBoard).mockResolvedValue({
      state: Y.encodeStateAsUpdate(doc),
      baseSV: Y.encodeStateVector(doc),
    })

    const res = mockRes()
    await getDocSceneHandler(req({ docId: 'b_1' }), res as never)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'board_snapshot_invalid' })
  })
})
