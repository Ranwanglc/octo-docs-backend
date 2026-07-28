/**
 * Signed card-action callback endpoint (docs approve/deny buttons).
 *
 * Implements the consumer contract in octo-server
 * `docs/card-action-callback-consumer.md`: octo-server POSTs an HMAC-signed
 * decision here when a user taps 同意/拒绝 on a docs `access_requested` card. We
 * verify the signature over the RAW body, enforce timestamp freshness + header
 * ↔ body `event_id` match, then apply the decision idempotently and return a
 * typed result. No Bot token, no polling, no message/card API calls.
 *
 * Mounting (see app.ts): this route reads the raw body for HMAC, so it is
 * mounted with `express.raw` BEFORE the global `express.json`, and OUTSIDE the
 * authMiddleware/space chain (the HMAC signature is the authenticator). The
 * callback path MUST equal the path octo-server signs (the `url` path in its
 * OCTO_CARD_ACTION_ROUTES entry) — see CARD_ACTION_DECIDE_PATH.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { type Request, type Response } from 'express'
import { config } from '../../config/env.js'
import { docMetaRepo } from '../../db/repos/docMetaRepo.js'
import {
  docAccessRequestRepo,
  REQUEST_STATUS_PENDING,
  REQUEST_STATUS_APPROVED,
  REQUEST_STATUS_DENIED,
  REQUEST_STATUS_CANCELLED,
} from '../../db/repos/docAccessRequestRepo.js'
import { docCardActionReceiptRepo } from '../../db/repos/docCardActionReceiptRepo.js'
import { resolveRole } from '../../permission/resolveRole.js'
import { grantForwardAccess } from '../services/grantForward.js'
import { syncDecisionCards } from '../services/docsDecisionCardSync.js'
import { buildDecisionDisplay, buildDecisionDisplayAt } from '../services/decisionDisplay.js'

/**
 * Exact callback path. octo-server signs the canonical over the PATH of the
 * route's `url` in OCTO_CARD_ACTION_ROUTES, so three things MUST be byte-identical
 * or every real callback 401s: (1) this constant, (2) the app.ts mount path, and
 * (3) the path component of the route `url` operators configure
 * (`http://<docs-host>/api/v1/card-actions/decide`). The `/v1/...` path in
 * octo-server's published HMAC test vector is only an ALGORITHM example — the
 * real signed path is whatever the route url declares. `cardActionDecide.test.ts`
 * drives the handler with a signature computed over THIS constant to prove that
 * self-consistency (the vector test separately proves canonical-format parity).
 */
export const CARD_ACTION_DECIDE_PATH = '/api/v1/card-actions/decide'
const MAX_SKEW_SECONDS = 300

interface DecisionRequest {
  event_id: string
  action_id: string
  decision: string
  operator_uid: string
  doc_id?: string
  request_id?: string
  inputs: Record<string, unknown>
  data?: Record<string, unknown>
  message_id: string
  channel_id: string
  channel_type: number
  space_id?: string
  acted_at: number
}

