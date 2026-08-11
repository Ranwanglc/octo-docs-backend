import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { Node as PMNode } from 'prosemirror-model'
import { yDocToProsemirrorJSON } from 'y-prosemirror'
import { COLLAB_FIELD } from '../src/schema/index.js'
import { SHEET_YMAP_FIELD, SHEET_DIMS_FIELD } from '../src/agent/sheetConversion.js'
import { getElementsMap } from '../src/whiteboard/ydoc.js'

// End-to-end REST write-path regression for #64 B1/B2 (Jerry-Xin / OctoBoooot,
// yujiawei). Unlike the docContent/docScene/docSheetWrite unit tests, this file
// does NOT mock the auth guard — the REAL requireDocRole runs against a mocked
// doc_meta row + membership stub, and the REAL edit services run against a mocked
// pool/live boundary. This is the seam the reviewers said no test covered: a
// share-derived editor (anyone_in_space + edit + NO doc_member row + positive
// space membership) driving a full PATCH through the under-lock recheck.
//
// Before the fix the under-lock recheck used direct role only, so every case
// below 403'd inside the service after passing the route guard. After the fix
// the under-lock recheck resolves the same effectiveRole as the guard, so a
// legitimate share editor completes the write (200) and a non-member is denied.
vi.mock('../src/db/repos/docMetaRepo.js', () => ({ docMetaRepo: { getByDocId: vi.fn() } }))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: { getRole: vi.fn(), getRoleTx: vi.fn() },
}))
vi.mock('../src/db/pool.js', () => ({ query: vi.fn(async () => []), transaction: vi.fn() }))
vi.mock('../src/collab/liveDocWrite.js', () => ({ readLiveForEdit: vi.fn(), commitLiveEdit: vi.fn() }))
vi.mock('../src/collab/liveBoardWrite.js', () => ({ readLiveBoard: vi.fn(), commitLiveBoardEdit: vi.fn() }))
vi.mock('../src/collab/liveSheetWrite.js', () => ({ readLiveSheet: vi.fn(), commitLiveSheetEdit: vi.fn() }))

import { patchDocContentHandler } from '../src/api/routes/docContent.js'
import { patchDocSceneHandler } from '../src/api/routes/docScene.js'
import { patchDocSheetHandler } from '../src/api/routes/docSheet.js'
import { getDocHandler } from '../src/api/routes/docs.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { transaction } from '../src/db/pool.js'
import { readLiveForEdit, commitLiveEdit } from '../src/collab/liveDocWrite.js'
import { readLiveBoard, commitLiveBoardEdit } from '../src/collab/liveBoardWrite.js'
import { readLiveSheet, commitLiveSheetEdit } from '../src/collab/liveSheetWrite.js'
import { docVersionRepo } from '../src/db/repos/docVersionRepo.js'
import { setOctoIdentity } from '../src/auth/octoIdentity.js'
import { encodeBaseVersion, schema } from '../src/collab/docBodyEdit.js'

// ── mock req/res ──────────────────────────────────────────────────────────────
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
function req(uid: string, params: Record<string, string>, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
  // Human open-context mount policy (remove-sp §6): locate by docId, resolve
  // anyone_in_space membership against the doc home space.
  return { uid, spaceId: 's1', docSpaceScope: { mode: 'human' as const }, params, body: opts.body, headers: opts.headers ?? {} } as never
}

const SPACE = 's1'
const OWNER = 'u_owner'
const MEMBER = 'u_member' // a space member with NO doc_member row (share-derived)

/** A full doc_meta row the guard reads via getByDocId. */
const meta = (over: Record<string, unknown> = {}) => ({
  doc_id: 'd_1',
  document_name: 'octo:s1:f_default:d_1',
  owner_id: OWNER,
  space_id: SPACE,
  folder_id: 'f_default',
  doc_type: 'doc',
  title: 't',
  status: 1,
  permission_epoch: 7,
  share_scope: 1, // anyone_in_space
  share_role: 2, // edit
  created_at: '2026-07-14T00:00:00Z',
  updated_at: '2026-07-14T00:00:00Z',
  ...over,
})

