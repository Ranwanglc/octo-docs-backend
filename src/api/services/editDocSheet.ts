/**
 * Bot/human sheet cell-edit orchestration (gate b — aligned to the doc-body
 * write's full safety contract, mirrors editDocBody.ts). Three timing phases
 * with a strict lock boundary:
 *
 *   1. Pre-flight (NO lock): read the live sheet, fail fast on a stale client
 *      base version (412) or a cell batch that violates the {v,f,s} contract
 *      (422), so most conflicts and all bad input return before any snapshot row.
 *   2. Auth-recheck + safety-snapshot TRANSACTION: lock yjs_document then
 *      doc_meta FOR UPDATE (same order as persistence.store — deadlock-free),
 *      re-check role + permission_epoch under the lock (server authority, not
 *      just the route gate — the live write bypasses onAuthenticate), record a
 *      KIND_RESTORE_MARKER safety snapshot of the PRE-edit state, then COMMIT —
 *      releasing both locks before the live write (commitLiveSheetEdit's
 *      disconnect->store re-locks the same yjs_document row, so holding our lock
 *      across it would self-block).
 *   3. LIVE COMMIT (after the tx returns): commitLiveSheetEdit re-asserts the
 *      client base version inside its own transact (the authoritative guard) and
 *      performs the single cell mutation; disconnect flushes durably.
 *
 * The sheet payload is a flat Y.Map (no ProseMirror schema), so there is no
 * anchor resolution / attachment reference / PM size hydration to pre-flight —
 * the cell contract check replaces those. Everything else is the doc path.
 */
import { transaction, type Tx } from '../../db/pool.js'
import { yjsDocumentRepo } from '../../db/repos/yjsDocumentRepo.js'
import { docVersionRepo, KIND_RESTORE_MARKER } from '../../db/repos/docVersionRepo.js'
import { docMemberRepo } from '../../db/repos/docMemberRepo.js'
import { readLiveSheet, commitLiveSheetEdit } from '../../collab/liveSheetWrite.js'
import { encodeBaseVersion, stateVectorsEqual, BaseVersionStaleError } from '../../collab/docBodyEdit.js'
import {
  validateSheetCellBatch,
  validateSheetDimBatch,
  validateSheetDrawingBatch,
  validateSheetHyperLinkBatch,
  validateSheetMergeBatch,
  validateSheetListBatch,
  measureSheetAfterEdit,
  SheetSnapshotInvalidError,
  ProtectedRangeError,
  type SheetCell,
  type StoredDrawing,
  type StoredHyperLink,
  type StoredSheetMeta,
} from '../../agent/sheetConversion.js'
import { SCHEMA_VERSION } from '../../schema/index.js'
import { config } from '../../config/env.js'
import { roleAtLeast, type ResolvedRole } from '../../permission/role.js'
import { resolveEffectiveRole } from '../../permission/resolveEffectiveRole.js'

export interface EditDocSheetInput {
  uid: string
  docId: string
  documentName: string
  /** The client-supplied base version (Y state vector) from If-Match / body. */
  clientBaseVersion: Uint8Array
  /** Keyed cells to set; a null value deletes that cell. */
  cells: Record<string, SheetCell | null>
  /** Keyed dims (`c<idx>`/`r<idx>` -> px) to set; a null value deletes that dim. */
  dims: Record<string, number | null>
  /** Keyed drawings (`${sheetId}!${drawingId}` -> ISheetImage) to set; null deletes. */
  drawings: Record<string, StoredDrawing | null>
  /** Keyed hyperlinks (`${sheetId}!${linkId}` -> {id,row,column,payload,display?}); null deletes. */
  hyperlinks: Record<string, StoredHyperLink | null>
  /** Keyed merges (`${logicalId}:sr:sc:er:ec` -> true); null un-merges. */
  merges: Record<string, boolean | null>
  /** Keyed sheet tabs (logicalId -> {name,order}); null deletes a tab. */
  sheets: Record<string, StoredSheetMeta | null>
  /** permission_epoch observed when the request was authorized (TOCTOU baseline). */
  authorizedEpoch: number
  /**
   * Whether the caller is a verified bot (#64). Threaded through to the
   * under-lock effective-role recheck so a bot's space membership is taken from
   * its server-verified space, exactly as the route guard does; humans resolve
   * via isSpaceMember. Defaults to false so an omitted flag never over-grants.
   */
  isBot?: boolean
  /**
   * The human caller's octo session token (#64). Threaded to the under-lock
   * effective-role recheck so a human's anyone_in_space membership resolves via
   * verify?include=context, exactly as the route guard does. The bot path
   * short-circuits on isBot and carries no token, so it is omitted there.
   */
  token?: string
}

