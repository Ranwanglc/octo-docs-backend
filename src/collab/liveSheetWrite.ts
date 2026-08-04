/**
 * Live-document side of a bot/agent spreadsheet edit (design §7.3, mirrors
 * liveRestore.ts).
 *
 * A bot edits a sheet by writing cells onto the SAME live in-memory Y.Doc the
 * connected human clients are editing, so they see the change in real time and
 * the write is the single authoritative content write (never clobbered by a
 * stale client union — see liveRestore.ts for the full union-direction rationale).
 *
 * openDirectConnection bypasses onAuthenticate (server-internal, carries no
 * client ctx — beforeHandleMessage's `if (!ctx) return` lets it through). So the
 * CALLER must enforce authorization before invoking this (the agent layer decides
 * which bot may write which sheet), exactly as the restore service does.
 */
import type { Document } from '@hocuspocus/server'
import * as Y from 'yjs'
import { getCollabServer } from './server.js'
import { validateSheetCellBatch, validateSheetDimBatch, validateSheetDrawingBatch, validateSheetHyperLinkBatch, validateSheetMergeBatch, validateSheetListBatch, assertSheetWriteAllowed, SHEET_YMAP_FIELD, SHEET_DIMS_FIELD, SHEET_DRAWINGS_FIELD, SHEET_HYPERLINKS_FIELD, SHEET_MERGES_FIELD, SHEET_LIST_FIELD, type SheetCell, type StoredDrawing, type StoredHyperLink, type StoredSheetMeta } from '../agent/sheetConversion.js'
import { advanceEditVersion } from './liveDocWrite.js'
import { stateVectorsEqual, BaseVersionStaleError } from './docBodyEdit.js'

/**
 * Read the live sheet document for a content read (mirrors readLiveForEdit).
 *
 * Returns the current authoritative Y.Doc binary state and its state vector,
 * read inside a single transact for a consistent view. Read-only: opens a
 * direct connection, snapshots, and disconnects without mutating. The caller
 * decodes the state with the shared sheetConversion primitives (so the HTTP read
 * and the version-restore preview share one validated decoder) and returns the
 * state vector as the baseVersion for a later optimistic-concurrency write.
 *
 * @param documentName canonical persistence/connection key for the sheet
 * @returns state — Y.Doc binary update; baseSV — its state vector
 */
export async function readLiveSheet(
  documentName: string,
): Promise<{ state: Uint8Array; baseSV: Uint8Array }> {
  const server = getCollabServer()
  const connection = await server.hocuspocus.openDirectConnection(documentName, { user: { id: 'system' } })
  let state!: Uint8Array
  let baseSV!: Uint8Array
  try {
    await connection.transact((doc: Document) => {
      state = Y.encodeStateAsUpdate(doc)
      baseSV = Y.encodeStateVector(doc)
    })
  } finally {
    await connection.disconnect()
  }
  return { state, baseSV }
}

/**
 * Commit a bot/human cell-edit batch onto the live sheet document under the
 * client base-version guard, and broadcast it. The write counterpart of
 * commitLiveEdit (doc body) — the same fail-closed optimistic-concurrency shape,
 * applied to the flat 'sheet' Y.Map instead of the ProseMirror fragment.
 *
 * The state-vector guard is the FIRST statement inside the transact and the cell
 * mutation is the LAST, so a drift between the caller's GET /:docId/sheet and
 * this commit throws BaseVersionStaleError BEFORE any mutation or broadcast
 * (never a silent last-writer-wins). The compared token is `clientBaseVersion` —
 * the value the caller read — not a re-read of this run's own SV.
 *
 * advanceEditVersion (shared with the doc path) bumps a doc-private counter so a
 * delete-only cell batch also moves the state vector forward; without it a
 * delete records only a tombstone and the base-version token would be reusable.
 *
 * openDirectConnection bypasses onAuthenticate (server-internal, carries no
 * client ctx). So the CALLER must enforce authorization before invoking this —
 * editDocSheet rechecks role + permission_epoch under the row lock, exactly as
 * the doc-body write service does.
 *
 * @param documentName      canonical persistence/connection key for the sheet
 * @param uid               acting user id (becomes doc_meta.updated_by on store)
 * @param clientBaseVersion the state vector the caller read from GET /:docId/sheet
 * @param cells             keyed cells to set; a null value deletes that cell
 * @returns newSV — the post-commit state vector; bytes — the stored Y.Doc size
 */
