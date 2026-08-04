/**
 * Bot-uid snapshot handling (docs user-bot access grants).
 *
 * A Docs access request can carry a snapshot of the requester's OWN Space bots
 * so an admin's single approval grants those bots the same role as the human.
 * The snapshot is untrusted request-body input on the write path AND re-read
 * from a JSON DB column on the read path. Those two boundaries have DIFFERENT
 * contracts, so they get TWO parsers:
 *
 *   - parseRequestBotUids  — STRICT: any illegal body (non-array, bad element,
 *     duplicate, over-count) is a hard error (=> 400). Never silently drops or
 *     truncates: the client learns exactly what it sent wrong.
 *   - parseStoredBotUids   — FAIL-CLOSED: authoritative trusted data. Any
 *     malformed value (bad JSON, wrong type, illegal/duplicate element, over
 *     count) collapses the WHOLE snapshot to [] — never a partial list — so a
 *     corrupt/hand-edited row authorizes nothing rather than something partial.
 *   - parseOwnedBotUidsStrict — FAIL-CLOSED whole-list parser for the octo-
 *     server owned-bots set (the subset gate's trusted membership list). Any
 *     illegal/duplicate element => [] (never partial), but NOT count-capped: an
 *     owner may legitimately own > MAX_BOT_UIDS bots.
 */

/** Max bots a single access request may carry (list-bombing defense). */
export const MAX_BOT_UIDS = 50
/** Max length of a single bot uid (octo uids are short; bounds column + logs). */
export const MAX_BOT_UID_LEN = 64

/** Thrown by parseRequestBotUids on illegal request input (=> HTTP 400). */
export class BotUidsValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BotUidsValidationError'
  }
}

/**
 * Is one element a well-formed uid? A clean uid is a non-empty string that is
 * already trimmed (leading/trailing whitespace is treated as malformed input,
 * not silently stripped) and within the length bound.
 */
function isCleanUid(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_BOT_UID_LEN && v.trim() === v
}

/**
 * STRICT request-body parser. Omitted/undefined => []. Otherwise the value MUST
 * be an array whose every element is a trimmed non-empty string ≤ MAX_BOT_UID_LEN
 * with NO duplicates and total ≤ MAX_BOT_UIDS; any violation throws
 * BotUidsValidationError (the route maps it to 400). The accepted list is
 * returned sorted (canonical, order-independent) — a duplicate is rejected, not
 * collapsed. Never silently drops or truncates.
 */
export function parseRequestBotUids(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new BotUidsValidationError('botUids must be an array of strings')
  if (value.length > MAX_BOT_UIDS) {
    throw new BotUidsValidationError(`botUids exceeds max of ${MAX_BOT_UIDS}`)
  }
  const seen = new Set<string>()
  for (const raw of value) {
    if (!isCleanUid(raw)) {
      throw new BotUidsValidationError('each botUids entry must be a non-empty trimmed string ≤ 64 chars')
    }
    if (seen.has(raw)) throw new BotUidsValidationError('botUids must not contain duplicates')
    seen.add(raw)
  }
  return Array.from(seen).sort()
}

/**
 * FAIL-CLOSED parser for an octo-server-derived owned-bots list (the verify
 * response's owned_bots_by_space[spaceId]). This is the authoritative set the
 * subset gate trusts, so it is treated as a WHOLE: any non-array, or ANY
 * illegal (non-string / untrimmed / empty / > MAX_BOT_UID_LEN) or duplicate
 * element collapses the ENTIRE list to [] — never a partial list. Unlike
 * parseStoredBotUids it is NOT count-capped: an owner may legitimately own more
 * than MAX_BOT_UIDS bots (the request-body snapshot is what MAX_BOT_UIDS caps,
 * never the authoritative owned set), so a valid > MAX_BOT_UIDS list is
 * returned in full — capping it here would wrongly deny an owner whose target
 * bot sits past the cap. Returns clean, de-duplicated, sorted uids. Never throws.
 */
export function parseOwnedBotUidsStrict(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const raw of value) {
    // Any illegal or duplicate element fails the whole list closed (no partial
    // keep) — but NO count cap: a large valid owned set is kept intact.
    if (!isCleanUid(raw) || seen.has(raw)) return []
    seen.add(raw)
  }
  return Array.from(seen).sort()
}

/**
 * FAIL-CLOSED trusted-data parser for the DB JSON column. mysql2 may hand back
 * the value already-parsed (array) or as a JSON string; a legacy/NULL row is
 * null. On ANY malformation — bad JSON, non-array, an illegal/duplicate element,
 * or > MAX_BOT_UIDS — the WHOLE snapshot degrades to [] (never a partial list),
 * so a corrupt/hand-edited row can never authorize a bot. Never throws.
 */
export function parseStoredBotUids(value: unknown): string[] {
  if (value == null) return []
  let arr: unknown = value
  if (typeof value === 'string') {
    try {
      arr = JSON.parse(value)
    } catch {
      return []
    }
  }
  if (!Array.isArray(arr) || arr.length > MAX_BOT_UIDS) return []
  const seen = new Set<string>()
  for (const raw of arr) {
    // Any illegal or duplicate element fails the whole snapshot closed.
    if (!isCleanUid(raw) || seen.has(raw)) return []
    seen.add(raw)
  }
  return Array.from(seen).sort()
}
