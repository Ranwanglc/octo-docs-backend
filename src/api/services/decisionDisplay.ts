/**
 * Decision card `display` helpers (docs access approve/deny → octo-server).
 *
 * octo-server's registry result card reads `display.operator_name` and
 * `display.decided_at`. When docs-backend omits `operator_name`, octo-server
 * renders localized generic reviewer copy instead — it deliberately never
 * renders the operator UID ("a UID is an internal identifier, not display
 * copy", modules/notify/action_finalizer.go). So supplying these fields upgrades
 * the card from a generic label to the real approver's name and decision time;
 * omitting them is a safe, if less informative, degradation.
 *
 * Kept in its own module so the formatting and the best-effort name resolution
 * are unit-testable without importing the whole callback route (env/repos/etc.).
 */
import { getOctoIdentity } from '../../auth/octoIdentity.js'
import { formatCardTimestamp, formatCardTimestampFromSeconds } from '../../util/cardTime.js'

/**
 * Bound the identity lookup with real headroom. This is awaited inside the
 * signed-callback response path, whose dispatcher deadline is ~3s — and signature
 * verification, several repo reads and the grant are already spent before we get
 * here. A bound set AT the deadline could only ever miss it, so cap this cosmetic
 * lookup at a fraction of it and let the card degrade to the generic label rather
 * than blow the callback.
 */
const OPERATOR_LOOKUP_TIMEOUT_MS = 1200
const MAX_DISPLAY_RUNES = 500

function truncateDisplay(value: string): string {
  return [...value].slice(0, MAX_DISPLAY_RUNES).join('')
}

/**
 * Resolve the operator's display name — bounded and best-effort. Returns '' when
 * the uid is empty, the lookup misses, times out, or throws; the caller then
 * omits `operator_name` and octo-server keeps its generic-label rendering.
 *
 * `callerToken` lets the authenticated REST decision paths resolve the name with
 * the decider's own session token, so they do not depend on `OCTO_SERVER_TOKEN`.
 * The signed-callback path has no session and passes none.
 *
 * A miss is logged once: a silently degrading best-effort path is
 * indistinguishable from a broken deployment (with `OCTO_SERVER_TOKEN` unset and
 * no caller token, `GET /v1/users/:uid` answers 401), which is how the original
 * bug survived.
 */
export async function resolveOperatorName(operatorUid: string, callerToken?: string): Promise<string> {
  if (!operatorUid) return '' // degenerate case: never put `/v1/users/` on the wire
  // AbortSignal.timeout aborts the request itself, so a stalled identity endpoint
  // does not leave an in-flight socket behind after we stop waiting.
  const signal = AbortSignal.timeout(OPERATOR_LOOKUP_TIMEOUT_MS)
  try {
    const operator = await getOctoIdentity().getUser(operatorUid, callerToken, signal)
    const name = operator?.name?.trim() ?? ''
    if (!name) {
      // eslint-disable-next-line no-console
      console.warn('[octo-docs] decision card: operator name lookup miss', {
        operatorUid,
        hint: 'set OCTO_SERVER_TOKEN if approver names should appear on access cards',
      })
    }
    return truncateDisplay(name)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[octo-docs] decision card: operator name lookup failed', {
      operatorUid,
      err: String(err),
    })
    return ''
  }
}

/**
 * Assemble the `display` map for a decision whose time is a unix-SECONDS value —
 * the callback's `acted_at`, stamped server-side by octo-server as
 * `time.Now().Unix()` (10-digit seconds per its published consumer contract).
 *
 * Returns the resolved `operatorName` alongside the map so the caller can reuse
 * it (e.g. for the sibling-card sync) instead of resolving the same uid twice.
 */
export async function buildDecisionDisplay(
  title: string,
  operatorUid: string,
  actedAtSeconds: number,
  callerToken?: string,
): Promise<{ display: Record<string, string>; operatorName: string }> {
  return assembleDisplay(title, operatorUid, formatCardTimestampFromSeconds(actedAtSeconds), callerToken)
}

/**
 * Same as {@link buildDecisionDisplay} but for a PERSISTED decision time (a
 * `Date` from `doc_access_request.updated_at`). Used when a duplicate /
 * concurrent callback must report the ACTUAL decider rather than the late caller.
 */
export async function buildDecisionDisplayAt(
  title: string,
  operatorUid: string,
  decidedAt: Date | null | undefined,
  callerToken?: string,
): Promise<{ display: Record<string, string>; operatorName: string }> {
  const at = decidedAt ? new Date(decidedAt) : null
  return assembleDisplay(title, operatorUid, at ? formatCardTimestamp(at) : '', callerToken)
}

async function assembleDisplay(
  title: string,
  operatorUid: string,
  decidedAtDisplay: string,
  callerToken?: string,
): Promise<{ display: Record<string, string>; operatorName: string }> {
  const display: Record<string, string> = { title: truncateDisplay(title || '文档访问申请') }
  const operatorName = await resolveOperatorName(operatorUid, callerToken)
  if (operatorName) display.operator_name = operatorName
  if (decidedAtDisplay) display.decided_at = decidedAtDisplay
  return { display, operatorName }
}
