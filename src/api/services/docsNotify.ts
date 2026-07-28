/**
 * Docs notification via octo-server's internal notify API (docs-notify producer,
 * octo-server PR #584 — see .octospec/tasks/card-message-internal-dispatch/
 * docs-notify-contract.md in octo-server).
 *
 * When a doc access request is submitted, docs-backend POSTs a STRUCTURED
 * `docs_card` (raw fields only — no hand-built type-17 map, no template, no text
 * fallback) to `POST /v1/internal/notify`. octo-server authors the octo/v1 card
 * (attribution copy, deep-link, i18n; approve/deny buttons when request_id is set
 * and OCTO_DOCS_APPROVAL_CARD_ENABLED is on) and delivers it as a DM from the
 * shared notification bot, then returns `{delivered, filtered}`. Auth is the
 * docs-specific `X-Internal-Token: <OCTO_DOCS_NOTIFY_TOKEN>`, NOT a bot token.
 *
 * Contract invariants honoured here:
 *   - ONE recipient per request (`targets` single-element). We resolve the doc's
 *     approvers (owner + admins) and fan out one POST each.
 *   - Only `docs_card` is sent (never `payload`/`card`), and we never build a
 *     type-17 map — server rejects that (Decision 14).
 *   - Best-effort. Fired-and-forgotten from the submit route AFTER the request
 *     row is persisted; never throws back into it. The pull-based pending list
 *     remains the source of truth if a push fails.
 *   - Gated. If OCTO_DOCS_NOTIFY_TOKEN is unset the whole path is a silent no-op.
 */
import { config } from '../../config/env.js'
import { getOctoIdentity } from '../../auth/octoIdentity.js'
import { docMemberRepo } from '../../db/repos/docMemberRepo.js'
import { docMetaRepo } from '../../db/repos/docMetaRepo.js'
import { docAccessNotifyCardRepo, type NotifyCardCoord } from '../../db/repos/docAccessNotifyCardRepo.js'
import { ROLE_ADMIN } from '../../permission/role.js'
import { formatCardTimestamp } from '../../util/cardTime.js'
import { SHARE_SCOPE_ANYONE } from '../../permission/shareScope.js'

const INTERNAL_NOTIFY_PATH = '/v1/internal/notify'
const INTERNAL_TOKEN_HEADER = 'X-Internal-Token'
const KIND_ACCESS_REQUESTED = 'access_requested'
const KIND_COMMENTED = 'commented'
/** Abort a single notify POST after this long so a hung octo-server can't pin
 *  the best-effort call open. Comfortably above a healthy server's p99. */
const NOTIFY_TIMEOUT_MS = 5000
/**
 * Hard cap on mention recipients notified per comment (P1 fan-out guard). A ≤1MB
 * comment body could otherwise carry tens of thousands of unique `@[user:id:]`
 * tokens, each firing a concurrent POST at octo-server. Beyond this the extras
 * are dropped + logged; a real comment never legitimately @s this many people.
 */
const MAX_MENTION_RECIPIENTS = 50
/** Bounded concurrency for the notify fan-out so we never open N sockets at once. */
const NOTIFY_CONCURRENCY = 8

/**
 * Inline mention token embedded in a comment body by octo-web: `@[type:id:label]`
 * (see octo-web packages/docs/src/mentions/source.ts). `type` is 'user' | 'doc';
 * only 'user' mentions are notified. Kept in sync with the frontend MENTION_TOKEN_RE.
 *
 * The id and label segments carry BOUNDED quantifiers ({1,128} / {0,256}) rather
 * than open-ended `+`/`*`. The comment body is attacker-controllable (any reader
 * can comment), and an unbounded trailing `[^\]]*` on an unanchored /g scan lets a
 * malformed run like `@[doc:9:\\\\…` (no closing `]`) backtrack to end-of-string
 * from every start position — O(n²) polynomial ReDoS (CodeQL js/polynomial-redos).
 * A real uid/display-name never approaches these caps, so matching is unchanged;
 * over-long tokens simply fail to match (and would never be legitimate mentions).
 */
const MENTION_TOKEN_RE = /@\[(user|doc):([^:\]]{1,128}):([^\]]{0,256})\]/g

