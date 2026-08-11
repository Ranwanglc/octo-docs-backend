/**
 * Verified-or-skip recent-view write (remove-sp §7.1).
 *
 * Phase-1 decouples the "recent view" side effect from doc opening and stops
 * trusting an unverified viewer Space:
 *
 *   - Human: the write lands ONLY under a viewer Space whose ACTIVE membership
 *     is confirmed server-side (isSpaceMember). A missing header, a Space the
 *     caller is not a member of, or a membership lookup failure => SKIP the
 *     write (the doc still opens / the token is still issued). There is NO
 *     fallback to the document's home Space and NO trust of an arbitrary header.
 *   - Bot: unchanged — the server-resolved Space (verifyBot reverse lookup) is
 *     authoritative, so the write lands under it directly.
 *
 * Best-effort by contract: a write/lookup failure never propagates to the caller
 * (token issuance / open must not fail on a recent-view hiccup). Returns the
 * viewedAt Date when a row was written, or null when the write was skipped.
 */
import { getOctoIdentity } from '../../auth/octoIdentity.js'
import { docViewHistoryRepo } from '../../db/repos/docViewHistoryRepo.js'
import { config } from '../../config/env.js'
import type { DocSpaceScope } from '../middleware/docSpaceScope.js'

export interface RecordRecentViewInput {
  /** Per-mount policy: bot writes under its resolved Space; human must verify. */
  scope: DocSpaceScope
  uid: string
  docId: string
  /** Human only: the UNVERIFIED viewer Space from X-Space-Id (trimmed, optional). */
  viewerSpaceId?: string
  /** Human session token, used to confirm viewer-Space membership. */
  token?: string
}

async function writeRow(uid: string, docId: string, spaceId: string): Promise<Date> {
  return docViewHistoryRepo.upsertViewWithPrune({
    uid,
    docId,
    spaceId,
    retainCount: config.docView.retainCount,
    retainDays: config.docView.retainDays,
  })
}

export async function recordVerifiedRecentView(input: RecordRecentViewInput): Promise<Date | null> {
  const { scope, uid, docId } = input
  try {
    if (scope.mode === 'bot') {
      // Bot Space is server-resolved (anti-spoof); write directly under it.
      return await writeRow(uid, docId, scope.spaceId)
    }
    // Human: only a confirmed active member of the supplied viewer Space may
    // record history there — otherwise skip (no home-Space fallback, §7.1).
    const viewerSpaceId = typeof input.viewerSpaceId === 'string' ? input.viewerSpaceId.trim() : ''
    if (viewerSpaceId === '') return null
    const member = await getOctoIdentity()
      .isSpaceMember(uid, viewerSpaceId, input.token ?? '')
      .catch(() => false)
    if (!member) return null
    return await writeRow(uid, docId, viewerSpaceId)
  } catch {
    // Best-effort: a recent-view write must never fail the open/token path.
    return null
  }
}