type Disposition = 'applied' | 'replayed' | 'forbidden' | 'conflict' | 'not_found'
type DecisionState = 'pending' | 'approved' | 'denied' | 'cancelled'
interface DecisionResult {
  disposition: Disposition
  state: DecisionState
  requester_uid?: string
  display?: Record<string, string>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function statusToState(status: number): DecisionState {
  switch (status) {
    case REQUEST_STATUS_APPROVED:
      return 'approved'
    case REQUEST_STATUS_DENIED:
      return 'denied'
    case REQUEST_STATUS_CANCELLED:
      return 'cancelled'
    default:
      return 'pending'
  }
}

/**
 * Verify `X-Octo-Signature` over the raw body. Canonical (UTF-8):
 *   v1\nPOST\n<path>\n<timestamp>\n<event-id>\n<sha256-hex-of-body>
 */
export function verifyOctoSignature(
  rawBody: Buffer,
  path: string,
  timestamp: string,
  eventId: string,
  signature: string,
  secret: string,
  nowSeconds: number,
): boolean {
  if (!secret || Buffer.byteLength(secret) < 32) return false
  // event_id: positive integer, bounded to the card_action_receipt.event_id
  // column width (VARCHAR(32)). Rejecting >32 digits here turns an over-long id
  // into a clean signature reject rather than a later 503 at the claim() INSERT.
  if (!/^[1-9][0-9]{0,31}$/.test(eventId) || !/^[0-9]+$/.test(timestamp)) return false
  if (!/^v1=[0-9a-f]{64}$/.test(signature)) return false
  const sentAt = Number(timestamp)
  if (!Number.isSafeInteger(sentAt) || Math.abs(nowSeconds - sentAt) > MAX_SKEW_SECONDS) return false

  const bodyHash = createHash('sha256').update(rawBody).digest('hex')
  const canonical = ['v1', 'POST', path, timestamp, eventId, bodyHash].join('\n')
  const expected = createHmac('sha256', secret).update(canonical).digest()
  const provided = Buffer.from(signature.slice(3), 'hex')
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

function parseDecisionRequest(value: unknown): DecisionRequest {
  if (!isRecord(value)) throw new Error('request must be an object')
  for (const key of ['action_id', 'decision', 'operator_uid', 'message_id', 'channel_id']) {
    if (typeof value[key] !== 'string' || value[key] === '') throw new Error('missing required string')
  }
  if (typeof value.event_id !== 'string' || !/^[1-9][0-9]{0,31}$/.test(value.event_id)) throw new Error('invalid event_id')
  if (
    typeof value.channel_type !== 'number' ||
    !Number.isInteger(value.channel_type) ||
    typeof value.acted_at !== 'number' ||
    !Number.isSafeInteger(value.acted_at)
  ) {
    throw new Error('invalid numeric field')
  }
  if (!isRecord(value.inputs) || (value.data !== undefined && !isRecord(value.data))) {
    throw new Error('invalid action data')
  }
  for (const key of ['doc_id', 'request_id', 'space_id']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error(`invalid ${key}`)
  }
  return value as unknown as DecisionRequest
}

/** Read a string field from top-level or from the server-authoritative `data` map. */
function fieldOrData(req: DecisionRequest, key: 'doc_id' | 'request_id'): string {
  const top = req[key]
  if (typeof top === 'string' && top !== '') return top
  const fromData = req.data?.[key]
  return typeof fromData === 'string' ? fromData : ''
}

// Input id the deny dialog submits the reviewer's reason under — the cross-repo
// contract with octo-server (pkg/cardtmpl DocsDenyReasonInputID). Approve submits
// this as "" harmlessly. Capped to the decision_note column bound; octo-server
// already enforces its own (4 KiB) submit cap, this is a defensive DB-side guard.
const DENY_REASON_INPUT_ID = 'deny_reason'
const MAX_DECISION_NOTE_CHARS = 500

/** Reviewer's decision note from the card inputs (empty when absent/blank). */
function decisionNote(req: DecisionRequest): string {
  const raw = req.inputs[DENY_REASON_INPUT_ID]
  return typeof raw === 'string' ? raw.trim().slice(0, MAX_DECISION_NOTE_CHARS) : ''
}

/** Compute the authoritative decision AND apply the grant side-effect exactly once.
 *
 * The grant is gated strictly on `transitioned === true` — i.e. THIS execution is the
 * one that flipped the request pending→terminal via the `decide()` CAS. That CAS succeeds
 * exactly once across every delivery/event for a given request, so exactly one execution
 * ever grants, and it is always the legitimate decider (the request was still `pending`,
 * so `requested_role` is the un-superseded role). Any non-transition — a foreign event on
 * an already-decided row (e.g. the HTTP route approved at an explicitly LOWER role, leaving
 * a stale higher `requested_role`), a concurrent in-flight sibling delivery of the same
 * event that lost the CAS, or a genuine conflicting terminal — must NEVER grant, else a
 * stale `requested_role` could escalate a member past an admin's explicit downgrade. */
async function computeDecision(req: DecisionRequest): Promise<DecisionResult> {
  // Treat `decision` as a consumer-owned enum; only approve/deny are valid here.
  if (req.decision !== 'approve' && req.decision !== 'deny') {
    return { disposition: 'forbidden', state: 'pending' }
  }
  const docId = fieldOrData(req, 'doc_id')
  const requestId = fieldOrData(req, 'request_id')
  if (!docId || !requestId) return { disposition: 'not_found', state: 'cancelled' }

  const meta = await docMetaRepo.getByDocId(docId)
  // Missing / deleted doc, or a cross-space callback, is indistinguishable from not-found.
  if (!meta || meta.status === 0) return { disposition: 'not_found', state: 'cancelled' }
  if (req.space_id && meta.space_id !== req.space_id) return { disposition: 'not_found', state: 'cancelled' }
  // Archived doc (status===2): the normal approve route rejects with 409 via
  // requireDocRole before granting, so the signed callback must not be a weaker
  // path that grants membership the HTTP API would refuse. Report `conflict`
  // (the callback's 409-equivalent) and grant nothing — a decision on an
  // archived doc must not take effect and become live if it is later unarchived.
  if (meta.status === 2) {
    const current = await docAccessRequestRepo.getByRequestId(docId, requestId)
    return {
      disposition: 'conflict',
      state: statusToState(current?.status ?? REQUEST_STATUS_PENDING),
      requester_uid: current?.uid,
    }
  }

  const request = await docAccessRequestRepo.getByRequestId(docId, requestId)
  if (!request) return { disposition: 'not_found', state: 'cancelled' }

  // operator_uid is an authenticated identity assertion, NOT authorization —
  // re-check the operator is currently an admin/owner of this doc.
  const opRole = await resolveRole(req.operator_uid, docId)
  if (opRole !== 'admin') {
    return { disposition: 'forbidden', state: statusToState(request.status), requester_uid: request.uid }
  }

  const targetStatus = req.decision === 'approve' ? REQUEST_STATUS_APPROVED : REQUEST_STATUS_DENIED
  const transitioned = await docAccessRequestRepo.decide({
    docId,
    requestId,
    status: targetStatus,
    decidedBy: req.operator_uid,
    // The reviewer's reason (deny dialog). Persisted atomically with the status
    // flip; on approve the card submits "" so this is a no-op there.
    note: decisionNote(req),
  })
  if (!transitioned) {
    // The pending→terminal CAS did not fire — THIS execution is NOT the decider,
    // so it must apply NO grant side-effect (that belongs solely to the one
    // execution whose CAS won; see below). Two report-only outcomes:
    //   (a) the request already reached OUR target state — a same-decision
    //       redelivery, a concurrent sibling of the same event that lost the CAS,
    //       or the HTTP route decided identically. The grant (if any) was or will
    //       be applied by the actual decider; report the terminal state without
    //       re-granting. Reusing the winner's stored response is handled by the
    //       receipt replay in decideIdempotently, so `applied` here is safe and
    //       carries no side-effect.
    //   (b) the request reached a DIFFERENT terminal state (approved vs denied,
    //       or approved at a LOWER role via the HTTP route leaving a stale higher
    //       requested_role) — a genuine conflict. Never grant.
    const current = await docAccessRequestRepo.getByRequestId(docId, requestId)
    const currentStatus = current?.status ?? REQUEST_STATUS_PENDING
    if (currentStatus !== targetStatus) {
      return { disposition: 'conflict', state: statusToState(currentStatus), requester_uid: request.uid }
    }
    // Already at our target, decided by someone else — report the ACTUAL decider
    // (current.decided_by / when the row transitioned), NEVER this losing caller.
    // A duplicate or concurrent click on a not-yet-synced card must not rewrite
    // the result card to show the late clicker as the approver, nor their click
    // time as the decision time. Fall back safely (empty → octo-server shows the
    // generic operator label) rather than fabricate this caller's identity.
    return {
      disposition: 'applied',
      state: req.decision === 'approve' ? 'approved' : 'denied',
      requester_uid: request.uid,
      display: (
        await buildDecisionDisplayAt(meta.title, current?.decided_by ?? '', current?.updated_at)
      ).display,
    }
  }

  // transitioned === true: THIS execution is the sole decider. It is the only one
  // that may grant, and it does so with the request's role captured while still
  // pending (un-superseded). This makes the grant exactly-once and immune to the
  // stale-requested_role escalation: a foreign/concurrent event that did not win
  // the CAS falls into the report-only branch above and grants nothing.
  if (req.decision === 'approve') {
    // Grant the requested role via the shared only-up max-merge path. Idempotent
    // (resolveRole skip / GREATEST upsert).
    await grantForwardAccess({
      docId,
      documentName: meta.document_name,
      uid: request.uid,
      roleNum: Number(request.requested_role),
      grantedBy: req.operator_uid,
    })
  }

  // Sibling-card sync (task docs-access-decision-card-sync): drive every OTHER
  // approver's card to terminal. octo-server's finalizer terminalizes the clicked
  // card; this covers the rest. Gated on transitioned===true so it fires exactly
  // once (the sole decider execution) and never on a redelivery/replay. On this
  // card-callback path the finalizer already handled the decider's clicked card,
  // so it is skipped here (deciderCardHandledExternally: true). Fire-and-forget:
  // never blocks or fails the callback response, and the 409/receipt guards stay
  // the authoritative protection.
  // Resolve the decider's display copy ONCE for this decision and reuse it for
  // both the response display and the sibling-card sync — otherwise the same uid
  // is looked up twice per callback (and logs two misses in the default
  // deployment). acted_at is the authoritative decision time for every card.
  const { display, operatorName } = await buildDecisionDisplay(
    meta.title,
    req.operator_uid,
    req.acted_at,
  )

  void syncDecisionCards({
    requestId,
    spaceId: meta.space_id,
    docId,
    title: meta.title,
    deciderUid: req.operator_uid,
    deciderCardHandledExternally: true,
    denied: req.decision === 'deny',
    denyReason: decisionNote(req),
    deciderName: operatorName,
    decidedAtSeconds: req.acted_at,
  }).catch(() => {})

  return {
    disposition: 'applied',
    state: req.decision === 'approve' ? 'approved' : 'denied',
    requester_uid: request.uid,
    display,
  }
}

/**
 * Idempotent apply: claim the event_id, execute once, store + replay the exact
 * response. Two redelivery races are handled:
 *   - a finalized receipt exists → replay it verbatim (no re-execution);
 *   - a claimed-but-unfinalized receipt (prior crash OR an in-flight concurrent
 *     execution) → re-execute (domain ops are idempotent), then finalize under a
 *     `response IS NULL` CAS. If THIS execution loses that CAS (a concurrent
 *     execution finalized first), return the stored winner response rather than
 *     our own, so every delivery of the same event_id returns one identical
 *     response (replay-exact contract, even without a serialize/lease).
 */
async function decideIdempotently(req: DecisionRequest): Promise<DecisionResult> {
  const claimed = await docCardActionReceiptRepo.claim(req.event_id)
  if (!claimed) {
    const stored = await docCardActionReceiptRepo.getResponse(req.event_id)
    if (stored != null) return JSON.parse(stored) as DecisionResult
    // Claimed but not finalized (prior crash or in-flight peer) → re-execute.
    // Safe: computeDecision applies the grant ONLY when its decide() CAS wins, so
    // a concurrent sibling that re-executes here cannot double- or stale-grant —
    // the CAS admits exactly one grantor per request regardless of claim outcome.
  }
  const result = await computeDecision(req)
  const won = await docCardActionReceiptRepo.finalize(req.event_id, JSON.stringify(result))
  if (won) return result
  // A concurrent execution finalized first — return its stored response so all
  // deliveries converge on one identical result. Fall back to our own result
  // only if the row is somehow unreadable (never expected post-finalize).
  const stored = await docCardActionReceiptRepo.getResponse(req.event_id)
  return stored != null ? (JSON.parse(stored) as DecisionResult) : result
}

/** Express handler for POST CARD_ACTION_DECIDE_PATH. Requires an express.raw body. */
export async function cardActionDecideHandler(req: Request, res: Response): Promise<void> {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
  const timestamp = req.header('X-Octo-Timestamp') ?? ''
  const eventId = req.header('X-Octo-Event-ID') ?? ''
  const signature = req.header('X-Octo-Signature') ?? ''
  const nowSeconds = Math.floor(Date.now() / 1000)

  if (
    !verifyOctoSignature(
      rawBody,
      CARD_ACTION_DECIDE_PATH,
      timestamp,
      eventId,
      signature,
      config.notify.cardActionSecret,
      nowSeconds,
    )
  ) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }

  let request: DecisionRequest
  try {
    request = parseDecisionRequest(JSON.parse(rawBody.toString('utf8')))
  } catch {
    res.status(400).json({ error: 'invalid_request' })
    return
  }
  if (request.event_id !== eventId) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }

  try {
    const result = await decideIdempotently(request)
    res.status(200).json(result)
  } catch (err) {
    // Retryable failure — never leak the internal cause to octo-server.
    // eslint-disable-next-line no-console
    console.error('[octo-docs] card-action decide failed', { eventId, err: String(err) })
    res.status(503).json({ error: 'temporarily_unavailable' })
  }
}