/**
 * transaction() mock routing the FOR UPDATE doc_meta SELECT to a locked row that
 * carries the #64 share columns (the fix widened the SELECT to include them).
 */
function mockTx(lockedRow: Record<string, unknown>) {
  vi.mocked(transaction).mockImplementation(async (fn: never) => {
    const tx = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM yjs_document')) return []
        if (sql.includes('FROM doc_meta')) return [lockedRow]
        return []
      }),
    }
    return (fn as unknown as (t: typeof tx) => Promise<unknown>)(tx)
  })
}
const lockedShareRow = {
  owner_id: OWNER,
  permission_epoch: 7,
  status: 1,
  space_id: SPACE,
  share_scope: 1,
  share_role: 2,
}

/** Inject an identity whose isSpaceMember returns a fixed value. */
function memberIs(value: boolean) {
  setOctoIdentity({ isSpaceMember: async () => value } as never)
}

// ── live-view builders (one per surface) ────────────────────────────────────────
function emptyDocView() {
  const doc = new Y.Doc()
  doc.get(COLLAB_FIELD, Y.XmlFragment)
  const pmDoc = PMNode.fromJSON(schema, yDocToProsemirrorJSON(doc, COLLAB_FIELD) as never)
  return { pmDoc, baseSV: Y.encodeStateVector(doc), preEditState: Y.encodeStateAsUpdate(doc) }
}
function emptyBoardView() {
  const doc = new Y.Doc()
  getElementsMap(doc)
  return { state: Y.encodeStateAsUpdate(doc), baseSV: Y.encodeStateVector(doc) }
}
function emptySheetView() {
  const doc = new Y.Doc()
  doc.getMap(SHEET_YMAP_FIELD)
  doc.getMap(SHEET_DIMS_FIELD)
  return { state: Y.encodeStateAsUpdate(doc), baseSV: Y.encodeStateVector(doc) }
}
function rect(id: string): Record<string, unknown> {
  return { id, type: 'rectangle', index: 'a0', x: 0, y: 0, width: 10, height: 10, version: 1, versionNonce: 1 }
}

beforeEach(() => {
  vi.mocked(docMetaRepo.getByDocId).mockReset()
  vi.mocked(docMemberRepo.getRole).mockReset()
  vi.mocked(docMemberRepo.getRoleTx).mockReset()
  vi.mocked(transaction).mockReset()
  vi.mocked(readLiveForEdit).mockReset()
  vi.mocked(commitLiveEdit).mockReset()
  vi.mocked(readLiveBoard).mockReset()
  vi.mocked(commitLiveBoardEdit).mockReset()
  vi.mocked(readLiveSheet).mockReset()
  vi.mocked(commitLiveSheetEdit).mockReset()
  // Default: a space member with no doc_member row anywhere.
  vi.mocked(docMemberRepo.getRole).mockResolvedValue(null as never)
  vi.mocked(docMemberRepo.getRoleTx).mockResolvedValue(undefined as never)
  vi.spyOn(docVersionRepo, 'createTx').mockResolvedValue(42)
  vi.spyOn(docVersionRepo, 'deleteById').mockResolvedValue(undefined)
})

