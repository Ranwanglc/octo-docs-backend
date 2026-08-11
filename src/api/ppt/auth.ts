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
import { confirmSpaceMembership } from '../../permission/spaceMembership.js'
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
 *
 * This parses only — it does NOT confirm membership, so `req.spaceId` is not
 * proof of membership. Space-selector routes add {@link pptRequireSpaceMembership}
 * on top; routes that address an existing deck re-derive authority from the
 * caller's real credentials instead (see that function's header).
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

/**
 * Confirm the caller is a member of `req.spaceId`. Mount AFTER
 * {@link pptSpaceContextMiddleware}, on space-selector routes ONLY.
 *
 * ★ The header is CLIENT-SUPPLIED, so shape validation alone is not authority:
 * it proves the caller SAID a space, not that they belong to it. Without this
 * check, any holder of a valid octo session token could set `X-Space-Id` to an
 * arbitrary space and mint a deck (and its documentName / editor / share URLs)
 * INTO that space, consuming its idempotency scope — the deck does not exist
 * yet, so there is no role to resolve and this is the only check available.
 * This is the sibling of `requireSpaceMembership` on the legacy `/api/v1/docs`
 * chain; the two must stay symmetric, since the PPT router is mounted WITHOUT
 * that chain's middleware and would otherwise be the unguarded way into the same
 * boundary. Both now share one implementation (`confirmSpaceMembership`) rather
 * than a copied block, because the copies had already drifted once.
 *
 * NOT applied to `GET /docs/:docId/source`: that route resolves the caller's
 * effective role on an existing deck (`loadPptDocForRead` -> `resolveEffectiveRole`,
 * which pins the deck's own space and calls `isSpaceMember` itself for the
 * `anyone_in_space` branch). Gating it would 404 a legitimate cross-space
 * `doc_member`, which the contract forbids — see the header of
 * `api/middleware/spaceContext.ts` for the full argument.
 *
 * `NOT_FOUND` (not `FORBIDDEN`) is intentional: a non-member must not be able to
 * distinguish "this space exists and I'm not in it" from "no such space", which
 * a permission-style error would turn into a space-existence oracle. It also
 * matches the 404 the docs chain returns for the same condition.
 *
 * Fail-closed: a failed/rejected membership lookup refuses rather than passing,
 * and is surfaced as the same NOT_FOUND rather than a 500 (see
 * `confirmSpaceMembership` for why a bare `.catch()` is not enough under
 * Express 4).
 */
export async function pptRequireSpaceMembership(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const member = await confirmSpaceMembership(req.uid ?? '', req.spaceId ?? '', req.octoToken ?? '')
  if (!member) {
    next(new PptApiError('NOT_FOUND', 'space not found'))
    return
  }
  next()
}
