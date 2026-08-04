/**
 * Access-request routes (§4.3, screen 4c — "request access" MVP, pull-based).
 *
 *   POST /api/v1/docs/{docId}/access-requests                    submit (any octo login)
 *   GET  /api/v1/docs/{docId}/access-requests?status=pending     list  (needs admin)
 *   POST /api/v1/docs/{docId}/access-requests/{requestId}/approve approve (needs admin)
 *   POST /api/v1/docs/{docId}/access-requests/{requestId}/deny    deny    (needs admin)
 *
 * Approval reuses the SAME max-merge grant path as forward-grant
 * (grantForwardAccess: only-up, epoch bump, owner/admin skip). Denial leaves the
 * requester forbidden.
 *
 * NOTE (§4.2 / scope item 6): the pending list stays PULL-based (admins fetch it
 * in the manage-members panel). The second-phase ACTIVE push to owner+admin is
 * now implemented as a best-effort side effect of submit: a docs-notify card is
 * sent via octo-server's internal notify API (see services/docsNotify.ts). It is
 * fire-and-forget and gated on config — if OCTO_DOCS_NOTIFY_TOKEN is unset it is a
 * silent no-op, and any send failure never affects the submit response.
 */
import { Router, type Router as ExpressRouter, type Request, type Response } from 'express'
import { docMetaRepo } from '../../db/repos/docMetaRepo.js'
import {
  docAccessRequestRepo,
  REQUEST_STATUS_PENDING,
  REQUEST_STATUS_APPROVED,
  REQUEST_STATUS_DENIED,
} from '../../db/repos/docAccessRequestRepo.js'
import { requireDocRole, requireSameSpace } from '../guard.js'
import { resolveRole } from '../../permission/resolveRole.js'
import { grantRequestWithBots, botGrantSummary } from '../services/grantRequestWithBots.js'
import { getOctoIdentity } from '../../auth/octoIdentity.js'
import { parseRequestBotUids, BotUidsValidationError } from '../../util/botUids.js'
import { notifyDocAccessRequested } from '../services/docsNotify.js'
import { syncDecisionCards } from '../services/docsDecisionCardSync.js'
import { isAccessRequestRole, roleAtLeast, roleToNumber, roleFromNumber } from '../../permission/role.js'


export const accessRequestsRouter: ExpressRouter = Router()

const roleName = (n: number): 'reader' | 'commenter' | 'writer' => {
  const role = roleFromNumber(n)
  if (!isAccessRequestRole(role)) throw new Error(`invalid requested_role ${n}`)
  return role
}

type AccessRequestRole = 'reader' | 'commenter' | 'writer'

/**
 * The decider's own session token, when this request carries one. The REST
 * decision paths are authenticated, so the approver name can resolve with the
 * caller's token instead of depending on OCTO_SERVER_TOKEN. Read defensively:
 * this feeds a fire-and-forget display detail, and it must never be the reason a
 * decision response fails.
 */
function callerSessionToken(req: Request): string | undefined {
  const header = typeof req.header === 'function' ? req.header('token') : undefined
  return header && header !== '' ? header : undefined
}

/**
 * POST submit — any authenticated octo user (no doc role required). Idempotent
 * by (doc_id, uid). If the caller already holds >= the requested role and no
 * bots are requested, returns 200 already_granted without writing a row.
 */