export type EditDocSheetResult =
  | { ok: true; bytes: number; baseVersion: string; newDocVersionSeq: number }
  | {
      ok: false
      status: number
      error: string
      // Observability for the two size 413s (added info, no behavior change):
      // sheet_too_large carries payloadBytes (the read-payload dimension),
      // doc_too_large carries docBytes (the storage dimension). Both carry the
      // `limit` they were measured against so the caller sees how far past the cap
      // the write sits. Absent for non-size errors (412/422/403/…).
      payloadBytes?: number
      docBytes?: number
      limit?: number
    }

interface LockedMetaRow {
  owner_id: string
  permission_epoch: number
  status: number
  // #64: share seam read FRESH under the lock so the under-lock recheck resolves
  // the same effectiveRole as the route guard / live-socket recheck.
  space_id: string
  share_scope: number
  share_role: number
}

/**
 * Re-check the caller has at least writer under the doc_meta lock, applying the
 * SAME effective-role model as the route guard and the live-socket recheck
 * (#64): direct role (owner => admin, else doc_member) merged with the
 * space-share-derived role, so an `anyone_in_space`/edit space member is not
 * 403'd here after passing the route guard.
 */
async function resolveWriterTx(tx: Tx, docId: string, uid: string, meta: LockedMetaRow, isBot: boolean, token: string): Promise<{ canWrite: boolean; isAdmin: boolean }> {
  const direct: ResolvedRole =
    uid === meta.owner_id ? 'admin' : ((await docMemberRepo.getRoleTx(tx, docId, uid)) ?? 'none')
  const role = await resolveEffectiveRole(uid, direct, {
    space_id: meta.space_id,
    share_scope: Number(meta.share_scope),
    share_role: Number(meta.share_role),
  }, { isBot, token })
  // Return the ADMIN verdict too: range-protection enforcement (commitLiveSheetEdit) must use the
  // very same effective role this guard computed under the lock. Re-resolving it later could give a
  // different answer (membership/share change in between) and let a write slip past protection.
  return { canWrite: roleAtLeast(role, 'writer'), isAdmin: roleAtLeast(role, 'admin') }
}

/** Map a thrown edit-core / guard error to its HTTP status + code. */
function mapEditError(err: unknown): { status: number; error: string } | null {
  if (err instanceof BaseVersionStaleError) return { status: 412, error: 'base_version_stale' }
  if (err instanceof SheetSnapshotInvalidError) return { status: 422, error: 'sheet_cell_invalid' }
  // Pre-mutation refusal (nothing applied / broadcast), so it belongs in this set: the caller's
  // safety snapshot is an orphan and gets compensated away by the shared handling below.
  if (err instanceof ProtectedRangeError) return { status: 403, error: 'protected_range' }
  return null
}

