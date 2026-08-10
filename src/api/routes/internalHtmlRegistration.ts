import { createHash, timingSafeEqual } from 'node:crypto'
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { config } from '../../config/env.js'
import { DocOwnershipError, docMetaRepo } from '../../db/repos/docMetaRepo.js'
import { buildHtmlDocumentName, DocumentNameError } from '../../permission/documentName.js'
import { newDocId } from '../../util/ids.js'
import { buildDocShareUrl } from '../../util/docShareLink.js'

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

export async function internalHtmlRegistrationHandler(req: Request, res: Response): Promise<void> {
  if (!credentialMatches(req.header('x-internal-token') ?? '')) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }

  const { octoDocSlug: rawSlug, spaceId: rawSpaceId, owner: rawOwner, title } = req.body ?? {}
  if (
    typeof rawSlug !== 'string' ||
    typeof rawSpaceId !== 'string' ||
    typeof rawOwner !== 'string' ||
    typeof title !== 'string'
  ) {
    res.status(400).json({ error: 'invalid_body' })
    return
  }

  const octoDocSlug = rawSlug.trim()
  const spaceId = rawSpaceId.trim()
  const owner = rawOwner.trim()
  if (
    !SAFE_SEGMENT.test(octoDocSlug) || octoDocSlug.length > SLUG_MAX_LENGTH ||
    !SAFE_SEGMENT.test(spaceId) || spaceId.length > ID_MAX_LENGTH ||
    !SAFE_SEGMENT.test(owner) || owner.length > ID_MAX_LENGTH ||
    title.length > TITLE_MAX_LENGTH
  ) {
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
    result = await docMetaRepo.upsertHtmlByOctoDocSlug({
      docId,
      documentName,
      title,
      ownerId: owner,
      spaceId,
      folderId: FOLDER_ID,
      docType: 'html',
      octoDocSlug,
      createdBy: owner,
    })
  } catch (err) {
    if (err instanceof DocOwnershipError) {
      res.status(403).json({ error: 'forbidden' })
      return
    }
    throw err
  }

  res.status(result.created ? 201 : 200).json({
    docId: result.meta.doc_id,
    documentName: result.meta.document_name,
    octoDocSlug,
    spaceId: result.meta.space_id,
    owner: result.meta.owner_id,
    title: result.meta.title,
    docType: 'html',
    mountType: 'space',
    created: result.created,
    shareUrl: buildDocShareUrl(config.webOrigin ?? '', result.meta.doc_id, result.meta.space_id),
  })
}

internalHtmlRegistrationRouter.post('/register', internalHtmlRegistrationHandler)
