/**
 * Invite accept flow (§4.6) — POST /api/v1/docs/invites/{inviteToken}/accept.
 *
 * HARD CONSTRAINT: only registered octo users can accept. Identity is verified
 * (token -> trusted uid) BEFORE touching the DB; doc_member.uid is always a real
 * octo user (never a client-self-reported uid).
 *
 * Single transaction; branches a/b/c/d are exactly the contract's precise
 * idempotency semantics. The doc_invite_redemption PK (invite_token, uid) is
 * the "same person never double-consumes used_count" anchor.
 */
import { transaction } from '../../db/pool.js'
import { getOctoIdentity } from '../../auth/octoIdentity.js'
import { docInviteRepo, INVITE_STATUS_EXPIRED, INVITE_STATUS_EXHAUSTED, INVITE_STATUS_ACTIVE } from '../../db/repos/docInviteRepo.js'
import { docInviteRedemptionRepo } from '../../db/repos/docInviteRedemptionRepo.js'
import { docMemberRepo } from '../../db/repos/docMemberRepo.js'
import { refreshAndPublish } from '../../permission/epoch.js'
import { roleFromNumber, type ResolvedRole } from '../../permission/role.js'
import { decideAcceptBranch } from './acceptDecision.js'


export type AcceptResult =
  | { ok: true; status: 200; body: { docId?: string; documentName?: string; role: string } }
  | { ok: false; status: 401 | 410; error: string }

interface DocMetaTxRow {
  doc_id: string
  document_name: string
  owner_id: string
  status: number
  doc_type: string
}

/**
 * Resolve role inside the transaction (owner => admin, else doc_member row).
 */
async function resolveRoleTx(
  tx: Parameters<Parameters<typeof transaction>[0]>[0],
  meta: DocMetaTxRow,
  uid: string,
): Promise<ResolvedRole> {
  if (uid === meta.owner_id) return 'admin'
  const role = await docMemberRepo.getRoleTx(tx, meta.doc_id, uid)
  return role ?? 'none'
}

export async function acceptInvite(
  octoToken: string,
  inviteToken: string,
  nowMs: number = Date.now(),
): Promise<AcceptResult> {
  // step 1: verify octo identity -> trusted uid (HARD CONSTRAINT). 401 if not.
  const identity = await getOctoIdentity().verifyToken(octoToken)
  if (!identity) return { ok: false, status: 401, error: 'login_required' }
  return acceptInviteForUid(identity.uid, inviteToken, nowMs)
}

/**
 * Accept an invite on behalf of an ALREADY-TRUSTED uid.
 *
 * This is the DB-side transaction, factored out of acceptInvite so a second
 * caller can reuse the exact same idempotency/branch semantics after resolving
 * the uid through a different identity path. The human accept route resolves the
 * uid from an octo session token (see acceptInvite above); the bot accept route
 * resolves it from the bot bearer token via verifyBot, which injects the trusted
 * bot uid on req.uid. Either way the uid reaching here is server-verified — never
 * client-self-reported — so the doc_member row is always a real octo/bot user.
 *
 * Only ever returns 200 (success/idempotent) or 410 (invite invalid/expired/
 * exhausted); the 401 branch belongs to the caller's identity step, which runs
 * before this function.
 */
