/**
 * octo identity integration (§4.7).
 *
 * docs depends on octo for exactly two identity capabilities:
 *   (a) token -> trusted uid  (CacheTokenParser / AuthMiddleware / POST /v1/auth/verify)
 *   (b) uid   -> user info     (GET /v1/users/:uid; batch needs a small octo addition)
 *
 * This module exposes an injectable `OctoIdentity` interface with:
 *   - an HTTP impl (cross-service fallback calling octo's POST /v1/auth/verify
 *     and GET /v1/users/:uid), and
 *   - a middleware-style placeholder impl for the same-process mount, where uid
 *     would come from octo's AuthMiddleware via c.GetLoginUID() (§4.7(a)).
 */
import { config } from '../config/env.js'
import { Singleflight, TtlCache } from '../util/singleflight.js'
import { parseOwnedBotUidsStrict } from '../util/botUids.js'

export interface OctoUser {
  uid: string
  name: string
  avatar?: string
}

export interface OctoIdentity {
  /**
   * (a) Resolve an octo session token to a trusted uid. Returns null when the
   * token is missing/invalid (caller => 401 / login_required).
   *
   * `ownedBots` is octo-server's `owned_bots`: the uids of the bots this human
   * user owns (robot.creator_uid == uid). Surfaced so "my documents" can also
   * include docs a user's bots own. Absent/non-array from octo-server => treated
   * as `[]` (fail-CLOSED: fall back to just the user's own docs, never wider).
   */
  verifyToken(token: string): Promise<{ uid: string; name?: string; ownedBots?: string[] } | null>

  /**
   * (a-bot) Resolve a bot bearer token to its trusted bot uid, the bot's space,
   * and — when the bot has a human creator — that creator's uid. Calls
   * octo-server's already-existing POST /v1/auth/verify-bot, which validates the
   * token against the `robot` table, reverse-looks-up the bot's space from its
   * most recent active `space_member` row, and returns `owner_uid` (the bot's
   * `robot.creator_uid`). The space is therefore never client-supplied
   * (anti-spoof). `ownerUid` is omitted when the bot has no human creator (e.g. a
   * platform bot). Returns null when the token is missing/invalid (caller => 401 /
   * unauthorized).
   */
  verifyBot(token: string): Promise<{ uid: string; spaceId: string; ownerUid?: string } | null>

  /**
   * (b) Look up a single user by uid. Returns null if the user does not exist
   * (used by §8.4 PUT members to reject ghost members => 404 user_not_found).
   *
   * octo-server's GET /v1/users/:uid requires auth, so a token is sent as the
   * `token` header: the configured service token when set, else the optional
   * authenticated caller's own octo session token.
   */
  getUser(uid: string, callerToken?: string, signal?: AbortSignal): Promise<OctoUser | null>

  /**
   * (b-bot) Look up a single user by uid on the BOT path, authenticating with
   * the bot's own bearer token. Calls octo-server's already-existing bot
   * user-info route GET /v1/bot/user/info?uid=... with `Authorization: Bearer
   * <botToken>` (the authBot realm), not the AuthMiddleware-guarded
   * GET /v1/users/:uid route the human path uses. The 200-vs-404 signal is the
   * same anti ghost-member existence check: 200 -> OctoUser, 404 -> null.
   *
   * This is why the bot path no longer needs OCTO_SERVER_TOKEN: the bot resolves
   * the target user with its own token instead of a privileged service token.
   */
  getUserAsBot(uid: string, botToken: string): Promise<OctoUser | null>

  /** (b) Batch profile lookup for awareness cursors (§4.7(b)). */
  getUsers(uids: string[], callerToken?: string): Promise<OctoUser[]>

