/**
 * Shared REST permission guards (§4.2 / §8.4 / remove-sp §6).
 */
import type { Request, Response } from 'express'
import { docMetaRepo, type DocMeta } from '../db/repos/docMetaRepo.js'
import { resolveRole } from '../permission/resolveRole.js'
import { roleAtLeast, type ResolvedRole, type Role } from '../permission/role.js'
import { resolveEffectiveRole } from '../permission/resolveEffectiveRole.js'
import type { DocSpaceScope } from './middleware/docSpaceScope.js'

export interface DocGuard {
  meta: DocMeta
  role: ResolvedRole
}

/**
 * Cross-space 404 gate (P2). A doc that lives in another space must be
 * indistinguishable from one that does not exist, so an out-of-space hit
 * returns 404 not_found (never 403) — matching the not_found semantics for
 * cross-doc references and never leaking a doc's existence outside the caller's
 * space. Writes the 404 and returns false when the doc is out of space.
 *
 * Applied ONLY on the Bot mount (remove-sp §6): a verified bot carries a
 * server-resolved Space and must keep the current same-space isolation. The
 * Human open-context mount locates by docId and never calls this — the
 * client-supplied `X-Space-Id` never scopes doc selection there.
 */
export function requireSameSpace(res: Response, meta: DocMeta, spaceId: string): boolean {
  if (meta.space_id !== spaceId) {
    res.status(404).json({ error: 'not_found' })
    return false
  }
  return true
}

/**
 * Resolve the doc space-scoping policy for a request (remove-sp §6). Fails
 * CLOSED: a request that reached a doc guard without a policy set by its mount
 * is a wiring bug, and defaulting to bot-with-empty-space makes every doc read
 * as cross-space (404) rather than silently opening the Human locate. Every
 * real mount installs a policy (humanDocSpaceScopeMiddleware / verifyBot).
 */
function docScopeOf(req: Request): DocSpaceScope {
  return req.docSpaceScope ?? { mode: 'bot', spaceId: '' }
}

/**
 * Load the doc and resolve the caller's effective role, enforcing a minimum
 * role. Writes the appropriate HTTP error and returns null when blocked:
 *   404 doc missing/deleted, 404 cross-space (BOT only), 409 archived,
 *   403 insufficient role.
 *
 * Doc location + space scoping follow the explicit per-mount policy
 * (`req.docSpaceScope`), NOT `req.botToken` (remove-sp §6):
 *   - Human ({ mode: 'human' }): locate by `docId` alone. `X-Space-Id` never
 *     scopes selection or authz, so a cross-Space direct member / owner /
 *     anyone_in_space caller resolves exactly as if `sp` had been correct, and a
 *     missing/wrong header yields the identical result.
 *   - Bot ({ mode: 'bot', spaceId }): the pre-existing same-space isolation —
 *     an out-of-space hit is 404 BEFORE any role/status branch.
 *
 * The effective role (#64 anyone_in_space share, design §5.1) is resolved via
 * resolveEffectiveRole. A verified bot's Space membership is implied by the
 * requireSameSpace gate above; a human's is resolved against the doc's HOME
 * Space (meta.space_id) via isSpaceMember — never the client header — so the
 * share path can only open on a confirmed membership.
 */
export async function requireDocRole(
  req: Request,
  res: Response,
  docId: string,
  minRole: Role,
): Promise<DocGuard | null> {
  const uid = req.uid!
  const scope = docScopeOf(req)
  const meta = await docMetaRepo.getByDocId(docId)
  if (!meta || meta.status === 0) {
    res.status(404).json({ error: 'not_found' })
    return null
  }
  // Bot keeps the same-space isolation (checked before role/status so a
  // cross-space doc is indistinguishable from a missing one). Human locates by
  // docId and skips this gate entirely.
  if (scope.mode === 'bot' && !requireSameSpace(res, meta, scope.spaceId)) {
    return null
  }
  const direct = await resolveRole(uid, docId)
  // #64 space-scoped share (design §5.1): effectiveRole = max(directRole,
  // share-derived). A verified bot derives membership from its Space; a human
  // resolves it against the doc's home Space via its own session token.
  const role = await resolveEffectiveRole(uid, direct, meta, {
    isBot: scope.mode === 'bot',
    token: req.octoToken,
  })
  if (role === 'none' || !roleAtLeast(role, minRole)) {
    res.status(403).json({ error: 'forbidden' })
    return null
  }
  // State is disclosed only after authorization. This preserves the Phase-1
  // contract: an existing doc with no effective role is 403, while 409 is
  // visible only to an authorized caller.
  if (meta.status === 2) {
    res.status(409).json({ error: 'conflict' })
    return null
  }
  return { meta, role }
}
