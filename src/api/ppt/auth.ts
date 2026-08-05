/**
 * Auth guards for the `/api/v1/ppt/**` surface.
 *
 * The PPT router is deliberately mounted WITHOUT the legacy
 * `authMiddleware`/`spaceContextMiddleware` (see api/app.ts): those emit BARE
 * JSON (`{ error: 'unauthorized' }` / `{ error: 'space_required' }`), which would
 * leak the legacy shape into the C-style PPT contract. These guards resolve the
 * same identity/space but signal failure by calling `next(err)` with a
 * {@link PptApiError}, so the router-scoped `pptErrorHandler` renders every
 * failure as the enveloped `{ error: { code, message } }` form.
 *
 * They also populate the SAME request fields the legacy middleware do
 * (`req.uid`, `req.octoToken`, `req.spaceId`), so PPT handlers read identity the
 * usual way — but a PPT handler must never assume these are set without the
 * guard in front of it (the mount does not pre-populate them).
 */
import type { Request, Response, NextFunction } from 'express'
import { getOctoIdentity } from '../../auth/octoIdentity.js'
import { extractOctoToken } from '../middleware/auth.js'
import { PptApiError } from './envelope.js'

/**
 * Require a valid octo identity; populates `req.uid` / `req.octoToken`. Missing
 * or invalid identity -> enveloped `401 AUTH_REQUIRED`.
 */
export async function pptAuthMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractOctoToken(req)
    const identity = await getOctoIdentity().verifyToken(token)
    if (!identity) {
      next(new PptApiError('AUTH_REQUIRED', 'authentication required'))
      return
    }
    req.uid = identity.uid
    req.octoToken = token
    next()
  } catch (err) {
    next(err)
  }
}

/**
 * Require an `X-Space-Id` header; populates `req.spaceId`. Missing/empty header
 * -> enveloped `400 VALIDATION_ERROR` (the space is a required, client-supplied
 * request context, not an auth failure). Mount AFTER {@link pptAuthMiddleware}.
 */
export function pptSpaceContextMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const raw = req.header('X-Space-Id')
  const spaceId = typeof raw === 'string' ? raw.trim() : ''
  if (spaceId === '') {
    next(new PptApiError('VALIDATION_ERROR', 'X-Space-Id header is required', { details: { field: 'X-Space-Id' } }))
    return
  }
  req.spaceId = spaceId
  next()
}