  /**
   * (#64) Is the caller (`uid`, holding `token`) an ACTIVE member of Space
   * `spaceId`? Resolved server-side by REUSING octo-server's existing
   * POST /v1/auth/verify?include=context, which returns the token holder's
   * server-validated `spaces` list (active `space_member` row in a live space —
   * the same status-hardening fleet/matter rely on). Membership is therefore
   * `spaceId ∈ spaces`. No dedicated internal endpoint and no service secret:
   * the caller's OWN session token is the authorization, and verify only ever
   * answers for that token's holder — this path never inspects a third party's
   * membership. Used to honor the anyone_in_space share scope for HUMANS (bots
   * derive membership from their server-verified space, so they never call this).
   *
   * `uid` is the caller's trusted uid (already resolved from `token`); it keys
   * the cache and is asserted against verify's resolved uid so a token/uid
   * disagreement can never confirm a membership.
   *
   * FAIL-CLOSED: any transport failure / non-200 / malformed body / a response
   * that did not carry space context returns `false` (treated as NOT a member),
   * mirroring verifyToken / verifyBot returning null on failure. A transient
   * octo-server outage therefore TIGHTENS access (denies share-derived
   * reads/writes), never loosens it.
   */
  isSpaceMember(uid: string, spaceId: string, token: string): Promise<boolean>

  /**
   * (user-bot grants) Resolve the bot uids the caller (`uid`, holding `token`)
   * OWNS in Space `spaceId` — octo-server's `owned_bots_by_space[spaceId]`,
   * derived from each bot's `robot.creator_uid == uid` AND the bot's active
   * `space_member` row in `spaceId`. Reuses the SAME authoritative path as
   * isSpaceMember: POST /v1/auth/verify?include=context, whose response the
   * server scopes to the TOKEN holder — this never inspects a third party's
   * bots. Used to gate a Docs access request's `bot_uids` snapshot: a submitted
   * bot is admissible only if it is in this set.
   *
   * `uid` is asserted against verify's resolved uid so a token/uid disagreement
   * can never confirm ownership.
   *
   * FAIL-CLOSED: any transport failure / non-200 / malformed body / a response
   * that did not carry space context / a token-uid mismatch returns `[]` (the
   * caller then owns no admissible bots, so a non-empty submitted set is
   * rejected). A transient octo-server outage therefore TIGHTENS the gate
   * (rejects the bot snapshot), never widens it.
   */
  ownedBotsInSpace(uid: string, spaceId: string, token: string): Promise<string[]>
}

/**
 * HTTP impl — cross-service fallback for when the docs backend runs as a
 * separate process (§4.7(a) "备选"). Calls octo's already-existing endpoints:
 *   POST /v1/auth/verify  -> { uid, name, role, owned_bots }
 *   GET  /v1/users/:uid   -> user detail
 *
 * TODO(§4.7(b)): batch profile uses the per-uid endpoint concurrently as a
 * stopgap until octo ships the thin `POST /v1/users/batch` (wraps GetUsers).
 */
export class HttpOctoIdentity implements OctoIdentity {
  constructor(private readonly baseUrl: string = config.octoIdentity.serverBaseUrl) {}

  /**
   * Per-{uid,spaceId} coalescing + short-TTL cache for isSpaceMember (#64,
   * design §4.4). Bounds the extra octo-server QPS on hot anyone_in_space docs;
   * only positive/negative membership answers are cached, never a fail-closed
   * transport error (so a transient outage does not pin a `false` for the whole
   * TTL — the next call retries).
   */
  private readonly membershipSf = new Singleflight<boolean>()
  private readonly membershipCache = new TtlCache<boolean>(
    config.octoIdentity.membershipCacheTtlSeconds * 1000,
  )

