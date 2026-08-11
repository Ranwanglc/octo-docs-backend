/**
 * verifyBot middleware — bot-facing entry (§ v4.3 bot docs API).
 *
 * The bot entry re-mounts the same metadata routers as the human `/api/v1/docs`
 * chain, but swaps identity resolution: instead of authMiddleware +
 * spaceContextMiddleware, a single verifyBot resolves the incoming bot bearer
 * token against octo-server's existing POST /v1/auth/verify-bot and injects the
 * trusted identity server-side.
 *
 * It differs from the human chain in three deliberate ways:
 *   1. It sets BOTH req.uid (= bot uid) and req.spaceId (= the space octo-server
 *      reverse-resolved from the bot's space_member row). No spaceContextMiddleware
 *      is mounted on the bot path.
 *   2. It MUST NOT read or trust a client-supplied `X-Space-Id` header — the space
 *      is only ever the server-side reverse lookup (anti-spoof).
 *   3. It MUST NOT set req.octoToken. The bot path has no caller session token.
 *      Instead it stashes the bot's own bearer token on req.botToken, which the
 *      downstream anti ghost-member existence check (members/forwardGrant) uses
 *      to call octo-server's bot user-info route (GET /v1/bot/user/info) on the
 *      bot-token realm. OCTO_SERVER_TOKEN is therefore no longer required for the
 *      bot path.
 *
 * Mount order: FIRST on the bot router, before any metadata router. On verify
 * failure return 401 (same envelope as authMiddleware).
 */
import type { Request, Response, NextFunction } from 'express'
import { extractOctoToken } from './auth.js'
import { getOctoIdentity } from '../../auth/octoIdentity.js'

/**
 * Require a valid bot identity; populates req.uid and req.spaceId from the
 * server-side verify-bot reverse lookup. 401 when the token is missing/invalid.
 */
export async function verifyBotMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractOctoToken(req)
  const identity = await getOctoIdentity().verifyBot(token)
  if (!identity) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }
  req.uid = identity.uid
  // Space comes solely from the server-side reverse lookup; any client X-Space-Id
  // is deliberately ignored here (anti-spoof).
  req.spaceId = identity.spaceId
  // Explicit bot doc space-scoping policy (remove-sp §6): the guard enforces
  // requireSameSpace against this server-resolved Space, so a bot NEVER gains the
  // Human open-context cross-Space locate. Set here (not inferred from
  // req.botToken in shared logic) so the boundary is declared at the mount.
  req.docSpaceScope = { mode: 'bot', spaceId: identity.spaceId }
  // Stash the bot's own bearer token so downstream handlers can authenticate
  // their octo-server lookups on the bot-token realm — specifically the anti
  // ghost-member existence check in members/forwardGrant, which calls
  // GET /v1/bot/user/info with this token (see HttpOctoIdentity.getUserAsBot).
  // This is NOT req.octoToken: the bot path has no caller session token, and the
  // bot realm (authBot) is separate from the human session/service-token realm.
  req.botToken = token
  // Surface the bot's human owner (robot.creator_uid) when octo-server resolved
  // one. The doc-create path uses it to auto-grant that owner admin so the bot's
  // human owner can access docs the bot creates. Absent for a bot with no human
  // creator (e.g. a platform bot), in which case the grant is skipped.
  req.botOwnerUid = identity.ownerUid
  next()
}
