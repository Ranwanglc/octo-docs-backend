/**
 * Member management routes (§8.4, doc_member; needs admin).
 *   GET    /api/v1/docs/{docId}/members
 *   PUT    /api/v1/docs/{docId}/members           (direct add/upsert by uid)
 *   DELETE /api/v1/docs/{docId}/members/{uid}
 */
import { Router, type Router as ExpressRouter, type Request, type Response } from 'express'
import { docMemberRepo } from '../../db/repos/docMemberRepo.js'
import { requireDocRole } from '../guard.js'
import { bumpEpoch } from '../../permission/epoch.js'
import { getOctoIdentity } from '../../auth/octoIdentity.js'
import { isMemberRole, roleToNumber, roleFromNumber, type Role } from '../../permission/role.js'
import { HTML_DOC_TYPE } from '../../db/docType.js'

export const membersRouter: ExpressRouter = Router()

// Canonical stored-number -> role name (covers commenter=4; stored value != rank
// ordinal, so use the shared map rather than a hand-rolled ternary). Falls back
// to 'reader' only for an unknown/corrupt stored value.
const roleName = (n: number): string => {
  const role = roleFromNumber(n)
  if (!role) throw new Error(`invalid member role ${n}`)
  return role
}

function parseRole(v: unknown): Role | null {
  return isMemberRole(v) ? v : null
}

/** GET members (needs admin). */
membersRouter.get('/:docId/members', async (req: Request, res: Response) => {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'admin', { isBot: req.botToken !== undefined })
  if (!guard) return
  const ownerId = guard.meta.owner_id
  const members = await docMemberRepo.list(req.params.docId!)
  // The owner is an implicit admin and intentionally has NO doc_member row
  // (§4.2 owner => admin; DELETE owner_cannot_be_removed). A plain doc_member
  // listing therefore omits it, even though `docs get` reports it as ownerId —
  // an inconsistency between the two reads. Surface the owner explicitly as a
  // synthesized item so `members list` and `docs get` agree on owner
  // visibility. This is display-only: no doc_member row is written, so the
  // implicit-owner semantics above stay intact. doc and sheet share this
  // endpoint, so both gain the owner row identically.
  const directMembers = members
    // Dedup: if a doc_member row for the owner also exists (e.g. a historical
    // PUT that upserted the owner), drop it so the owner appears exactly once,
    // always as admin (owner is not downgradable), never as a duplicate row.
    .filter((m) => m.uid !== ownerId)
    .map((m) => ({
      uid: m.uid,
      role: roleName(Number(m.role)),
      source: m.source === 2 ? 'invite' : 'direct',
      grantedBy: m.granted_by,
    }))
  res.status(200).json({
    items: [{ uid: ownerId, role: 'admin', source: 'owner', grantedBy: null }, ...directMembers],
  })
})

/**
 * PUT members — direct add / change role (upsert by uid; needs admin).
 * MUST first verify the target uid is a real octo user (§8.4 / §4.6 fix):
 * non-existent uid => 404 user_not_found (no ghost member written).
 */
membersRouter.put('/:docId/members', async (req: Request, res: Response) => {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'admin', { isBot: req.botToken !== undefined })
  if (!guard) return
  const { uid, role } = req.body ?? {}
  if (typeof uid !== 'string' || uid === '') {
    res.status(400).json({ error: 'uid required' })
    return
  }
  const parsedRole = parseRole(role)
  if (!parsedRole) {
    res.status(400).json({ error: 'role must be reader|commenter|writer|admin' })
    return
  }
  if (parsedRole === 'commenter' && guard.meta.doc_type !== HTML_DOC_TYPE) {
    res.status(409).json({ error: 'unsupported_doc_type' })
    return
  }
  // verify target uid exists in octo (anti ghost-member). On the bot mount
  // (req.botToken set by verifyBot) resolve with the bot's own token via the
  // bot user-info route; on the human path resolve with the caller/service
  // token via GET /v1/users/:uid. Either way a miss => 404 user_not_found.
  const user = req.botToken
    ? await getOctoIdentity().getUserAsBot(uid, req.botToken)
    : await getOctoIdentity().getUser(uid, req.octoToken)
  if (!user) {
    res.status(404).json({ error: 'user_not_found' })
    return
  }
  await docMemberRepo.upsertDirect({
    docId: req.params.docId!,
    uid,
    roleNum: roleToNumber(parsedRole),
    grantedBy: req.uid!,
  })
  // doc_member change => epoch +1 + broadcast invalidation (§4.5).
  await bumpEpoch(guard.meta.doc_id, guard.meta.document_name, uid)
  res.status(200).json({ ok: true })
})

/** DELETE member (needs admin); owner cannot be removed (§4.5). */
membersRouter.delete('/:docId/members/:uid', async (req: Request, res: Response) => {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'admin', { isBot: req.botToken !== undefined })
  if (!guard) return
  const targetUid = req.params.uid!
  if (targetUid === guard.meta.owner_id) {
    res.status(403).json({ error: 'owner_cannot_be_removed' })
    return
  }
  await docMemberRepo.remove(req.params.docId!, targetUid)
  await bumpEpoch(guard.meta.doc_id, guard.meta.document_name, targetUid)
  res.status(200).json({ ok: true })
})