  async verifyToken(token: string): Promise<{ uid: string; name?: string; ownedBots?: string[] } | null> {
    if (!token) return null
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/v1/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
    } catch {
      // Authoritative identity source unreachable => treat as unverified.
      return null
    }
    if (!res.ok) return null
    const body = (await res.json().catch(() => null)) as
      | { uid?: string; name?: string; owned_bots?: Array<{ uid?: string } | string> }
      | null
    if (!body || typeof body.uid !== 'string' || body.uid === '') return null
    // octo-server sends `owned_bots` (snake_case) as an OBJECT array
    // [{uid,name},...] (authVerifyTokenResp.ownedBot); older/other shapes may
    // send a bare uid string. Accept both, extracting the bot uid. FAIL-CLOSED:
    // a missing / non-array value degrades to [] (caller then sees only its own
    // docs) — it is NEVER allowed to widen visibility.
    const ownedBots = Array.isArray(body.owned_bots)
      ? body.owned_bots
          .map((b) => (typeof b === 'string' ? b : b && typeof b.uid === 'string' ? b.uid : ''))
          .filter((uid) => uid !== '')
      : []
    return { uid: body.uid, name: body.name, ownedBots }
  }

  async verifyBot(token: string): Promise<{ uid: string; spaceId: string; ownerUid?: string } | null> {
    if (!token) return null
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/v1/auth/verify-bot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bot_token: token }),
      })
    } catch {
      // Authoritative identity source unreachable => treat as unverified.
      return null
    }
    if (!res.ok) return null
    const body = (await res.json().catch(() => null)) as
      | { bot_uid?: string; space_id?: string; owner_uid?: string }
      | null
    if (!body || typeof body.bot_uid !== 'string' || body.bot_uid === '') return null
    // The space is whatever octo-server reverse-resolved from the bot's active
    // space_member row; it is never a client-supplied value (anti-spoof).
    //
    // A bot with no resolvable space MUST NOT be authorized: reject it here
    // (return null, the unverified-identity signal) rather than passing an empty
    // spaceId downstream. Every doc guard scopes on req.spaceId, so an empty
    // space would silently defeat that scoping (empty === empty matches nothing
    // real, but bypasses the intended isolation). Enforcing it at the identity
    // layer means verifyBotMiddleware 401s a spaceless bot via its existing
    // null check, with no per-middleware special case, and keeps the invariant
    // "a verified bot identity always carries a real space" in one place.
    if (typeof body.space_id !== 'string' || body.space_id === '') return null
    // owner_uid is the bot's robot.creator_uid (the human who owns the bot).
    // octo-server returns '' for a bot with no human creator (e.g. a platform
    // bot); surface it only when it is a real uid so callers can skip the
    // owner-grant step cleanly.
    const ownerUid =
      typeof body.owner_uid === 'string' && body.owner_uid !== '' ? body.owner_uid : undefined
    return { uid: body.bot_uid, spaceId: body.space_id, ...(ownerUid ? { ownerUid } : {}) }
  }

  async getUser(uid: string, callerToken?: string, signal?: AbortSignal): Promise<OctoUser | null> {
    // octo-server requires auth on /v1/users/:uid: prefer a configured service
    // token, else fall back to the caller's own session token. Never logged.
    const token = config.octoIdentity.serviceToken || callerToken || ''
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/v1/users/${encodeURIComponent(uid)}`, {
        headers: token ? { token } : {},
        // Caller-provided deadline: an abort reclaims the socket instead of
        // leaving an in-flight request against a stalled identity endpoint.
        ...(signal ? { signal } : {}),
      })
    } catch {
      return null
    }
    if (res.status === 404) return null
    if (!res.ok) return null
    const body = (await res.json().catch(() => null)) as
      | { uid?: string; name?: string; avatar?: string }
      | null
    if (!body || typeof body.uid !== 'string') return null
    return { uid: body.uid, name: body.name ?? '', avatar: body.avatar }
  }

  async getUserAsBot(uid: string, botToken: string): Promise<OctoUser | null> {
    // The bot resolves the target user with its own bearer token against the
    // authBot-guarded bot user-info route — no OCTO_SERVER_TOKEN needed. Never
    // logged. An empty token can never authenticate, so short-circuit to null.
    if (!botToken) return null
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/v1/bot/user/info?uid=${encodeURIComponent(uid)}`, {
        headers: { Authorization: `Bearer ${botToken}` },
      })
    } catch {
      return null
    }
    // 404 is the anti ghost-member signal (user does not exist) => null.
    if (res.status === 404) return null
    if (!res.ok) return null
    const body = (await res.json().catch(() => null)) as
      | { uid?: string; name?: string; avatar?: string }
      | null
    if (!body || typeof body.uid !== 'string') return null
    return { uid: body.uid, name: body.name ?? '', avatar: body.avatar }
  }

  async getUsers(uids: string[], callerToken?: string): Promise<OctoUser[]> {
    const results = await Promise.all(uids.map((u) => this.getUser(u, callerToken)))
    return results.filter((u): u is OctoUser => u !== null)
  }

  async ownedBotsInSpace(uid: string, spaceId: string, token: string): Promise<string[]> {
    // A missing principal/space can own no admissible bots, and an absent token
    // cannot authorize the verify call. Short out before any IO (fail-closed).
    if (!uid || !spaceId || !token) return []
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/v1/auth/verify?include=context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
    } catch {
      // Authoritative source unreachable => cannot confirm ownership => [].
      return []
    }
    if (!res.ok) return []
    const body = (await res.json().catch(() => null)) as
      | { uid?: unknown; context_included?: unknown; owned_bots_by_space?: unknown }
      | null
    if (!body) return []
    // verify answers for the TOKEN holder, so the uid it resolves must be the
    // uid we are gating on; a mismatch can never confirm ownership.
    if (typeof body.uid !== 'string' || body.uid !== uid) return []
    // context is opt-in: a pre-context octo-server omits these fields. Without
    // context we cannot confirm ownership => fail-closed (never treat an absent
    // map as "owns everything").
    if (body.context_included !== true) return []
    const map = body.owned_bots_by_space
    if (typeof map !== 'object' || map === null || Array.isArray(map)) return []
    // Extract only THIS space's list; parseOwnedBotUidsStrict fails the WHOLE
    // list closed on any illegal/duplicate element (=> []), so a garbled octo-
    // server body can never authorize a partial set. It is NOT count-capped, so
    // an owner of > MAX_BOT_UIDS bots still gets the complete authoritative set.
    const list = (map as Record<string, unknown>)[spaceId]
    return parseOwnedBotUidsStrict(list)
  }

  async isSpaceMember(uid: string, spaceId: string, token: string): Promise<boolean> {
    // A missing principal or space can never be a real active membership, and an
    // absent caller token cannot authorize a verify call; short out before any
    // IO (also avoids caching a degenerate key).
    if (!uid || !spaceId || !token) return false
    const key = `${uid} ${spaceId}`
    const cached = this.membershipCache.get(key)
    if (cached !== undefined) return cached
    return this.membershipSf.do(key, async () => {
      const member = await this.fetchIsSpaceMember(uid, spaceId, token)
      // Only cache a confirmed answer. A fail-closed `false` from a transport
      // error / un-confirmable context (fetchIsSpaceMember returns null) is NOT
      // cached — fetchIsSpaceMember distinguishes the two by returning null on
      // error, which we map to an uncached false, so a transient outage does not
      // pin a `false` for the whole TTL (the next call retries).
      if (member !== null) this.membershipCache.set(key, member)
      return member ?? false
    })
  }

  /**
   * Resolve the caller's OWN space membership by reusing octo-server's existing
   * POST /v1/auth/verify?include=context (the authoritative token→identity path
   * fleet/matter already use). verify returns the token holder's server-validated
   * `spaces` list, so membership is `spaceId ∈ spaces`. Returns the membership
   * boolean, or null on any transport failure / non-200 / malformed body / a
   * response that did not carry space context, so the caller can distinguish
   * "confirmed not-a-member" (false) from "could not confirm" (null =>
   * fail-closed, uncached). No service secret is used: the caller's own session
   * token IS the authorization, and verify only answers for that token's holder.
   */
  private async fetchIsSpaceMember(uid: string, spaceId: string, token: string): Promise<boolean | null> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/v1/auth/verify?include=context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
    } catch {
      // Authoritative source unreachable => cannot confirm => fail-closed.
      return null
    }
    if (!res.ok) return null
    const body = (await res.json().catch(() => null)) as
      | { uid?: unknown; context_included?: unknown; spaces?: unknown }
      | null
    if (!body) return null
    // Defense-in-depth on the "token holder only" boundary: verify answers for
    // the TOKEN holder, so the uid it resolves must be the uid we are checking.
    // A mismatch (token/uid disagree) can never be a confirmable membership.
    if (typeof body.uid !== 'string' || body.uid !== uid) return null
    // The context fields are opt-in: a pre-context octo-server omits
    // context_included/spaces entirely. Without them we cannot confirm
    // membership => fail-closed (never treat an absent list as "zero spaces").
    if (body.context_included !== true || !Array.isArray(body.spaces)) return null
    return body.spaces.includes(spaceId)
  }
}

