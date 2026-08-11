/**
 * SpaceContext middleware (strict by-space isolation, P1) + the space-membership
 * gate, deliberately kept as TWO separate middlewares.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. `spaceContextMiddleware` — parse the header. Mounted globally.
 *
 * The isolation boundary is the frontend-injected `X-Space-Id` header. This
 * middleware reads it, trims it, and stashes the result on `req.spaceId` for the
 * downstream metadata handlers to scope their queries by. A missing or empty
 * header is a hard 400 (`{ error: 'space_required' }`) — there is no warn/grace
 * mode: the isolation is enforced from the first request.
 *
 * It does NOT confirm membership, and `req.spaceId` is therefore NOT proof of
 * membership on its own. Every consumer either (a) sits behind
 * `requireSpaceMembership` below, or (b) re-derives authority from the caller's
 * real credentials — `requireDocRole` resolves the role from `owner_id` /
 * `doc_member` by uid, and `resolveEffectiveRole` calls `isSpaceMember` itself
 * for the `anyone_in_space` widening branch.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 2. `requireSpaceMembership` — the gate. Mounted per-route, NOT globally.
 *
 * ★ The header is CLIENT-SUPPLIED and therefore not authority. Shape validation
 * only proves the caller SAID a space; it does not prove they belong to it.
 * Without this gate, any holder of a valid octo session token could set
 * `X-Space-Id` to an arbitrary space and be treated as that space's occupant on
 * every route where THE SPACE IS THE ONLY SELECTOR — create a doc inside it, list
 * its documents, search it, read its recent activity. Those routes have no
 * document to resolve a role from (create: the doc does not exist yet;
 * list/search/recent: the subject IS the space), so the space check is the ONLY
 * check available there.
 *
 * One route deliberately stays OUT of both categories: `POST
 * /:docId/access-requests`. It skips `requireDocRole` (the submitter by
 * definition holds no role) AND must stay open to non-members, because the
 * persona it serves is an outsider on octo-web's forbidden landing (#511 screen
 * 4c). It relies on `requireSameSpace` alone — see its own header for what that
 * does and does not buy.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why the gate is NOT global — the regression that split this file.
 *
 * A doc_member grant is INDEPENDENT of space membership by design: `members.ts`
 * and `forwardGrant.ts` verify only that the grantee is a real octo user
 * (anti ghost-member); neither consults `isSpaceMember`, and the invite-accept
 * path never mentions a space at all. `docShareLink.ts` then mints
 * `/d/<docId>?sp=<the doc's OWN space>` precisely so such a grantee's
 * `GET /docs/{docId}` preflight addresses the doc's home space. The contract is
 * explicit (`docs/contract/backend-design.md:1514`): space is a **supplemental**
 * permission source that "不改变直接的 owner/doc_member 授权,
 * `effectiveRole=max(直接角色, 分享派生角色)` 只加不减".
 *
 * A global gate SUBTRACTS: it 404s a legitimate cross-space `doc_member` on
 * every `/:docId` route. Worse, it does so ASYMMETRICALLY — `collabTokenRouter`
 * and `acceptInviteRouter` are mounted ahead of `authMiddleware` (see app.ts) and
 * so bypass the gate entirely, which would let the same user open the collab
 * editor over websocket while every REST call (metadata, comments, attachments,
 * versions, export) returned 404, and would show invite acceptance succeeding
 * onto a doc that then "does not exist".
 *
 * So the gate goes exactly where the space is load-bearing, and `/:docId` routes
 * stay with `requireDocRole`, which is strictly stronger there: it resolves the
 * role from the caller's real uid (spoof-proof) AND pins
 * `req.spaceId === meta.space_id` via `requireSameSpace`, so a forged header can
 * only ever name the doc's own space — buying the caller nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Failure mode is **404 `not_found`, never 403**: a non-member must not be able
 * to distinguish "this space exists and I'm not in it" from "no such space",
 * mirroring the not_found semantics `requireSameSpace` already established for
 * cross-space doc hits. A 403 here would turn the gate into a space-existence
 * oracle.
 *
 * Mount order: `spaceContextMiddleware` AFTER authMiddleware and BEFORE the
 * metadata routers; `requireSpaceMembership` after it, per-route (it needs
 * `req.uid` + `req.octoToken` — the token is what authorizes the verify call).
 * The public routes (collab-token, invite accept) are mounted ahead of
 * authMiddleware and never reach either. On the BOT mount neither runs as a
 * mount-wide middleware: verifyBot resolves the bot's space server-side via
 * octo-server's reverse lookup, so a bot's space is already authoritative — and
 * because the space-selector routers are shared verbatim between both mounts,
 * `requireSpaceMembership` short-circuits for bot requests rather than asking
 * octo-server whether a bot "is a member" of its own space.
 */
import type { Request, Response, NextFunction } from 'express'
import { confirmSpaceMembership } from '../../permission/spaceMembership.js'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      spaceId?: string
    }
  }
}

/** Require an `X-Space-Id` header; populates req.spaceId. 400 when missing/empty. */
export function spaceContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const raw = req.header('X-Space-Id')
  const spaceId = typeof raw === 'string' ? raw.trim() : ''
  if (spaceId === '') {
    res.status(400).json({ error: 'space_required' })
    return
  }
  req.spaceId = spaceId
  next()
}

/**
 * Confirm the caller is a member of `req.spaceId` before a space-selector route
 * runs. 404 not_found when they are not, or when membership cannot be confirmed.
 * Mount AFTER {@link spaceContextMiddleware}, on space-selector routes ONLY —
 * see the file header for why this must not be global.
 */
export async function requireSpaceMembership(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Bot mount: req.spaceId came from verifyBot's server-side reverse lookup, so
  // it is already authoritative and there is no session token to verify with.
  if (req.botToken !== undefined) {
    next()
    return
  }
  // The membership check runs on the value already trimmed and stashed by
  // spaceContextMiddleware — the same string the handler will scope by — so no
  // whitespace variant can be verified as one space and applied as another.
  const member = await confirmSpaceMembership(req.uid ?? '', req.spaceId ?? '', req.octoToken ?? '')
  if (!member) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  next()
}
