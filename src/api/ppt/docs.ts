/**
 * PPT human-create endpoint: `POST /api/v1/ppt/docs` (R2-B1).
 *
 * Creates an `html_ppt` deck from one of the four fixed bundled templates. The
 * caller identity is the authenticated session (`req.uid`) and the space is the
 * enforced `X-Space-Id` header (`req.spaceId`) — NEVER the body. Body-supplied
 * server-owned fields (`ownerId`, `spaceId`, `mountType`, `octoDocSlug`,
 * `botToken`) and a body `idempotencyKey` are rejected (§3.1 / §4.1). Idempotency
 * is carried ONLY by the `Idempotency-Key` header.
 *
 * On success the deck is minted by materializing the chosen template (strip
 * `template`, fresh Bento docId, drop `collab`), persisting the `doc_meta` row
 * (`doc_type='html_ppt'`, `octo_doc_slug=NULL`, `documentName` via
 * `buildPptDocumentName`), granting the creator admin membership, and recording
 * the create-time PPT state + starter deck. All responses use the C-style
 * envelope; failures raise a {@link PptApiError} that the router-scoped handler
 * renders.
 */
import { Router, type Request, type Response, type NextFunction, type Router as ExpressRouter } from 'express'
import { docMetaRepo } from '../../db/repos/docMetaRepo.js'
import { docMemberRepo } from '../../db/repos/docMemberRepo.js'
import { pptDocStateRepo } from '../../db/repos/pptDocStateRepo.js'
import {
  pptIdempotencyRepo,
  PPT_IDEMPOTENCY_SCOPE_CREATE,
} from '../../db/repos/pptIdempotencyRepo.js'
import { hashCanonicalPayload } from '../../ppt/idempotency.js'
import { buildPptDocumentName, DocumentNameError } from '../../permission/documentName.js'
import { HTML_PPT_DOC_TYPE } from '../../db/docType.js'
import { ROLE_ADMIN } from '../../permission/role.js'
import { newDocId } from '../../util/ids.js'
import { buildDocShareUrl, buildPptEditorUrl } from '../../util/docShareLink.js'
import { config } from '../../config/env.js'
import { getPptTemplate } from '../../ppt/templates.js'
import { instantiateTemplate } from '../../ppt/bentoDoc.js'
import { PptApiError, sendPptData } from './envelope.js'
import { pptAuthMiddleware, pptSpaceContextMiddleware } from './auth.js'

const DEFAULT_FOLDER = 'f_default'
/** Matches `doc_meta.title VARCHAR(512)` and the legacy create title bound. */
const MAX_TITLE_LEN = 512
/** `Idempotency-Key` header length cap (idempotency_key VARCHAR(255)). */
const MAX_IDEMPOTENCY_KEY_LEN = 255

/**
 * Body fields a client MUST NOT supply on human create: they are either
 * server-owned identity/mount fields (spoofing guard, §4.1 / PPT-API-004) or the
 * header-only idempotency key (§4.1 / PPT-IDEMP-003). Any presence is a hard 400.
 */
const FORBIDDEN_BODY_FIELDS = ['ownerId', 'spaceId', 'mountType', 'octoDocSlug', 'botToken', 'idempotencyKey'] as const

function vErr(message: string, details?: unknown): PptApiError {
  return new PptApiError('VALIDATION_ERROR', message, details === undefined ? {} : { details })
}

