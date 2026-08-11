/**
 * POST /api/v1/docs/collab-token (§4.4).
 *
 * Mounted under /api/v1/docs. Unlike the other metadata routes, the uid here is
 * taken from the octo session token directly (the issuance service verifies it)
 * so it does NOT go through authMiddleware — it accepts the raw octo token and
 * returns 401 itself when identity is missing.
 *
 * This router is mounted before authMiddleware. Identity is instead verified
 * inside the issuance service from the raw Octo token, so this route never
 * requires `req.uid` or `req.spaceId`. It reads
 * `X-Space-Id` only as an optional recent-view candidate: the ingest records a
 * view when the server verifies active membership in that viewer Space, and
 * otherwise skips it. A missing header is not an error and never falls back to
 * the document's home Space.
 */
import { Router, type Router as ExpressRouter, type Request, type Response } from 'express'
import { issueCollabToken } from '../../auth/issueCollabToken.js'
import { extractOctoToken } from '../middleware/auth.js'

export const collabTokenRouter: ExpressRouter = Router()

collabTokenRouter.post('/collab-token', async (req: Request, res: Response) => {
  const { documentName } = req.body ?? {}
  if (typeof documentName !== 'string' || documentName === '') {
    res.status(400).json({ error: 'documentName required' })
    return
  }
  const octoToken = extractOctoToken(req)
  const rawSpace = req.header('X-Space-Id')
  const viewerSpaceId = typeof rawSpace === 'string' ? rawSpace.trim() : ''
  const out = await issueCollabToken(octoToken, documentName, viewerSpaceId)
  if (!out.ok) {
    res.status(out.status).json({ error: out.error })
    return
  }
  res.status(200).json(out.result)
})