/**
 * Middleware-style placeholder for the same-process mount (§4.7(a) primary
 * path). When docs endpoints are mounted behind octo-server's AuthMiddleware,
 * the trusted uid is taken from c.GetLoginUID() — there is no self-rolled
 * verification. This stub documents that path; wiring it requires running
 * inside the octo-server process.
 *
 * TODO(§4.7(a)): replace with a real bridge to octo AuthMiddleware /
 * CacheTokenParser once docs mounts in-process.
 */
export class MiddlewareOctoIdentity implements OctoIdentity {
  // Optional: when mounted in-process, a request-scoped uid would be injected
  // by the middleware. Kept as an HTTP delegate so this remains runnable.
  constructor(private readonly delegate: OctoIdentity = new HttpOctoIdentity()) {}

  async verifyToken(token: string): Promise<{ uid: string; name?: string; ownedBots?: string[] } | null> {
    // In-process: octo AuthMiddleware would already have populated the uid.
    // Until wired, delegate to the HTTP introspection endpoint (which already
    // parses owned_bots -> ownedBots, keeping the contract identical).
    return this.delegate.verifyToken(token)
  }

  getUser(uid: string, callerToken?: string, signal?: AbortSignal): Promise<OctoUser | null> {
    return this.delegate.getUser(uid, callerToken, signal)
  }

