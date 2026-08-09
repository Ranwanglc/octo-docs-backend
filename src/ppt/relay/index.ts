/**
 * Production wiring for the PPT relay (R4-B1).
 *
 * Composes the relay's default dependencies: the MySQL-backed durable store, a
 * Redis-backed single-use ticket store (so the ticket contract holds across relay
 * nodes), the authoritative permission-epoch reader (Redis cache -> DB fallback),
 * a share-aware role re-resolver for downgrade enforcement, and the doc-liveness
 * guard. The relay itself is transport-agnostic; {@link PptRelay.attach} binds it
 * to B's existing REST HTTP server on the `/api/v1/ppt/collab` upgrade path — no
 * second service.
 */
import { PptRelay } from './pptRelay.js'
import { DbPptRelayStore } from './dbStore.js'
import type { AgedOpDrop } from './snapshotter.js'
import { RedisTicketStore } from '../../auth/pptCollabToken.js'
import { currentEpoch } from '../../permission/epoch.js'
import { recheckCurrentRole } from '../../permission/resolveRole.js'
import { docMetaRepo } from '../../db/repos/docMetaRepo.js'
import { pptDocStateRepo } from '../../db/repos/pptDocStateRepo.js'

/**
 * Production escalation for an aged-out op (XIN-1807 P1-2). The snapshotter drops a
 * permanently-buffered op ONLY to unfreeze GC, and the drop can diverge the server from
 * live peers if a FUTURE durable op would have filled it — a data-integrity event with
 * no other in-band signal. The default handler is a bare `console.warn`; production must
 * do better, so this emits a STRUCTURED, machine-parseable `console.error` (a stable
 * `event` tag + the dropped `(actor, s)` identities) at ERROR severity, so a
 * log-based alert can fire on `ppt_relay_aged_op_drop` and the dropped pairs are on the
 * record for reconciliation. It stays storage-agnostic (no audit-table dependency wired
 * here); a deployment that wants durable reconciliation persists the `dropped` array
 * from this same hook. The snapshotter swallows a throw from here, so an emit failure
 * can never abort GC — but this path only formats + logs and does not throw.
 *
 * OPERATOR OBLIGATION: alert on this event and reconcile the dropped ops; see
 * `docs/DEPLOYMENT.md`.
 */
export function productionAgedOpDropHandler(event: {
  docId: string
  targetSeq: number
  bufferedLag: number
  lagCap: number
  trigger: 'seq-lag' | 'byte-budget'
  dropped: AgedOpDrop[]
}): void {
  // eslint-disable-next-line no-console
  console.error(
    '[ppt-relay] aged-op drop (data-integrity divergence risk; alert + reconcile) ' +
      JSON.stringify({
        event: 'ppt_relay_aged_op_drop',
        docId: event.docId,
        targetSeq: event.targetSeq,
        bufferedLag: event.bufferedLag,
        lagCap: event.lagCap,
        trigger: event.trigger,
        droppedCount: event.dropped.length,
        dropped: event.dropped,
      }),
  )
}

/** Build the production relay wired to DB/Redis-backed dependencies. */
export function createPptRelay(): PptRelay {
  return new PptRelay({
    store: new DbPptRelayStore(),
    // Single-use tickets must be single-use across the whole relay fleet, not
    // just within one process — wire the shared Redis store.
    ticketStore: new RedisTicketStore(),
    epochProvider: (documentName) => currentEpoch(documentName),
    // Downgrade enforcement re-resolves the EFFECTIVE role the same way issuance
    // did (`recheckCurrentRole` = max(direct, share-derived)), folding in an
    // `anyone_in_space` share grant via the token-carried `space_member` claim —
    // so this seam never disagrees with issuance and wrongly revokes a legitimate
    // share writer. It reads share settings FRESH from the doc row, so a scope
    // narrowing still tightens immediately, and returns 'none' for a
    // missing/soft-deleted doc or a removed member (fail-closed).
    roleProvider: (ctx) => recheckCurrentRole(ctx.documentName, ctx.uid, ctx.spaceMember),
    docStatusProvider: async (docId) => {
      const meta = await docMetaRepo.getByDocId(docId)
      // status 0 = soft-deleted, 2 = archived (both refused by pptDocGuard, the
      // REST write path). Treat BOTH as not-writable/readable through the relay so
      // an archived deck cannot be live-edited via the WS path while the REST path
      // returns 409/404 for it — archiving bumps no epoch, so this is the guard
      // (XIN-1693 P2-f). Any other status is live.
      return meta && meta.status !== 0 && meta.status !== 2 ? 'live' : 'deleted'
    },
    // Genesis-deck source for the server-side snapshotter's FIRST reduction, before
    // any durable snapshot exists (XIN-1759 Part B): the materialized starter deck
    // persisted at create time (`ppt_doc_state.draft_doc`). Once the snapshotter has
    // produced a snapshot it reduces onto that instead. Null (no row) degrades safely
    // — the room simply keeps its op log until a base deck is available.
    baseDocProvider: async (docId) => (await pptDocStateRepo.getSource(docId))?.draftDoc ?? null,
    // Escalate an aged-out op to the operational channel (XIN-1807 P1-2): structured
    // ERROR log keyed on `ppt_relay_aged_op_drop` with the dropped `(actor,s)` pairs, so
    // a silent server↔peer divergence is alertable + reconcilable instead of only a
    // `console.warn`. See `productionAgedOpDropHandler` and the operator obligation in
    // `docs/DEPLOYMENT.md`.
    onAgedOpDrop: productionAgedOpDropHandler,
  })
}
