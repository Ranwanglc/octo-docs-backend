/**
 * Bot/human board-scene content endpoints (Excalidraw scene surface). The board
 * counterpart of docContent.ts (rich-text body) and docSheet.ts (spreadsheet):
 * a board stores its scene in the two top-level whiteboard Y.Maps
 * (`elements` / `files`, see whiteboard/ydoc.ts) rather than the ProseMirror
 * COLLAB_FIELD fragment or the flat 'sheet' map, so — like the sheet surface — it
 * needs its own routes. docContent rejects a board with 409 unsupported_doc_type;
 * this surface accepts ONLY a board and rejects everything else, the mirror image.
 *
 *   GET   /:docId/scene   reader  — read the LIVE elements + files + base version
 *   PATCH /:docId/scene   writer  — element-level upsert/delete batch under a
 *                                   strict If-Match(SV) optimistic-concurrency guard
 *
 * The routes are mounted on BOTH the human /api/v1/docs chain and the bot
 * /v1/bot/docs chain (see app.ts), so each reads req.uid / req.spaceId from
 * whichever identity middleware ran.
 *
 * The route gate (requireDocRole) is UX / a cheap 404 pass; on the write path the
 * authoritative role + permission_epoch recheck happens again under the row lock
 * inside editBoardScene, because the live write bypasses onAuthenticate — the same
 * safety contract the doc-body / sheet writes enforce.
 */
import { Router, type Router as ExpressRouter, type Request, type Response } from 'express'
import { requireDocRole } from '../guard.js'
import { readLiveBoard } from '../../collab/liveBoardWrite.js'
import { editBoardScene } from '../services/editBoardScene.js'
import { encodeBaseVersion, parseBaseVersion } from '../../collab/docBodyEdit.js'
import {
  decodeBoardSnapshot,
  BoardSnapshotInvalidError,
  WHITEBOARD_DOC_TYPE,
} from '../../collab/versionRestore.js'
import { WB_SCHEMA_VERSION } from '../../whiteboard/schema/index.js'
import type { BoardOps } from '../../whiteboard/boardEdit.js'
import { config } from '../../config/env.js'

export const docSceneRouter: ExpressRouter = Router()

/**
 * Reject a target whose doc_type is not 'board'. Writes a 409 unsupported_doc_type
 * and returns false when blocked — the mirror of docContent's
 * requireBodyEditableDocType and docSheet's requireSheetDocType. Applied to both
 * handlers so a non-board doc can neither be read as an empty scene nor mutated
 * into a spurious element map.
 */
function requireBoardDocType(res: Response, docType: string): boolean {
  if (docType !== WHITEBOARD_DOC_TYPE) {
    res.status(409).json({ error: 'unsupported_doc_type' })
    return false
  }
  return true
}

/** Extract the base-version token from the If-Match header or the body mirror. */
function readBaseVersion(req: Request): string | null {
  const header = req.headers['if-match']
  const raw = Array.isArray(header) ? header[0] : header
  if (typeof raw === 'string' && raw.trim() !== '') {
    // If-Match carries the token as a quoted entity-tag; strip the quotes.
    return raw.trim().replace(/^"(.*)"$/, '$1')
  }
  const bodyBase = (req.body ?? {}).baseVersion
  if (typeof bodyBase === 'string' && bodyBase !== '') return bodyBase
  return null
}

// ── GET /:docId/scene — read the live scene (reader) ──────────────────────────
docSceneRouter.get('/:docId/scene', getDocSceneHandler)

export async function getDocSceneHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(req, res, req.params.docId!, 'reader')
  if (!guard) return
  if (!requireBoardDocType(res, guard.meta.doc_type)) return

  try {
    // Read the live authoritative state + its state vector, then decode with the
    // SAME validated primitive the version-restore preview uses
    // (decodeBoardSnapshot), so the read path and the preview path never drift.
    const { state, baseSV } = await readLiveBoard(guard.meta.document_name)
    const scene = decodeBoardSnapshot(state)
    res.status(200).json({
      docId: guard.meta.doc_id,
      elements: scene.elements,
      files: scene.files,
      // The live state vector, base64. Carried so a later PATCH can guard on it
      // for optimistic concurrency (If-Match).
      baseVersion: encodeBaseVersion(baseSV),
      schemaVersion: WB_SCHEMA_VERSION,
    })
  } catch (err) {
    if (err instanceof BoardSnapshotInvalidError) {
      // The live scene decoded to a wrong-kind / corrupt blob — fail-closed
      // rather than serializing a partial or nonsensical scene.
      res.status(409).json({ error: 'board_snapshot_invalid' })
      return
    }
    res.status(500).json({ error: 'internal_error' })
  }
}