  getUserAsBot(uid: string, botToken: string): Promise<OctoUser | null> {
    return this.delegate.getUserAsBot(uid, botToken)
  }

  verifyBot(token: string): Promise<{ uid: string; spaceId: string; ownerUid?: string } | null> {
    return this.delegate.verifyBot(token)
  }

  getUsers(uids: string[], callerToken?: string): Promise<OctoUser[]> {
    return this.delegate.getUsers(uids, callerToken)
  }

  isSpaceMember(uid: string, spaceId: string, token: string): Promise<boolean> {
    return this.delegate.isSpaceMember(uid, spaceId, token)
  }

  ownedBotsInSpace(uid: string, spaceId: string, token: string): Promise<string[]> {
    return this.delegate.ownedBotsInSpace(uid, spaceId, token)
  }
}

let singleton: OctoIdentity | null = null

/** Resolve the configured OctoIdentity impl (OCTO_IDENTITY_MODE). */
export function getOctoIdentity(): OctoIdentity {
  if (!singleton) {
    singleton =
      config.octoIdentity.mode === 'middleware'
        ? new MiddlewareOctoIdentity()
        : new HttpOctoIdentity()
  }
  return singleton
}

/** Test seam: inject a stub identity. */
export function setOctoIdentity(impl: OctoIdentity): void {
  singleton = impl
}