export async function acceptInviteForUid(
  uid: string,
  inviteToken: string,
  nowMs: number = Date.now(),
): Promise<AcceptResult> {
  // Branches c/d publish an epoch invalidation. Capture its payload in-tx and
  // fire refreshAndPublish AFTER commit (see the call site below); stays null on
  // the branches that make no permission change. A box (not a bare `let`) so the
  // closure assignment is visible to the post-commit read without CFA narrowing.
  const pending: { publish: { documentName: string; epoch: number; uid: string } | null } = {
    publish: null,
  }

  const result = await transaction<AcceptResult>(async (tx) => {
    // step 2: lock invite row.
    const invite = await docInviteRepo.getForUpdateTx(tx, inviteToken)
    if (!invite) return { ok: false, status: 410, error: 'invite_invalid' }

    const redeemed = await docInviteRedemptionRepo.existsTx(tx, inviteToken, uid)

    const inviteRole = roleFromNumber(invite.role)
    if (!inviteRole) return { ok: false, status: 410, error: 'invite_invalid' }

    // step 3: read current state (doc meta + role).
    const metaRows = await tx.query<DocMetaTxRow>(
      'SELECT doc_id, document_name, owner_id, status, doc_type FROM doc_meta WHERE doc_id = ? LIMIT 1',
      [invite.doc_id],
    )
    const meta = metaRows[0]
    const docExists = !!meta && meta.status !== 0

    const curRole = docExists ? await resolveRoleTx(tx, meta!, uid) : 'none'

    // step 2 + step 4 decision (pure).
    const decision = decideAcceptBranch({
      invite: {
        status: invite.status,
        role: inviteRole,
        maxUses: invite.max_uses,
        usedCount: invite.used_count,
        expiresAtMs: invite.expires_at ? new Date(invite.expires_at).getTime() : null,
      },
      curRole,
      redeemed,
      docExists,
      nowMs,
    })

    // Persist the side-effects that correspond to the gate that fired (so the
    // invite's status reflects expiry/exhaustion even on a rejected accept).
    if (decision.kind === 'gone') {
      if (invite.expires_at && new Date(invite.expires_at).getTime() <= nowMs && invite.status === INVITE_STATUS_ACTIVE) {
        await docInviteRepo.setStatusTx(tx, inviteToken, INVITE_STATUS_EXPIRED)
      } else if (
        invite.status === INVITE_STATUS_ACTIVE &&
        invite.max_uses > 0 &&
        invite.used_count >= invite.max_uses &&
        !redeemed
      ) {
        await docInviteRepo.setStatusTx(tx, inviteToken, INVITE_STATUS_EXHAUSTED)
      }
      return { ok: false, status: 410, error: 'invite_invalid' }
    }

    if (decision.kind === 'noop') {
      // branch a/b: no write, no used_count, no epoch change.
      return { ok: true, status: 200, body: { role: decision.role } }
    }

    // branches c (reaccept) and d (first): both write the member + bump epoch.
    await docMemberRepo.upsertFromInviteTx(tx, {
      docId: meta!.doc_id,
      uid,
      roleNum: invite.role,
      grantedBy: invite.created_by,
      inviteToken,
    })
    if (decision.kind === 'first') {
      // branch d only: redemption + used_count++ (with exhaustion guard).
      await docInviteRedemptionRepo.insertTx(tx, inviteToken, uid)
      await docInviteRepo.incrementUsedCountTx(tx, inviteToken)
    }
    await tx.query('UPDATE doc_meta SET permission_epoch = permission_epoch + 1 WHERE doc_id = ?', [meta!.doc_id])
    pending.publish = {
      documentName: meta!.document_name,
      epoch: await readEpochTx(tx, meta!.doc_id),
      uid,
    }
    return {
      ok: true,
      status: 200,
      body: { docId: meta!.doc_id, documentName: meta!.document_name, role: decision.role },
    }
  })

  // Publish the invalidation AFTER the tx commits, matching every other ACL path
  // (softDelete / setShareSettings / members / grantForward all publish
  // post-commit). Publishing pre-commit would announce a permission_epoch bump
  // that a concurrent reader could act on before the row is durably committed,
  // and a rollback would leave a phantom cache-invalidation for a change that
  // never landed. Best-effort: the accept is already committed, so a failure
  // here only misses a cache refresh (the beforeHandleMessage recheck is the
  // correctness backstop).
  if (pending.publish) {
    await refreshAndPublish(pending.publish.documentName, pending.publish.epoch, pending.publish.uid)
  }
  return result
}

/** Read the freshly-bumped epoch inside the tx; the caller publishes post-commit. */
async function readEpochTx(
  tx: Parameters<Parameters<typeof transaction>[0]>[0],
  docId: string,
): Promise<number> {
  const rows = await tx.query<{ permission_epoch: number }>(
    'SELECT permission_epoch FROM doc_meta WHERE doc_id = ? LIMIT 1',
    [docId],
  )
  return Number(rows[0]?.permission_epoch ?? 0)
}