accessRequestsRouter.post('/:docId/access-requests', async (req: Request, res: Response) => {
  const docId = req.params.docId!
  const meta = await docMetaRepo.getByDocId(docId)
  if (!meta || meta.status === 0) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  // Space-scope gate (P2): a doc in another space must be indistinguishable
  // from a missing one, so a cross-space hit returns 404 BEFORE any status
  // branch. This submit route is the only one in the router that skips
  // requireDocRole (submit needs no doc role), so without this check a caller
  // whose server-resolved space is A could probe or write an access-request row
  // against a doc in space B — a cross-space existence/state oracle plus a
  // cross-space write. Reusing the shared guard helper keeps this identical to
  // the role-guarded routes and hardens both the human and bot mounts at once.
  if (!requireSameSpace(res, meta, req.spaceId!)) {
    return
  }
  if (meta.status === 2) {
    res.status(409).json({ error: 'conflict' })
    return
  }

  const suppliedRole = (req.body ?? {}).requestedRole
  const requestedRole = suppliedRole === undefined ? 'reader' : suppliedRole
  if (!isAccessRequestRole(requestedRole)) {
    res.status(400).json({ error: 'requestedRole must be reader|commenter|writer' })
    return
  }

  const reasonRaw = (req.body ?? {}).reason
  const reason = typeof reasonRaw === 'string' ? reasonRaw.slice(0, 512) : ''

  // Strict-parse the optional Space-bot snapshot: omitted => []; otherwise it
  // MUST be an array of trimmed, non-empty, ≤64-char, non-duplicate uids, total
  // ≤50 — any violation is a 400 (never a silent drop/truncate). The owned-set
  // subset gate runs later, only if the caller is not already privileged.
  let requestedBotUids: string[]
  try {
    requestedBotUids = parseRequestBotUids((req.body ?? {}).botUids)
  } catch (err) {
    if (err instanceof BotUidsValidationError) {
      res.status(400).json({ error: err.message })
      return
    }
    throw err
  }

  // Preserve the legacy no-op only for human-only requests. A bot-bearing
  // request must remain pending so an admin explicitly approves the bot grants.
  const current = await resolveRole(req.uid!, docId)
  if (requestedBotUids.length === 0 && roleAtLeast(current, requestedRole)) {
    res.status(200).json({ status: 'already_granted', role: current })
    return
  }

  // Admit ONLY bots the caller actually owns in THIS doc's Space —
  // octo-server's owned_bots_by_space[doc.space_id], resolved from the caller's
  // own session token (never client-supplied, never a third party's bots).
  // FAIL-CLOSED: a bot mount (no session token) or unresolvable context yields
  // an empty owned set, so any submitted bot is rejected (403).
  let botUids: string[] = []
  if (requestedBotUids.length > 0) {
    const owned = new Set(
      await getOctoIdentity().ownedBotsInSpace(req.uid!, meta.space_id, req.octoToken ?? ''),
    )
    const rejected = requestedBotUids.filter((b) => !owned.has(b))
    if (rejected.length > 0) {
      // Any bot the caller does not own here is a hard 403, not a silent narrow:
      // failing loudly keeps the boundary auditable. A transport failure
      // (owned=[]) also lands here rather than authorizing anything.
      res.status(403).json({ error: 'bot_not_owned_in_space', botUids: rejected })
      return
    }
    botUids = requestedBotUids
  }

  const out = await docAccessRequestRepo.submit({
    docId,
    uid: req.uid!,
    requestedRoleNum: roleToNumber(requestedRole),
    reason,
    botUids,
  })

  // Best-effort second-phase push: notify owner+admins with a docs-notify card
  // via octo-server's internal notify API. Fire-and-forget — never blocks or
  // fails the 201 (notifyDocAccessRequested swallows all errors internally); the
  // pending list is the source of truth.
  void notifyDocAccessRequested({
    docId,
    requestId: out.requestId,
    spaceId: meta.space_id,
    ownerId: meta.owner_id,
    title: meta.title,
    requesterUid: req.uid!,
    reason,
    botUids,
  }).catch(() => {})

  res.status(201).json({ requestId: out.requestId, status: 'pending' })
})

/** GET list requests by status (needs admin; default pending). */
accessRequestsRouter.get('/:docId/access-requests', async (req: Request, res: Response) => {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'admin', { isBot: req.botToken !== undefined })
  if (!guard) return
  const statusParam = req.query.status
  const statusNum =
    statusParam === 'approved'
      ? REQUEST_STATUS_APPROVED
      : statusParam === 'denied'
        ? REQUEST_STATUS_DENIED
        : REQUEST_STATUS_PENDING
  const items = await docAccessRequestRepo.listByStatus(req.params.docId!, statusNum)
  res.status(200).json({
    items: items.map((r) => ({
      requestId: r.request_id,
      uid: r.uid,
      requestedRole: roleName(Number(r.requested_role)),
      reason: r.reason,
      botUids: r.bot_uids,
      createdAt: r.created_at,
    })),
  })
})

/**
 * POST approve (needs admin). Consumes the pending request FIRST, then grants
 * the chosen role via the shared max-merge path (only-up + epoch bump +
 * owner/admin skip).
 *
 * The decide() -> grant order is load-bearing: decide() carries the only
 * `WHERE status = pending` guard and reports whether it actually transitioned a
 * row. Granting only when decide() returns true means a replayed, double-
 * submitted, or already-decided request (denied OR approved) can never授权 —
 * a denial is never silently overwritten and an approval is never double-
 * granted. A non-pending request is a 409 (already decided) with no grant.
 */
