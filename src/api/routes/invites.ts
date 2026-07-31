/**
 * Link invite routes (§8.4 / §4.6, doc_invite).
 *   POST   /api/v1/docs/{docId}/invites                (needs admin)
 *   GET    /api/v1/docs/{docId}/invites                (needs admin)
 *   DELETE /api/v1/docs/{docId}/invites/{inviteToken}  (needs admin)
 *   POST   /api/v1/docs/invites/{inviteToken}/accept   (octo login; §4.6 flow)
 */
import { Router, type Router as ExpressRouter, type Request, type Response } from 'express'
import { docInviteRepo } from '../../db/repos/docInviteRepo.js'
import { requireDocRole } from '../guard.js'
import { newInviteToken } from '../../util/ids.js'
import { roleToNumber, roleFromNumber, type Role } from '../../permission/role.js'
import { acceptInvite, acceptInviteForUid } from '../services/acceptInvite.js'
import { extractOctoToken } from '../middleware/auth.js'
import { HTML_DOC_TYPE } from '../../db/docType.js'

export const invitesRouter: ExpressRouter = Router()

// Canonical stored-number -> role name (shared serializer; covers commenter=4).
// Stored value != rank ordinal, so never open-code the mapping per-file.
const roleName = (n: number): string => {
  const role = roleFromNumber(n)
  if (!role) throw new Error(`invalid invite role ${n}`)
  return role
}

function parseRole(v: unknown): Role | null {
  if (v === undefined) return 'writer'
  return v === 'reader' || v === 'commenter' || v === 'writer' || v === 'admin' ? v : null
}

const DEFAULT_EXPIRES_IN_DAYS = 3
const MIN_EXPIRES_IN_DAYS = 1
const MAX_EXPIRES_IN_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Resolve the policy-enforced lifetime (in days) from the request input.
 * Missing/invalid → default 3; otherwise clamp to [1, 7] (silent, never 400).
 */
function resolveExpiresInDays(v: unknown): number {
  if (!Number.isInteger(v)) return DEFAULT_EXPIRES_IN_DAYS
  return Math.min(MAX_EXPIRES_IN_DAYS, Math.max(MIN_EXPIRES_IN_DAYS, v as number))
}

/** POST create invite (needs admin). */
invitesRouter.post('/:docId/invites', async (req: Request, res: Response) => {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'admin', { isBot: req.botToken !== undefined })
  if (!guard) return
  const { role, expiresInDays, maxUses } = req.body ?? {}
  const roleVal = parseRole(role)
  if (!roleVal) {
    res.status(400).json({ error: 'role must be reader|commenter|writer|admin' })
    return
  }
  if (roleVal === 'commenter' && guard.meta.doc_type !== HTML_DOC_TYPE) {
    res.status(409).json({ error: 'unsupported_doc_type' })
    return
  }
  const maxUsesNum = Number.isInteger(maxUses) && maxUses >= 0 ? Number(maxUses) : 0
  // Backend-enforced lifetime: always a real Date (never a permanent NULL link).
  const days = resolveExpiresInDays(expiresInDays)
  const expires = new Date(Date.now() + days * DAY_MS)
  const inviteToken = newInviteToken()
  await docInviteRepo.create({
    inviteToken,
    docId: req.params.docId!,
    roleNum: roleToNumber(roleVal),
    maxUses: maxUsesNum,
    expiresAt: expires,
    createdBy: req.uid!,
  })
  // The share link is built by the frontend from its own origin. The backend
  // returns only the token + role + computed expiry (never a Host-derived URL).
  res.status(201).json({
    inviteToken,
    role: roleVal,
    expiresAt: expires.toISOString(),
  })
})

/** GET list active invites (needs admin). */
invitesRouter.get('/:docId/invites', async (req: Request, res: Response) => {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'admin', { isBot: req.botToken !== undefined })
  if (!guard) return
  const invites = await docInviteRepo.listActive(req.params.docId!)
  res.status(200).json({
    items: invites.map((i) => ({
      inviteToken: i.invite_token,
      role: roleName(Number(i.role)),
      maxUses: i.max_uses,
      usedCount: i.used_count,
      expiresAt: i.expires_at,
    })),
  })
})

/** DELETE revoke invite (needs admin). */
invitesRouter.delete('/:docId/invites/:inviteToken', async (req: Request, res: Response) => {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'admin', { isBot: req.botToken !== undefined })
  if (!guard) return
  const invite = await docInviteRepo.get(req.params.inviteToken!)
  if (!invite || invite.doc_id !== req.params.docId!) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  await docInviteRepo.revoke(req.params.inviteToken!)
  res.status(200).json({ ok: true })
})

/**
 * POST accept (§4.6). Requires octo login (not the doc admin). Exported as a
 * SEPARATE router so it can be mounted BEFORE authMiddleware (it returns its
 * own 401 login_required; the accept service verifies identity itself).
 */
export const acceptInviteRouter: ExpressRouter = Router()

acceptInviteRouter.post('/invites/:inviteToken/accept', async (req: Request, res: Response) => {
  const octoToken = extractOctoToken(req)
  const out = await acceptInvite(octoToken, req.params.inviteToken!)
  if (!out.ok) {
    res.status(out.status).json({ error: out.error })
    return
  }
  res.status(200).json(out.body)
})

/**
 * POST accept — bot path (§ v4.3, docs #61). Mounted on the bot chain behind
 * verifyBot, which resolves the bot bearer token to a trusted bot uid and
 * injects it on req.uid. This handler reuses the SAME accept transaction as the
 * human route via acceptInviteForUid, so the doc_member row (role/source=invite)
 * and the invite idempotency/expiry semantics are identical — only the identity
 * source differs. Exported as its own router so it is mounted ONLY on the bot
 * chain (the human `/api/v1/docs` mount is untouched). Invite validity (invalid/
 * expired/exhausted -> 410) applies to the bot exactly as to a human; an invalid
 * bot token is already rejected upstream by verifyBot (401).
 */
export const botAcceptInviteRouter = Router()

botAcceptInviteRouter.post('/invites/:inviteToken/accept', async (req: Request, res: Response) => {
  const out = await acceptInviteForUid(req.uid!, req.params.inviteToken!)
  if (!out.ok) {
    res.status(out.status).json({ error: out.error })
    return
  }
  res.status(200).json(out.body)
})