export async function editDocSheet(input: EditDocSheetInput): Promise<EditDocSheetResult> {
  // ── 1. Pre-flight (NO lock) ───────────────────────────────────────────────
  const { state: preEditState, baseSV } = await readLiveSheet(input.documentName)

  // cheap pre-compare: fail most GET<->PATCH conflicts before a snapshot row.
  if (!stateVectorsEqual(input.clientBaseVersion, baseSV)) {
    return { ok: false, status: 412, error: 'base_version_stale' }
  }

  // contract check: surface 422 sheet_cell_invalid fail-fast, before any lock or
  // live write, using the SAME validators the live mutation runs (cells + dims).
  try {
    validateSheetCellBatch(input.cells)
    validateSheetDimBatch(input.dims)
    validateSheetDrawingBatch(input.drawings)
    validateSheetHyperLinkBatch(input.hyperlinks)
    validateSheetMergeBatch(input.merges)
    validateSheetListBatch(input.sheets)
  } catch (err) {
    const mapped = mapEditError(err)
    if (mapped) return { ok: false, ...mapped }
    throw err
  }

  // size gate (P1-A, mirrors editDocBody's sizeAfterEdit > maxDocBytes gate):
  // measure the post-edit sheet the SAME two ways its downstream caps are
  // enforced and reject an overflow HERE — before commitLiveSheetEdit applies the
  // cells to the shared live Y.Doc, broadcasts them to peers, and only then fails
  // at persistence.store. Without this gate a compliant single-request batch that
  // pushes the doc past maxDocBytes would broadcast-then-fail (a silent fork: the
  // caller gets a 500, peers keep the edit, the DB reload later wins), and a
  // chained PATCH→PATCH could grow the sheet past the read cap into a
  // write-but-not-readable state (GET permanently 413s). No lock is held yet, so a
  // rejection here leaves no snapshot row and no live side effect.
  const { docBytes, payloadBytes } = measureSheetAfterEdit(preEditState, input.cells, input.dims, input.drawings, input.hyperlinks, input.merges, input.sheets)
  // Align the write cap to the read cap so a written sheet is always GET-readable.
  // Report payloadBytes/limit (the read-payload dimension) so the write-gate 413
  // carries the SAME observability field the read gate emits (docSheet.ts).
  if (payloadBytes > config.sheetRead.maxCellBytes) {
    return {
      ok: false,
      status: 413,
      error: 'sheet_too_large',
      payloadBytes,
      limit: config.sheetRead.maxCellBytes,
    }
  }
  // Hard persistence cap — the exact byte budget persistence.store enforces.
  // Report docBytes/limit (the storage dimension) so a doc_too_large caller can
  // tell it tripped the 10MB storage cap, not the 1MB read-payload cap.
  if (docBytes > config.maxDocBytes) {
    return { ok: false, status: 413, error: 'doc_too_large', docBytes, limit: config.maxDocBytes }
  }

  // ── 2. Auth-recheck + safety-snapshot transaction ─────────────────────────
  const txResult = await transaction(async (tx) => {
    // Lock the authoritative state row FIRST (yjs_document -> doc_meta order).
    await yjsDocumentRepo.selectForUpdateTx(tx, input.documentName)

    const metaRows = await tx.query<LockedMetaRow>(
      'SELECT owner_id, permission_epoch, status, space_id, share_scope, share_role FROM doc_meta WHERE doc_id = ? FOR UPDATE',
      [input.docId],
    )
    const meta = metaRows[0]
    if (!meta || Number(meta.status) === 0) return { ok: false as const, status: 404, error: 'not_found' }
    if (Number(meta.status) === 2) return { ok: false as const, status: 409, error: 'conflict' }

    const writer = await resolveWriterTx(tx, input.docId, input.uid, meta, input.isBot ?? false, input.token ?? '')
    if (!writer.canWrite) {
      return { ok: false as const, status: 403, error: 'forbidden' }
    }
    if (Number(meta.permission_epoch) !== input.authorizedEpoch) {
      return { ok: false as const, status: 409, error: 'epoch_changed' }
    }

    // Safety snapshot of the PRE-edit state: a KIND_RESTORE_MARKER row so the
    // cell edit is itself undoable via the existing restore path (gate b).
    const safetyVersionId = await docVersionRepo.createTx(tx, {
      docId: input.docId,
      documentName: input.documentName,
      kind: KIND_RESTORE_MARKER,
      name: 'Auto-safety before sheet edit',
      state: preEditState,
      schemaVersion: SCHEMA_VERSION,
      createdBy: input.uid,
    })

    return { ok: true as const, safetyVersionId, isAdmin: writer.isAdmin }
    // COMMIT here releases both FOR UPDATE locks before the live write.
  })

  if (!txResult.ok) return txResult

  // ── 3. Live commit (after the tx returns) ─────────────────────────────────
  let bytes: number
  let newSV: Uint8Array
  try {
    const committed = await commitLiveSheetEdit(
      input.documentName,
      input.uid,
      input.clientBaseVersion,
      input.cells,
      input.dims,
      input.drawings,
      input.hyperlinks,
      input.merges,
      input.sheets,
      txResult.isAdmin,
    )
    bytes = committed.bytes
    newSV = committed.newSV
  } catch (err) {
    // The authoritative in-transact guard backstops any change between the
    // pre-flight and this commit — a drift fails here with no mutation/broadcast.
    // Phase 2 already committed the KIND_RESTORE_MARKER safety snapshot and
    // released its locks, so a rejection here would otherwise leave an orphan
    // restore point for an edit that never touched the sheet.
    //
    // P2: scope the compensating delete to PRE-MUTATION guard rejections only.
    // commitLiveSheetEdit's state-vector guard (BaseVersionStaleError) is its
    // first statement and applySheetCellsToYMap validates the whole batch
    // (SheetSnapshotInvalidError) BEFORE it mutates — both throw with nothing
    // applied or broadcast, so the snapshot is an orphan and must be deleted. Any
    // OTHER failure (store-time overflow, a DB error on the disconnect flush) is
    // thrown AFTER the cell already applied to the shared Y.Doc and broadcast to
    // peers: the safety snapshot is then the ONLY undo record for a change peers
    // have seen, so it MUST be preserved and the request fails 500 — deleting it
    // would strip the sole restore point for a live, peer-visible edit.
    const mapped = mapEditError(err)
    if (mapped) {
      // Best-effort compensating delete; a failure must not mask the edit error.
      try {
        await docVersionRepo.deleteById(txResult.safetyVersionId)
      } catch {
        /* surface the original edit error below */
      }
      return { ok: false, ...mapped }
    }
    // Unknown / store-time failure: keep the snapshot, surface as 500 (the route
    // maps a thrown error to internal_error).
    throw err
  }

  return {
    ok: true,
    bytes,
    baseVersion: encodeBaseVersion(newSV),
    newDocVersionSeq: txResult.safetyVersionId,
  }
}