/** Unique user uids @-mentioned in a body, excluding the author (never self-notify). */
export function mentionedUserUids(body: string, excludeUid: string): string[] {
  const set = new Set<string>()
  for (const m of body.matchAll(MENTION_TOKEN_RE)) {
    if (m[1] === 'user' && m[2] && m[2] !== excludeUid) set.add(m[2])
  }
  return [...set]
}

/** Body → human-readable excerpt: mention tokens collapse to `@label`; capped for the card. */
function toExcerpt(body: string): string {
  const text = body.replace(MENTION_TOKEN_RE, (_all, _type, _id, label: string) => `@${label}`)
  return text.length > 300 ? text.slice(0, 300) : text
}

/** octo-server DocsCardFields (raw fields only; server owns copy/layout/link). */
interface DocsCardBody {
  doc_id: string
  /** Required by access_requested v2; the docs-domain idempotency/CAS key. When
   *  present (+ OCTO_DOCS_APPROVAL_CARD_ENABLED on the server) the card renders
   *  approve/deny buttons instead of the plain 查看详情 link. */
  request_id: string
  kind: string
  title: string
  /** The uid of the actor (requester / comment author). octo-server resolves the
   *  display name from this uid server-side; actor_name is a client-side fallback. */
  actor_uid: string
  actor_name: string
  excerpt: string
  updated_at: string
}

/** octo-server DeliveredCard: IM coordinates of one delivered card. message_id
 *  is a decimal STRING (int64 exceeds JS safe-integer range). */
interface DeliveredCard {
  uid: string
  channel_id: string
  channel_type: number
  message_id: string
  client_msg_no: string
}

/** octo-server NotifyResp. delivered_cards is additive (docs-card path only). */
interface NotifyResp {
  delivered: string[]
  filtered: Record<string, string>
  delivered_cards?: DeliveredCard[]
}

export interface AccessRequestNotifyParams {
  docId: string
  /** The access request row id — carried as request_id (approval CAS key). */
  requestId: string
  spaceId: string
  ownerId: string
  title: string
  /** The uid that submitted the request (excluded from recipients + used as actor). */
  requesterUid: string
  /** Free-text reason (already trimmed/capped at 512 by the caller). */
  reason: string
}

/**
 * Resolve the doc's approvers = owner + all admins, de-duplicated and with the
 * requester removed. Owner has no doc_member row, so it comes from doc_meta.
 */
async function resolveApprovers(docId: string, ownerId: string, requesterUid: string): Promise<string[]> {
  const members = await docMemberRepo.list(docId)
  const set = new Set<string>()
  if (ownerId) set.add(ownerId)
  for (const m of members) {
    if (Number(m.role) === ROLE_ADMIN) set.add(m.uid)
  }
  set.delete(requesterUid)
  return [...set]
}

/**
 * P0 recipient authorization for mention notifications. The mention uids come
 * straight from an attacker-controllable comment body (any reader can comment),
 * so before notifying we MUST intersect them with who can actually READ the doc —
 * otherwise a reader on a restricted doc could leak its title + comment excerpt
 * to a same-space user who is not a doc member (octo-server only filters by SPACE
 * membership, not per-doc access).
 *
 * Read-access mirrors the effective-role model (§4.2 + #64 shareScope):
 *   - restricted doc (default): only owner + doc_member rows can read →
 *     intersect targets with {owner} ∪ {doc_member uids}.
 *   - anyone_in_space doc: every space member can read → we cannot enumerate
 *     space members server-side here, so we pass targets through and rely on
 *     octo-server's `not_space_member` space-level filter (which IS the correct
 *     boundary in this case). Non-space-members are dropped downstream.
 *
 * Returns the subset of `targets` allowed to be notified. Fails CLOSED: if the
 * doc row is missing, returns [].
 */
