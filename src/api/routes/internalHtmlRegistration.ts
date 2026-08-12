import { createHash, timingSafeEqual } from 'node:crypto'
import {
  Router,
  type NextFunction,
  type Request,
  type Response,
  type Router as ExpressRouter,
} from 'express'
import { config } from '../../config/env.js'
import { HTML_DOC_TYPE } from '../../db/docType.js'
import {
  CanonicalHtmlArchivedError,
  CanonicalHtmlDeletedError,
  CanonicalHtmlLegacyConflictError,
  DocOwnershipError,
  docMetaRepo,
} from '../../db/repos/docMetaRepo.js'
import { buildHtmlDocumentName, DocumentNameError } from '../../permission/documentName.js'
import { enqueueDocIndex, isSearchIndexedDoc } from '../../search/docIndexQueue.js'
import { buildDocShareUrl } from '../../util/docShareLink.js'
import { newDocId } from '../../util/ids.js'

const FOLDER_ID = 'f_default'
const ID_MAX_LENGTH = 64
const SLUG_MAX_LENGTH = 128
const TITLE_MAX_LENGTH = 512
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/

export const internalHtmlRegistrationRouter: ExpressRouter = Router()

function credentialMatches(actual: string): boolean {
  const expected = config.htmlRegistration.token
  if (expected === '' || actual === '') return false
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(actual), digest(expected))
}

function authorize(req: Request, res: Response): boolean {
  if (credentialMatches(req.header('x-internal-token') ?? '')) return true
  res.status(401).json({ error: 'unauthorized' })
  return false
}

interface DelegatedIdentity {
  octoDocSlug: string
  spaceId: string
  owner: string
}

function delegatedIdentity(req: Request, res: Response): DelegatedIdentity | null {
  const { octoDocSlug: rawSlug, spaceId: rawSpaceId, owner: rawOwner } = req.body ?? {}
  if (typeof rawSlug !== 'string' || typeof rawSpaceId !== 'string' || typeof rawOwner !== 'string') {
    res.status(400).json({ error: 'invalid_body' })
    return null
  }
  const octoDocSlug = rawSlug.trim()
  const spaceId = rawSpaceId.trim()
  const owner = rawOwner.trim()
  if (
    !SAFE_SEGMENT.test(octoDocSlug) || octoDocSlug.length > SLUG_MAX_LENGTH ||
    !SAFE_SEGMENT.test(spaceId) || spaceId.length > ID_MAX_LENGTH ||
    !SAFE_SEGMENT.test(owner) || owner.length > ID_MAX_LENGTH
  ) {
    res.status(400).json({ error: 'invalid_body' })
    return null
  }
  return { octoDocSlug, spaceId, owner }
}

export async function internalHtmlRegistrationHandler(req: Request, res: Response): Promise<void> {
  if (!authorize(req, res)) return
  const identity = delegatedIdentity(req, res)
  if (!identity) return
  const { octoDocSlug, spaceId, owner } = identity
  const { title } = req.body ?? {}
  if (typeof title !== 'string' || title.length > TITLE_MAX_LENGTH) {
    res.status(400).json({ error: 'invalid_body' })
    return
  }

  const docId = newDocId()
  let documentName: string
  try {
    documentName = buildHtmlDocumentName(spaceId, FOLDER_ID, docId)
  } catch (err) {
    if (err instanceof DocumentNameError) {
      res.status(400).json({ error: 'invalid_body' })
      return
    }
    throw err
  }

  let result
  try {
    // The internal token authenticates docs-html; that trusted service delegates
    // the already-authenticated user's owner id in the request body.
    result = await docMetaRepo.upsertHtmlByOctoDocSlug({
      docId,
      documentName,
      title,
      ownerId: owner,
      spaceId,
      folderId: FOLDER_ID,
      docType: HTML_DOC_TYPE,
      octoDocSlug,
      createdBy: owner,
    })
  } catch (err) {
    if (err instanceof CanonicalHtmlDeletedError) {
      res.status(410).json({ error: 'canonical_document_deleted' })
      return
    }
    if (err instanceof CanonicalHtmlArchivedError) {
      res.status(409).json({ error: 'canonical_document_archived' })
      return
    }
    if (err instanceof CanonicalHtmlLegacyConflictError) {
      res.status(409).json({ error: 'canonical_document_conflict' })
      return
    }
    if (err instanceof DocOwnershipError) {
      res.status(403).json({ error: 'forbidden' })
      return
    }
    throw err
  }

  if (config.search.indexEnabled && isSearchIndexedDoc(result.meta.document_name)) {
    void enqueueDocIndex(result.meta.document_name)
  }
  res.status(result.created ? 201 : 200).json({
    docId: result.meta.doc_id,
    documentName: result.meta.document_name,
    octoDocSlug,
    spaceId: result.meta.space_id,
    owner: result.meta.owner_id,
    title: result.meta.title,
    docType: HTML_DOC_TYPE,
    mountType: 'space',
    created: result.created,
    shareUrl: buildDocShareUrl(config.webOrigin ?? '', result.meta.doc_id, result.meta.space_id),
  })
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next)
  }
}

internalHtmlRegistrationRouter.post('/register', asyncHandler(internalHtmlRegistrationHandler))