describe('B1 — share-derived editor completes the transactional write path (#64)', () => {
  it('PATCH /content: anyone_in_space/edit + no doc_member + member => 200 (was 403 pre-fix)', async () => {
    const view = emptyDocView()
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta() as never)
    vi.mocked(readLiveForEdit).mockResolvedValue(view)
    vi.mocked(commitLiveEdit).mockResolvedValue({ newSV: Y.encodeStateVector(new Y.Doc()), bytes: 10 } as never)
    mockTx(lockedShareRow)
    memberIs(true)

    const res = mockRes()
    await patchDocContentHandler(
      req(MEMBER, { docId: 'd_1' }, {
        headers: { 'if-match': `"${encodeBaseVersion(view.baseSV)}"` },
        body: { ops: [{ type: 'insert', at: { path: [], position: 'inside_end' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] }] },
      }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    expect(vi.mocked(commitLiveEdit)).toHaveBeenCalledTimes(1)
  })

  it('PATCH /scene: anyone_in_space/edit + no doc_member + member => 200 (was 403 pre-fix)', async () => {
    const view = emptyBoardView()
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta({ doc_type: 'board', document_name: 'octo:s1:f_default:wb:d_1' }) as never)
    vi.mocked(readLiveBoard).mockResolvedValue(view)
    vi.mocked(commitLiveBoardEdit).mockResolvedValue({ newSV: Y.encodeStateVector(new Y.Doc()), bytes: 20 } as never)
    mockTx(lockedShareRow)
    memberIs(true)

    const res = mockRes()
    await patchDocSceneHandler(
      req(MEMBER, { docId: 'd_1' }, { body: { baseVersion: encodeBaseVersion(view.baseSV), elements: [rect('e1')] } }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    expect(vi.mocked(commitLiveBoardEdit)).toHaveBeenCalledTimes(1)
  })

  it('PATCH /sheet: anyone_in_space/edit + no doc_member + member => 200 (was 403 pre-fix)', async () => {
    const view = emptySheetView()
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta({ doc_type: 'sheet' }) as never)
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    vi.mocked(commitLiveSheetEdit).mockResolvedValue({ newSV: Y.encodeStateVector(new Y.Doc()), bytes: 30 } as never)
    mockTx(lockedShareRow)
    memberIs(true)

    const res = mockRes()
    await patchDocSheetHandler(
      req(MEMBER, { docId: 'd_1' }, { body: { baseVersion: encodeBaseVersion(view.baseSV), cells: { 'default!0:0': { v: 1 } } } }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    expect(vi.mocked(commitLiveSheetEdit)).toHaveBeenCalledTimes(1)
  })

  it('a non-member is still denied at the route guard (403), never reaching the service', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta() as never)
    mockTx(lockedShareRow)
    memberIs(false) // NOT a space member

    const res = mockRes()
    await patchDocContentHandler(
      req('u_stranger', { docId: 'd_1' }, {
        headers: { 'if-match': '"AA=="' },
        body: { ops: [{ type: 'insert', at: { path: [], position: 'inside_end' }, content: [{ type: 'paragraph' }] }] },
      }),
      res as never,
    )
    expect(res.statusCode).toBe(403)
    expect(vi.mocked(readLiveForEdit)).not.toHaveBeenCalled()
  })

  it('a restricted doc adds no membership call and still 403s a share-less caller', async () => {
    let calls = 0
    setOctoIdentity({ isSpaceMember: async () => { calls += 1; return true } } as never)
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta({ share_scope: 0, share_role: 1 }) as never)
    mockTx({ ...lockedShareRow, share_scope: 0, share_role: 1 })

    const res = mockRes()
    await patchDocContentHandler(
      req(MEMBER, { docId: 'd_1' }, {
        headers: { 'if-match': '"AA=="' },
        body: { ops: [{ type: 'insert', at: { path: [], position: 'inside_end' }, content: [{ type: 'paragraph' }] }] },
      }),
      res as never,
    )
    expect(res.statusCode).toBe(403)
    expect(calls).toBe(0) // restricted short-circuits the share path entirely
  })
})

describe('B2 — GET /docs reports the EFFECTIVE role, not just enough-to-pass (#64)', () => {
  it('a direct reader on an anyone_in_space/edit doc is reported as writer', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta() as never)
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('reader' as never) // direct reader
    memberIs(true)

    const res = mockRes()
    await getDocHandler(req('u_reader', { docId: 'd_1' }), res as never)
    expect(res.statusCode).toBe(200)
    // Pre-fix the guard returned 'reader' (direct role already passed the reader
    // gate, so effectiveRole was never computed); the client rendered read-only.
    expect((res.body as { role: string }).role).toBe('writer')
  })

  it('a direct reader on a read-share doc stays reader (effectiveRole raise-only)', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta({ share_role: 1 }) as never)
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('reader' as never)
    memberIs(true)

    const res = mockRes()
    await getDocHandler(req('u_reader', { docId: 'd_1' }), res as never)
    expect((res.body as { role: string }).role).toBe('reader')
  })
})