/**
 * Structural (shape-only) validation of the scene edit batch — a bad shape is a
 * 400. Contract-level validation (element whitelist, usable file ref) is deferred
 * to validateBoardOps in the service, which maps to 422. At least one of the
 * three op groups must be present and non-empty (an empty batch is a 400).
 */
function validateOpsShape(body: unknown): BoardOps | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  const { elements, deletedElementIds, files, deletedFileIds } = b

  if (elements !== undefined && !Array.isArray(elements)) return null
  if (deletedElementIds !== undefined && !Array.isArray(deletedElementIds)) return null
  if (files !== undefined && (!files || typeof files !== 'object' || Array.isArray(files))) return null
  if (deletedFileIds !== undefined && !Array.isArray(deletedFileIds)) return null

  const elCount = Array.isArray(elements) ? elements.length : 0
  const delCount = Array.isArray(deletedElementIds) ? deletedElementIds.length : 0
  const fileCount = files && typeof files === 'object' ? Object.keys(files).length : 0
  const fileDeleteCount = Array.isArray(deletedFileIds) ? deletedFileIds.length : 0
  if (elCount === 0 && delCount === 0 && fileCount === 0 && fileDeleteCount === 0) return null

  return { elements, deletedElementIds, files, deletedFileIds } as BoardOps
}

/**
 * Request-shape bounds enforced BEFORE the no-lock batch validation (DoS gate),
 * mirroring docContent's checkOpsBounds / docSheet's checkCellsBounds. Caps the
 * total op count and each element/file object's serialized size on the
 * already-parsed (≤1mb) body, so the check itself is bounded. Returns the error
 * to send, or null when within bounds.
 */
function checkOpsBounds(ops: BoardOps): { status: number; error: string } | null {
  const elements = Array.isArray(ops.elements) ? ops.elements : []
  const deletes = Array.isArray(ops.deletedElementIds) ? ops.deletedElementIds : []
  const files = ops.files && typeof ops.files === 'object' ? (ops.files as Record<string, unknown>) : {}
  const fileDeletes = Array.isArray(ops.deletedFileIds) ? ops.deletedFileIds : []
  const total = elements.length + deletes.length + Object.keys(files).length + fileDeletes.length
  if (total > config.boardSceneWrite.maxElements) {
    return { status: 413, error: 'too_many_elements' }
  }
  for (const el of elements) {
    if (Buffer.byteLength(JSON.stringify(el ?? null)) > config.boardSceneWrite.maxElementContentBytes) {
      return { status: 413, error: 'element_too_large' }
    }
  }
  for (const ref of Object.values(files)) {
    if (Buffer.byteLength(JSON.stringify(ref ?? null)) > config.boardSceneWrite.maxElementContentBytes) {
      return { status: 413, error: 'element_too_large' }
    }
  }
  return null
}

// ── PATCH /:docId/scene — element-level scene edit (writer) ───────────────────
docSceneRouter.patch('/:docId/scene', patchDocSceneHandler)

export async function patchDocSceneHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(req, res, req.params.docId!, 'writer')
  if (!guard) return
  if (!requireBoardDocType(res, guard.meta.doc_type)) return

  const baseVersionRaw = readBaseVersion(req)
  if (baseVersionRaw === null) {
    res.status(400).json({ error: 'invalid_body' })
    return
  }
  const ops = validateOpsShape(req.body)
  if (!ops) {
    res.status(400).json({ error: 'invalid_body' })
    return
  }
  // Fail-fast request-shape bounds (DoS gate) before any batch validation.
  const bounds = checkOpsBounds(ops)
  if (bounds) {
    res.status(bounds.status).json({ error: bounds.error })
    return
  }

  try {
    const result = await editBoardScene({
      uid: req.uid!,
      docId: guard.meta.doc_id,
      documentName: guard.meta.document_name,
      clientBaseVersion: parseBaseVersion(baseVersionRaw),
      ops,
      authorizedEpoch: guard.meta.permission_epoch,
      isBot: req.botToken !== undefined,
      token: req.octoToken,
    })
    if (result.ok) {
      res.status(200).json({
        docId: guard.meta.doc_id,
        bytes: result.bytes,
        baseVersion: result.baseVersion,
        newDocVersionSeq: result.newDocVersionSeq,
      })
      return
    }
    // Forward the size-413 observability fields (docBytes + limit) when
    // editBoardScene set them; non-size errors carry none and fall through to a
    // bare { error }.
    const errBody: Record<string, unknown> = { error: result.error }
    if (result.docBytes !== undefined) errBody.docBytes = result.docBytes
    if (result.limit !== undefined) errBody.limit = result.limit
    res.status(result.status).json(errBody)
  } catch {
    res.status(500).json({ error: 'internal_error' })
  }
}