/** POST /docs — human create from `{ title, folderId?, templateId }`. */
export async function createPptDocHandler(req: Request, res: Response): Promise<void> {
  const uid = req.uid!
  const spaceId = req.spaceId!
  const body = (req.body ?? {}) as Record<string, unknown>

  // 1. Reject spoofed server-owned fields + body idempotencyKey BEFORE any work.
  const present = FORBIDDEN_BODY_FIELDS.filter((f) => body[f] !== undefined)
  if (present.length > 0) {
    throw vErr('request body must not include server-owned fields', { fields: present })
  }

  // 2. Idempotency is header-only and required on create (§4.1).
  const rawKey = req.header('Idempotency-Key')
  const idempotencyKey = typeof rawKey === 'string' ? rawKey.trim() : ''
  if (idempotencyKey === '') {
    throw vErr('Idempotency-Key header is required', { field: 'Idempotency-Key' })
  }
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LEN) {
    throw vErr('Idempotency-Key header is too long', { field: 'Idempotency-Key', max: MAX_IDEMPOTENCY_KEY_LEN })
  }

  // 3. Title: required, non-empty (after trim), within the column bound.
  const title = body.title
  if (typeof title !== 'string' || title.trim() === '') {
    throw vErr('title is required', { field: 'title' })
  }
  if (title.length > MAX_TITLE_LEN) {
    throw vErr('title is too long', { field: 'title', max: MAX_TITLE_LEN })
  }

  // 4. templateId: required, one of the four fixed bundled templates.
  const templateIdRaw = body.templateId
  const template = typeof templateIdRaw === 'string' ? getPptTemplate(templateIdRaw) : null
  if (!template) {
    throw vErr('templateId must be one of the four bundled templates', { field: 'templateId' })
  }
  const templateId = templateIdRaw as string

  // 5. Folder: optional; default reserved folder. Validate the segment early by
  //    building the documentName (buildPptDocumentName rejects illegal segments).
  const folderRaw = body.folderId
  const folder = typeof folderRaw === 'string' && folderRaw !== '' ? folderRaw : DEFAULT_FOLDER
  const docId = newDocId()
  let documentName: string
  try {
    documentName = buildPptDocumentName(spaceId, folder, docId)
  } catch (err) {
    if (err instanceof DocumentNameError) throw vErr('invalid folderId segment', { field: 'folderId' })
    throw err
  }

  // Canonical payload for idempotency: only the fields that determine the created
  // resource (NOT the header, NOT the minted docId). Same key + same canonical
  // payload replays; same key + different payload conflicts.
  const requestHash = hashCanonicalPayload({ title, folderId: folder, templateId })

  // Replay/conflict against a prior record for this (space, create, key).
  const prior = await pptIdempotencyRepo.get(spaceId, PPT_IDEMPOTENCY_SCOPE_CREATE, idempotencyKey)
  if (prior) {
    if (prior.requestHash !== requestHash) {
      throw new PptApiError('CONFLICT', 'Idempotency-Key was reused with a different payload', {
        details: { idempotencyKey },
      })
    }
    if (prior.completed) {
      sendPptData(res, prior.responseData, prior.responseStatus)
      return
    }
    // A concurrent request holds the key but has not finished. Do not create a
    // duplicate; ask the client to retry the (in-flight, same-payload) create.
    throw new PptApiError('CONFLICT', 'an identical create is in progress; retry', {
      details: { idempotencyKey },
      hint: 'retry',
    })
  }

  // Claim the key BEFORE creating anything, so a same-key race never yields two
  // decks (the loser gets reserved:false and re-reads to replay/conflict).
  const { reserved } = await pptIdempotencyRepo.reserve(
    spaceId,
    PPT_IDEMPOTENCY_SCOPE_CREATE,
    idempotencyKey,
    requestHash,
  )
  if (!reserved) {
    const winner = await pptIdempotencyRepo.get(spaceId, PPT_IDEMPOTENCY_SCOPE_CREATE, idempotencyKey)
    if (winner && winner.requestHash !== requestHash) {
      throw new PptApiError('CONFLICT', 'Idempotency-Key was reused with a different payload', {
        details: { idempotencyKey },
      })
    }
    if (winner && winner.completed) {
      sendPptData(res, winner.responseData, winner.responseStatus)
      return
    }
    throw new PptApiError('CONFLICT', 'an identical create is in progress; retry', {
      details: { idempotencyKey },
      hint: 'retry',
    })
  }

  // Materialize the deck: strip `template`, mint a fresh Bento docId, drop collab.
  const deck = instantiateTemplate(template, new Date().toISOString())

  // Persist the doc_meta row (html_ppt, slug NULL, PPT documentName), the
  // creator's admin membership, and the create-time PPT state + starter deck.
  await docMetaRepo.create({
    docId,
    documentName,
    title,
    ownerId: uid,
    spaceId,
    folderId: folder,
    docType: HTML_PPT_DOC_TYPE,
    createdBy: uid,
  })
  await docMemberRepo.upsertDirect({ docId, uid, roleNum: ROLE_ADMIN, grantedBy: uid })
  await pptDocStateRepo.create({ docId, templateId, draftDoc: deck })

  const meta = await docMetaRepo.getByDocId(docId)

  const data = {
    docId,
    documentName,
    title,
    spaceId,
    folderId: folder,
    ownerId: uid,
    docType: HTML_PPT_DOC_TYPE,
    role: 'admin' as const,
    templateId,
    draftRevision: 0,
    snapshotVersion: 0,
    editorUrl: buildPptEditorUrl(config.webOrigin, docId, spaceId),
    shareUrl: buildDocShareUrl(config.webOrigin, docId, spaceId),
    ...(meta?.created_at ? { createdAt: meta.created_at } : {}),
  }

  // Record the response so a header replay returns it byte-for-byte.
  await pptIdempotencyRepo.complete(spaceId, PPT_IDEMPOTENCY_SCOPE_CREATE, idempotencyKey, 201, data, docId)

  sendPptData(res, data, 201)
}

/** Adapt an async handler so a thrown error reaches the router-scoped envelope handler. */
function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next)
  }
}

/**
 * Build the PPT docs sub-router (`/api/v1/ppt/docs`). The parent PPT router
 * (createPptRouter) already applies the router-scoped `express.json` and the
 * envelope error handler, so a malformed body is rendered as a C-style
 * VALIDATION_ERROR. Auth + space guards run before the create handler.
 */
export function createPptDocsRouter(): ExpressRouter {
  const router = Router()
  router.post('/docs', pptAuthMiddleware, pptSpaceContextMiddleware, asyncHandler(createPptDocHandler))
  return router
}
