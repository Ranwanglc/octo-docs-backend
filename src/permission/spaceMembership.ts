/**
 * confirmSpaceMembership — the single server-side answer to "is this caller an
 * occupant of this space?".
 *
 * Both header-driven surfaces need the same verdict with the same failure
 * semantics: the legacy `/api/v1/docs` chain (`api/middleware/spaceContext.ts`)
 * and the PPT chain (`api/ppt/auth.ts`), which is mounted WITHOUT the legacy
 * middleware and would otherwise be an independent way into the same boundary.
 * They were introduced as two hand-copied blocks and had already drifted apart
 * once before this got extracted, so the check lives here and each surface only
 * owns its own error SHAPE (bare JSON vs enveloped `PptApiError`).
 *
 * Why this is authority where the header is not: the verdict is derived from the
 * CALLER'S OWN session token — `isSpaceMember` resolves it through octo-server's
 * `POST /v1/auth/verify?include=context` and tests `spaceId ∈ spaces`. A spoofed
 * `X-Space-Id` cannot influence that lookup; it can only be the value being
 * tested. Results are coalesced + short-TTL cached per `{uid, spaceId}` (default
 * 30 s, `SPACE_MEMBERSHIP_CACHE_TTL_SECONDS`, confirmed answers only), so this
 * costs at most one octo-server call per caller per space per TTL.
 *
 * Fail-closed, and containing BOTH failure shapes is the point:
 *   - a REJECTED lookup (identity service down / non-2xx), and
 *   - a throw raised BEFORE a promise exists — reachable via an injected
 *     identity that is missing the method (a synchronous TypeError on call).
 *
 * A bare `.catch()` on the returned promise covers only the first. Express
 * `^4.19.2` does not adopt a rejected promise from an async middleware, so an
 * uncontained throw would HANG the request rather than refuse it. try/catch
 * covers both, and every failure degrades to `false` — never a pass, never a
 * 500, never a hang. Over-refusal is visible and self-heals when identity
 * recovers; under-refusal is a silent cross-space authorization bypass on the
 * exact path this check exists to protect.
 */
import { getOctoIdentity } from '../auth/octoIdentity.js'

export async function confirmSpaceMembership(uid: string, spaceId: string, token: string): Promise<boolean> {
  // An absent principal or token cannot authorize the verify call. Refuse rather
  // than skip the check — skipping would make "no token" the widest privilege.
  if (uid === '' || spaceId === '' || token === '') return false
  try {
    return await getOctoIdentity().isSpaceMember(uid, spaceId, token)
  } catch {
    return false
  }
}
