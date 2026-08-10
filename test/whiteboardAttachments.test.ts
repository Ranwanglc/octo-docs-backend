/**
 * Whiteboard image binary path — board-scoped upload + fetch contract (XIN-701).
 *
 * The object-storage upload/fetch surface is the SAME presign/read/resolve
 * router used for rich-text doc assets (src/api/routes/attachments.ts) — it is
 * doc-type-agnostic and gated by `requireDocRole`, whose authorization
 * (`resolveRole` = owner + doc_member) is identical for documents and boards.
 * These tests pin that the whiteboard case is a first-class, board-member-scoped
 * consumer of that path so a later doc_type gate can never silently exclude
 * boards, and they encode the exact FileRef handoff the front-end half (XIN-702)
 * must match: the `attachId` minted at presign is what lands in the scene Y.Doc
 * `files` container and is later exchanged for a signed GET URL.
 *
 * Offline unit test: mock the auth guard and the MySQL pool. The real handlers,
 * the real docAttachmentRepo, the real object-store signer and the real frozen
 * whiteboard schema all run — only live infra is mocked out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/api/guard.js', () => ({
  requireDocRole: vi.fn(),
}))
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async () => []),
  transaction: vi.fn(),
}))

import { presignHandler, readHandler } from '../src/api/routes/attachments.js'
import { requireDocRole } from '../src/api/guard.js'
import { query } from '../src/db/pool.js'
import { verifySignedUrl } from '../src/storage/objectStore.js'
import {
  normalizeElement,
  buildFileRef,
  normalizeFileRef,
  isUsableFileRef,
  FILE_REF_STATUS,
  FILE_REF_FIELDS,
  FILES_FIELD,
} from '../src/whiteboard/schema/index.js'
import { readFileRefs, getFilesMap } from '../src/whiteboard/ydoc.js'
import * as Y from 'yjs'

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

function req(uid: string, params: Record<string, string>, body?: unknown) {
  return { uid, spaceId: 's_board', params, body } as never
}

// A board doc_meta row — doc_type 'board'. The handlers never read doc_type
// (the path is type-agnostic); we still resolve a real board row so the guard
// contract mirrors production: board access === resolveRole on the board doc_id.
const BOARD_DOC_ID = 'b_wb1'
const boardWriterGuard = { meta: { doc_id: BOARD_DOC_ID, doc_type: 'board' }, role: 'writer' } as never
const boardReaderGuard = { meta: { doc_id: BOARD_DOC_ID, doc_type: 'board' }, role: 'reader' } as never

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(query).mockReset()
  vi.mocked(query).mockResolvedValue([] as never)
})

describe('board image upload (presign) is board-member scoped', () => {
  it('a board writer presigns an image and gets a stable attachId + verifiable PUT url under the board key', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(boardWriterGuard)
    const res = mockRes()
    await presignHandler(
      req('u_editor', { docId: BOARD_DOC_ID }, { fileName: 'diagram.png', mime: 'image/png', sizeBytes: 4096 }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    const body = res.body as { attachId: string; objectKey: string; uploadUrl: string; mime: string }
    // Stable, non-empty attachId — the id the FE stores in the files container.
    expect(typeof body.attachId).toBe('string')
    expect(body.attachId.length).toBeGreaterThan(0)
    // Object key is scoped under the BOARD's doc id (no arbitrary object write).
    expect(body.objectKey.startsWith(`${BOARD_DOC_ID}/`)).toBe(true)
    expect(body.objectKey).toBe(`${BOARD_DOC_ID}/${body.attachId}/diagram.png`)
    // Real, verifiable signature (not a stub).
    expect(verifySignedUrl(body.uploadUrl).valid).toBe(true)
    // Presign asked the guard for the WRITER tier on the board, scoped to the space.
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('writer')
    // A doc_attachment row was registered against the board doc id.
    const insert = vi.mocked(query).mock.calls.find((c) => String(c[0]).includes('INSERT INTO doc_attachment'))
    expect(insert).toBeTruthy()
    expect((insert![1] as unknown[])[1]).toBe(BOARD_DOC_ID)
  })

  it('a non-member is blocked — the guard writes its own error and the handler makes no DB write', async () => {
    // resolveRole -> none causes requireDocRole to write 403 and return null.
    vi.mocked(requireDocRole).mockResolvedValue(null as never)
    const res = mockRes()
    await presignHandler(
      req('u_outsider', { docId: BOARD_DOC_ID }, { fileName: 'x.png', mime: 'image/png', sizeBytes: 1024 }),
      res as never,
    )
    // Handler bailed out without touching the response or the DB.
    expect(res.statusCode).toBe(0)
    expect(vi.mocked(query)).not.toHaveBeenCalled()
  })

  it('enforces the image size tier on a board (11MB image/png rejected)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(boardWriterGuard)
    const res = mockRes()
    await presignHandler(
      req('u_editor', { docId: BOARD_DOC_ID }, { fileName: 'huge.png', mime: 'image/png', sizeBytes: 11 * 1024 * 1024 }),
      res as never,
    )
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe('size_too_large')
  })

  it('blocks image/svg+xml on a board (XSS) via the shared denylist', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(boardWriterGuard)
    const res = mockRes()
    await presignHandler(
      req('u_editor', { docId: BOARD_DOC_ID }, { fileName: 'evil.svg', mime: 'image/svg+xml', sizeBytes: 256 }),
      res as never,
    )
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe('mime_blocked')
  })
})

describe('board image fetch (read) is board-member scoped', () => {
  it('a board reader exchanges an owned attachId for a fresh, verifiable GET url', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(boardReaderGuard)
    vi.mocked(query).mockResolvedValue([
      {
        attach_id: 'att_board_1',
        doc_id: BOARD_DOC_ID,
        object_key: `${BOARD_DOC_ID}/att_board_1/diagram.png`,
        mime: 'image/png',
        size_bytes: 4096,
        file_name: 'diagram.png',
        created_by: 'u_editor',
        created_at: new Date(0),
      },
    ] as never)
    const res = mockRes()
    await readHandler(req('u_viewer', { docId: BOARD_DOC_ID, attachId: 'att_board_1' }), res as never)
    expect(res.statusCode).toBe(200)
    const body = res.body as { attachId: string; url: string; mime: string }
    expect(body.attachId).toBe('att_board_1')
    expect(body.mime).toBe('image/png')
    expect(verifySignedUrl(body.url).valid).toBe(true)
    // Read asked the guard for the READER tier.
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('reader')
  })

  it('404s an attachId owned by a different doc (no cross-board binary leak)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(boardReaderGuard)
    vi.mocked(query).mockResolvedValue([
      {
        attach_id: 'att_x',
        doc_id: 'b_other_board',
        object_key: 'b_other_board/att_x/a.png',
        mime: 'image/png',
        size_bytes: 1,
        file_name: 'a.png',
        created_by: 'u',
        created_at: new Date(0),
      },
    ] as never)
    const res = mockRes()
    await readHandler(req('u_viewer', { docId: BOARD_DOC_ID, attachId: 'att_x' }), res as never)
    expect(res.statusCode).toBe(404)
  })
})

describe('FileRef contract — the presign attachId round-trips into the scene files container', () => {
  it('builds the exact field set the front-end stores after presign', () => {
    const ref = buildFileRef({ attachId: 'att_board_1', mimeType: 'image/png', createdAt: 1_700_000_000_000 })
    // The frozen field names both sides key on.
    expect(FILE_REF_FIELDS).toEqual(['attachId', 'mimeType', 'status', 'createdAt'])
    expect(ref).toEqual({
      attachId: 'att_board_1',
      mimeType: 'image/png',
      status: FILE_REF_STATUS.saved,
      createdAt: 1_700_000_000_000,
    })
  })

  it('rejects a file ref with no usable attachId (the grey-placeholder shape)', () => {
    expect(normalizeFileRef({ mimeType: 'image/png', status: 'saved' })).toBeNull()
    expect(normalizeFileRef({ attachId: '' })).toBeNull()
    expect(normalizeFileRef({ attachId: 42 })).toBeNull()
    expect(isUsableFileRef(null)).toBe(false)
    expect(isUsableFileRef({ attachId: 'att_ok' })).toBe(true)
  })

  it('drops non-string mimeType/status and non-finite createdAt but preserves unknown fields', () => {
    const ref = normalizeFileRef({
      attachId: 'att_1',
      mimeType: 123,
      status: '',
      createdAt: Number.NaN,
      dataURL: 'blob:ignore-me',
    })
    expect(ref).toEqual({ attachId: 'att_1', dataURL: 'blob:ignore-me' })
  })

  it('an image element renders only when its fileId resolves to a usable ref in the files container', () => {
    const files = new Set(['file_ok'])
    const good = normalizeElement(
      { id: 'img1', type: 'image', version: 1, versionNonce: 7, fileId: 'file_ok' },
      { fileIds: files },
    )
    expect(good).not.toBeNull()
    // A dangling fileId (no files entry) is unrenderable and dropped (§2.3).
    const dangling = normalizeElement(
      { id: 'img2', type: 'image', version: 1, versionNonce: 7, fileId: 'file_missing' },
      { fileIds: files },
    )
    expect(dangling).toBeNull()
  })

  it('readFileRefs surfaces usable board refs and omits an attachId-less entry', () => {
    const doc = new Y.Doc()
    doc.transact(() => {
      const fl = doc.getMap(FILES_FIELD)
      const ok = new Y.Map()
      const built = buildFileRef({ attachId: 'att_board_1', mimeType: 'image/png', createdAt: 1_700_000_000_000 })
      for (const [k, v] of Object.entries(built)) ok.set(k, v)
      fl.set('file_ok', ok as Y.Map<unknown>)
      // A malformed entry with no attachId — must not surface as fetchable.
      const bad = new Y.Map()
      bad.set('mimeType', 'image/png')
      fl.set('file_bad', bad as Y.Map<unknown>)
    }, 'seed')

    const refs = readFileRefs(doc)
    expect([...refs.keys()]).toEqual(['file_ok'])
    expect(refs.get('file_ok')!.attachId).toBe('att_board_1')
    // Read-only: the raw container still holds both entries (no GC side effect).
    expect(getFilesMap(doc).size).toBe(2)
  })
})