export async function commitLiveSheetEdit(
  documentName: string,
  uid: string,
  clientBaseVersion: Uint8Array,
  cells: Record<string, SheetCell | null>,
  dims: Record<string, number | null> = {},
  drawings: Record<string, StoredDrawing | null> = {},
  hyperlinks: Record<string, StoredHyperLink | null> = {},
  merges: Record<string, boolean | null> = {},
  sheets: Record<string, StoredSheetMeta | null> = {},
  /**
   * Whether the caller resolved `uid` as a doc admin, under the SAME doc_meta
   * lock that authorized the write. Defaults to false so an uninformed caller
   * gets the safe answer (protection enforced) rather than a bypass.
   */
  isAdmin = false,
): Promise<{ newSV: Uint8Array; bytes: number }> {
  const server = getCollabServer()
  const connection = await server.hocuspocus.openDirectConnection(documentName, { user: { id: uid } })
  let newSV!: Uint8Array
  let bytes = 0
  try {
    await connection.transact((doc: Document) => {
      // (1) PRIMARY guard — first statement, before any mutation. A drift since
      //     the caller's read throws with no write/broadcast (fail-closed).
      const currentSV = Y.encodeStateVector(doc)
      if (!stateVectorsEqual(clientBaseVersion, currentSV)) {
        throw new BaseVersionStaleError()
      }
      // (1b) PROTECTION guard — still before any mutation. Reads the protection
      //      rules + grant lists off the SAME live doc, so a non-admin writing
      //      into a protected range is rejected with nothing applied and nothing
      //      broadcast (same fail-closed shape as the stale-version guard above).
      //      openDirectConnection bypasses onAuthenticate, so this is the only
      //      place the bot/REST path can be held to the protection contract.
      //      `sheets` is passed too: the route allows sheets-only PATCHes, and a
      //      tab delete destroys every protected cell on that tab, so omitting it
      //      left a strictly-worse bypass than the cell write this guard refuses.
      assertSheetWriteAllowed(doc, cells, uid, isAdmin, dims, merges, sheets)
      // (2) The single, last content mutation. Validate ALL SIX batches FIRST
      //     (validate* return the split batches without mutating), THEN apply —
      //     so a bad dim/drawing can't leave cells half-applied. Yjs does NOT roll
      //     back a thrown transact callback and disconnect flushes onStore, so a
      //     per-map validate-then-mutate would broadcast a partial write on a
      //     mixed { good cells, bad dim } batch. Cross-map atomicity requires the
      //     validate-all-then-apply-all shape here (each apply* alone is only
      //     atomic within its own map).
      const cellBatch = validateSheetCellBatch(cells)
      const dimBatch = validateSheetDimBatch(dims)
      const drawingBatch = validateSheetDrawingBatch(drawings)
      const linkBatch = validateSheetHyperLinkBatch(hyperlinks)
      const mergeBatch = validateSheetMergeBatch(merges)
      const listBatch = validateSheetListBatch(sheets)
      const ymap = doc.getMap<SheetCell>(SHEET_YMAP_FIELD)
      for (const key of cellBatch.toDelete) ymap.delete(key)
      for (const [key, cell] of cellBatch.toSet) ymap.set(key, cell)
      const dimsMap = doc.getMap<number>(SHEET_DIMS_FIELD)
      for (const key of dimBatch.toDelete) dimsMap.delete(key)
      for (const [key, px] of dimBatch.toSet) dimsMap.set(key, px)
      const drawingMap = doc.getMap<StoredDrawing>(SHEET_DRAWINGS_FIELD)
      for (const key of drawingBatch.toDelete) drawingMap.delete(key)
      for (const [key, d] of drawingBatch.toSet) drawingMap.set(key, d)
      const linkMap = doc.getMap<StoredHyperLink>(SHEET_HYPERLINKS_FIELD)
      for (const key of linkBatch.toDelete) linkMap.delete(key)
      for (const [key, link] of linkBatch.toSet) linkMap.set(key, link)
      const mergeMap = doc.getMap<boolean>(SHEET_MERGES_FIELD)
      for (const key of mergeBatch.toDelete) mergeMap.delete(key)
      for (const [key, v] of mergeBatch.toSet) mergeMap.set(key, v)
      const listMap = doc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD)
      for (const key of listBatch.toDelete) listMap.delete(key)
      for (const [key, meta] of listBatch.toSet) listMap.set(key, meta)
      // (3) Advance the edit-version counter so a delete-only batch also moves
      //     the state vector forward; the token is read AFTER this bump.
      advanceEditVersion(doc)
      newSV = Y.encodeStateVector(doc)
      bytes = Y.encodeStateAsUpdate(doc).length
    })
  } finally {
    // Flushes the final store (awaited) and releases the direct connection.
    await connection.disconnect()
  }
  return { newSV, bytes }
}