async function filterMentionRecipientsByReadAccess(docId: string, targets: string[]): Promise<string[]> {
  if (targets.length === 0) return []
  const meta = await docMetaRepo.getByDocId(docId)
  if (!meta) return [] // fail closed: no doc row => notify no one
  // anyone_in_space: doc is readable by any space member; defer to octo-server's
  // space-level filter (we have no local space-membership source).
  if (meta.share_scope === SHARE_SCOPE_ANYONE) return targets
  // restricted (default): only owner + explicit doc_member rows can read.
  const members = await docMemberRepo.list(docId)
  const readers = new Set<string>()
  if (meta.owner_id) readers.add(meta.owner_id)
  for (const m of members) readers.add(m.uid)
  return targets.filter((uid) => readers.has(uid))
}

/**
 * Run `task` over `items` with bounded concurrency so a large recipient list
 * never opens all sockets at once (P1). Preserves best-effort semantics — each
 * task is expected to resolve (postNotify never rejects).
 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await task(items[i]!)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * POST one docs_card notification to a single recipient. Returns whether the
 * server confirmed delivery (for the delivered count — unchanged contract) and,
 * separately, the delivered card's coordinates for persistence when the response
 * carries a locator (absent on the text-fallback path).
 */
async function postNotify(
  spaceId: string,
  recipientUid: string,
  docsCard: DocsCardBody,
  internalToken: string,
): Promise<{ delivered: boolean; card: NotifyCardCoord | null }> {
  const url = `${config.octoIdentity.serverBaseUrl}${INTERNAL_NOTIFY_PATH}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), NOTIFY_TIMEOUT_MS)
  try {
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Content-Type': 'application/json',
          [INTERNAL_TOKEN_HEADER]: internalToken,
        },
        body: JSON.stringify({
          space_id: spaceId,
          service: config.notify.service,
          targets: [recipientUid], // contract: single recipient per request
          actor_uid: '',
          docs_card: docsCard,
        }),
      })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[octo-docs] docs-notify send failed (network)', { recipientUid, err: String(err) })
      return { delivered: false, card: null }
    }
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error('[octo-docs] docs-notify rejected', { recipientUid, status: res.status })
      return { delivered: false, card: null }
    }
    // Only `delivered[]` counts as truly sent; `filtered` entries (not_space_member
    // / busy / dispatch_failed / …) are the caller's to retry per business rules.
    // The body read stays inside the AbortController window so a trickled/hung
    // response body is bounded by the same NOTIFY_TIMEOUT_MS, not just connect.
    const body = (await res.json().catch(() => null)) as NotifyResp | null
    if (!body || !Array.isArray(body.delivered) || !body.delivered.includes(recipientUid)) {
      return { delivered: false, card: null }
    }
    // Locate this recipient's card coordinates for later in-place mutation. A
    // text-fallback delivery carries no card locator → delivered, but nothing to
    // persist. Delivery status is independent of the locator's presence so the
    // delivered count is unchanged from before.
    const found = body.delivered_cards?.find((c) => c.uid === recipientUid)
    const card: NotifyCardCoord | null = found
      ? {
          recipientUid,
          channelId: found.channel_id,
          channelType: found.channel_type,
          messageId: found.message_id,
          clientMsgNo: found.client_msg_no,
        }
      : null
    return { delivered: true, card }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Notify the doc's owner+admins that a member requested access. Best-effort and
 * self-contained: resolves approvers, resolves the requester's display name once,
 * and fans out one POST per recipient. NEVER throws — all failures are logged and
 * swallowed so the submit route's 201 is unaffected. Returns the number of cards
 * actually delivered (for tests/metrics).
 */
export async function notifyDocAccessRequested(p: AccessRequestNotifyParams): Promise<number> {
  const { docsToken } = config.notify
  if (!docsToken) {
    // Outbound notify not configured — the pull-based pending list still works.
    return 0
  }

  try {
    const approvers = await resolveApprovers(p.docId, p.ownerId, p.requesterUid)
    if (approvers.length === 0) return 0

    // Requester display name for the "X 申请访问" attribution; empty is allowed
    // (octo-server falls back to 有人/Someone). getUser never throws — it returns
    // null on any lookup failure, including when no service token is configured.
    let actorName = ''
    try {
      const user = await getOctoIdentity().getUser(p.requesterUid)
      actorName = user?.name ?? ''
    } catch {
      actorName = ''
    }

    const docsCard: DocsCardBody = {
      doc_id: p.docId,
      request_id: p.requestId,
      kind: KIND_ACCESS_REQUESTED,
      title: p.title,
      actor_uid: p.requesterUid,
      actor_name: actorName,
      excerpt: p.reason,
      updated_at: formatCardTimestamp(new Date()),
    }

    const results = await Promise.all(
      approvers.map((uid) => postNotify(p.spaceId, uid, docsCard, docsToken)),
    )
    // Persist the delivered cards' coordinates so a later approve/deny can locate
    // and terminalize every approver's card. Best-effort: a persistence failure
    // must not affect the submit 201 or the delivered count (the pull-based flow
    // stays authoritative). Keyed by request_id; the requester is already excluded
    // from `approvers`, so no self-card is recorded.
    const cards = results
      .map((r) => r.card)
      .filter((c): c is NotifyCardCoord => c !== null)
    if (cards.length > 0) {
      try {
        await docAccessNotifyCardRepo.record(p.requestId, cards)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[octo-docs] docs-notify card ledger persist failed', {
          requestId: p.requestId,
          err: String(err),
        })
      }
    }
    // Return the delivered count (unchanged contract): a delivery still counts
    // even when it carried no card locator (text fallback) and thus no ledger row.
    return results.filter((r) => r.delivered).length
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[octo-docs] docs-notify access-request failed', { docId: p.docId, err: String(err) })
    return 0
  }
}

export interface MentionNotifyParams {
  docId: string
  spaceId: string
  title: string
  /** The comment author — used as the actor and excluded from recipients (no self-notify). */
  authorUid: string
  /** The comment body (with `@[user:id:label]` tokens). */
  body: string
}

/**
 * Notify each user @-mentioned in a freshly-created comment. Best-effort, self-contained, and
 * NEVER throws — mirrors notifyDocAccessRequested so the 201 create response is unaffected. Uses
 * the docs-notify `commented` card kind (octo-server #584): server owns the "X 在评论中提到你"
 * attribution / layout / deep-link; we send only raw fields. Returns the delivered count.
 */
export async function notifyDocMentioned(p: MentionNotifyParams): Promise<number> {
  const { docsToken } = config.notify
  if (!docsToken) return 0

  try {
    const mentioned = mentionedUserUids(p.body, p.authorUid)
    if (mentioned.length === 0) return 0

    // P0: only notify uids that can actually READ this doc. Mention uids are
    // attacker-controllable (any reader can comment), and octo-server filters by
    // SPACE membership only — not per-doc access — so a restricted doc could
    // otherwise leak its title + excerpt to a same-space non-member.
    const authorized = await filterMentionRecipientsByReadAccess(p.docId, mentioned)
    if (authorized.length === 0) return 0

    // P1: cap the fan-out so a token-stuffed body can't trigger unbounded POSTs.
    let targets = authorized
    if (targets.length > MAX_MENTION_RECIPIENTS) {
      // eslint-disable-next-line no-console
      console.warn('[octo-docs] docs-notify mention recipients capped', {
        docId: p.docId,
        requested: targets.length,
        cap: MAX_MENTION_RECIPIENTS,
      })
      targets = targets.slice(0, MAX_MENTION_RECIPIENTS)
    }

    let actorName = ''
    try {
      const user = await getOctoIdentity().getUser(p.authorUid)
      actorName = user?.name ?? ''
    } catch {
      actorName = ''
    }

    const docsCard: DocsCardBody = {
      doc_id: p.docId,
      request_id: '', // commented kind: no approval CAS key
      kind: KIND_COMMENTED,
      title: p.title,
      actor_uid: p.authorUid,
      actor_name: actorName,
      excerpt: toExcerpt(p.body),
      updated_at: formatCardTimestamp(new Date()),
    }

    // P1: bounded concurrency instead of Promise.all over the whole list.
    const results = await mapWithConcurrency(targets, NOTIFY_CONCURRENCY, (uid) =>
      postNotify(p.spaceId, uid, docsCard, docsToken),
    )
    // commented kind has no request_id, so no card ledger is kept; only the
    // delivered count matters here (postNotify now returns {delivered, card}).
    return results.filter((r) => r.delivered).length
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[octo-docs] docs-notify mention failed', { docId: p.docId, err: String(err) })
    return 0
  }
}