accessRequestsRouter.post(
  '/:docId/access-requests/:requestId/approve',
  async (req: Request, res: Response) => {
    const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'admin', { isBot: req.botToken !== undefined })
    if (!guard) return
    const request = await docAccessRequestRepo.getByRequestId(req.params.docId!, req.params.requestId!)
    if (!request) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    // Omitted role approves the requested tier; an explicit invalid tier fails closed.
    const suppliedRole = (req.body ?? {}).role
    let grantRole: AccessRequestRole
    if (suppliedRole === undefined) {
      grantRole = roleName(Number(request.requested_role))
    } else if (isAccessRequestRole(suppliedRole)) {
      grantRole = suppliedRole
    } else {
      res.status(400).json({ error: 'role must be reader|commenter|writer' })
      return
    }


    // Transition pending -> approved first; grant only on a genuine transition.
    const decided = await docAccessRequestRepo.decide({
      docId: req.params.docId!,
      requestId: req.params.requestId!,
      status: REQUEST_STATUS_APPROVED,
      decidedBy: req.uid!,
    })
    if (!decided) {
      // Already denied / approved / cancelled (or lost a concurrent race):
      // the request is no longer pending, so we grant nothing.
      res.status(409).json({ error: 'not_pending' })
      return
    }

    const result = await grantRequestWithBots({
      docId: guard.meta.doc_id,
      documentName: guard.meta.document_name,
      uid: request.uid,
      roleNum: roleToNumber(grantRole),
      grantedBy: req.uid!,
      // Stored, already-admissible snapshot from submit time; re-normalized
      // fail-closed by the repo read path so a corrupt DB value grants no bot.
      botUids: request.bot_uids,
    })
    const hadBots = (request.bot_uids?.length ?? 0) > 0
    // Best-effort sibling-card sync. REST path has no card-callback finalizer, so
    // the decider (req.uid) holds a live card and is terminalized here too
    // (deciderCardHandledExternally omitted). Surface the bot outcome as visible
    // card text so a partial failure is seen, not just returned.
    void syncDecisionCards({
      requestId: req.params.requestId!,
      spaceId: guard.meta.space_id,
      docId: guard.meta.doc_id,
      title: guard.meta.title,
      deciderUid: req.uid!,
      denied: false,
      botSummary: hadBots ? botGrantSummary(result.botsSucceeded, result.botsFailed) : undefined,
      callerToken: callerSessionToken(req),
      decidedAtSeconds: Math.floor(Date.now() / 1000),
    }).catch(() => {})
    // Response shape (per scheme): zero-bot requests keep the legacy { ok, role }
    // byte-for-byte (no empty field). Only when the request carried bots do we add
    // botGrantResult, with failures itemized as { uid, reason:'grant_failed' }.
    res.status(200).json({
      ok: true,
      role: result.requesterRole,
      ...(hadBots
        ? {
            botGrantResult: {
              succeeded: result.botsSucceeded,
              failed: result.botsFailed.map((uid) => ({ uid, reason: 'grant_failed' as const })),
            },
          }
        : {}),
    })
  },
)

/**
 * POST deny (needs admin). Marks the request denied; requester stays forbidden.
 * Gated on a genuine pending -> denied transition (same范式 as approve): if the
 * request is unknown -> 404, and if it is no longer pending (already approved /
 * denied / cancelled, or lost a concurrent race) decide() reports no row and we
 * return 409 not_pending instead of a false ok:true.
 */
accessRequestsRouter.post(
  '/:docId/access-requests/:requestId/deny',
  async (req: Request, res: Response) => {
    const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'admin', { isBot: req.botToken !== undefined })
    if (!guard) return
    const request = await docAccessRequestRepo.getByRequestId(req.params.docId!, req.params.requestId!)
    if (!request) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    // Mirror approve: decide() carries the only WHERE status=pending guard and
    // reports whether it actually transitioned a row. Only report ok when a
    // genuine pending -> denied transition happened; a replayed / already-decided
    // (approved OR denied) request is a 409, never a false success.
    const decided = await docAccessRequestRepo.decide({
      docId: req.params.docId!,
      requestId: req.params.requestId!,
      status: REQUEST_STATUS_DENIED,
      decidedBy: req.uid!,
    })
    if (!decided) {
      res.status(409).json({ error: 'not_pending' })
      return
    }
    // Drive every approver's sibling card to terminal (task
    // docs-access-decision-card-sync). Best-effort. This is the REST path (no
    // card-callback finalizer), so the decider (req.uid) is an approver holding a
    // live card and must be terminalized too — deciderCardHandledExternally
    // omitted (false). The REST deny carries no reviewer reason, so the terminal
    // card omits it (same as a reasonless card deny).
    void syncDecisionCards({
      requestId: req.params.requestId!,
      spaceId: guard.meta.space_id,
      docId: guard.meta.doc_id,
      title: guard.meta.title,
      deciderUid: req.uid!,
      denied: true,
      callerToken: callerSessionToken(req),
      decidedAtSeconds: Math.floor(Date.now() / 1000),
    }).catch(() => {})
    res.status(200).json({ ok: true })
  },
)
