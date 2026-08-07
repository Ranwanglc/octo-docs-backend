/**
 * Bento frame protocol for the B relay (§7.2).
 *
 * The relay preserves Bento's frame semantics EXACTLY — it validates the
 * envelope (protocol version, frame type, role, epoch, op count, payload size)
 * but never reinterprets Bento op semantics or normalizes element ids. Frames
 * mirror Bento's `slides/src/sync/session.ts`: `hello`, `ops`, `need`, `p`,
 * `bye`, `snap`, each carrying a protocol version `pv`.
 *
 * Op whitelist is all five Bento op kinds: `set`, `ins`, `del`, `ord`, `txt`
 * (`txt` is the element-internal text RGA delta). Persisted-op frames (`ops`,
 * `snap`) require writer/admin; the ephemeral frames (`hello`, `need`, `p`,
 * `bye`) are allowed for every role.
 */

/** The five Bento op kinds the relay accepts (§7.2). */
export const OP_KINDS = ['set', 'ins', 'del', 'ord', 'txt'] as const
export type OpKind = (typeof OP_KINDS)[number]
const OP_KIND_SET: ReadonlySet<string> = new Set(OP_KINDS)

/** Client → server frame types. */
export const CLIENT_FRAME_TYPES = ['hello', 'ops', 'need', 'p', 'bye', 'snap'] as const
export type ClientFrameType = (typeof CLIENT_FRAME_TYPES)[number]

/**
 * Refused-frame codes (§7.3). Retry classification: the transient/retryable set is
 * `rate-limited` + `storage-retry` (a transient storage failure — lock-wait
 * timeout / deadlock that outlived the store's retries, or an unconfirmed
 * room-budget seed read; added in XIN-1693 P1-5). Every OTHER code is a permanent
 * refusal the client must surface as unsynced (never silently drop). Both
 * retryable codes carry a bounded `retryInMs` backoff hint: `rate-limited` supplies
 * the window-derived delay, `storage-retry` a small fixed backoff
 * ({@link STORAGE_RETRY_BACKOFF_MS}). See {@link isRetryable}.
 */
export const REFUSED_CODES = [
  'too-large',
  'storage-failed',
  // A TRANSIENT storage failure the client should retry: a lock-wait timeout
  // (ER_LOCK_WAIT_TIMEOUT / 1205) or deadlock (ER_LOCK_DEADLOCK / 1213) that
  // survived the store's internal retries, or a room-budget seed read that could
  // not be confirmed. Distinct from the PERMANENT `storage-failed` so the client
  // re-sends instead of surfacing an unrecoverable unsynced state (XIN-1693 P1-5).
  'storage-retry',
  'room-full',
  'rate-limited',
  'forbidden-role',
  'stale-epoch',
  'protocol-version',
  'snapshot-conflict',
  'doc-deleted',
] as const
export type RefusedCode = (typeof REFUSED_CODES)[number]

/**
 * Transient (retryable) refusals: rate limiting and a transient storage failure
 * (`storage-retry`, e.g. a lock-wait timeout / deadlock that outlived the store's
 * internal retries). Every OTHER code is a PERMANENT refusal the client must
 * surface as unsynced, never silently drop (§7.3 / XIN-1693 P1-5).
 */
export function isRetryable(code: RefusedCode): boolean {
  return code === 'rate-limited' || code === 'storage-retry'
}

/**
 * Bounded backoff hint (ms) attached to every `storage-retry` refusal. A transient
 * storage failure clears on the order of a lock-wait / deadlock retry, so the
 * client is handed a small concrete delay rather than an unbounded busy-retry —
 * mirroring how `rate-limited` always carries a `retryInMs`. The client may apply
 * its own jitter/backoff on top; this is the floor the relay guarantees.
 */
export const STORAGE_RETRY_BACKOFF_MS = 250

/** `frame_id` is persisted into a VARCHAR(64) column (dedup key). */
export const MAX_FRAME_ID_LEN = 64

/** A room sequence / counter field: a non-negative safe integer, never fractional. */
function isSafeSeq(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
}

// ── Client frame shapes ─────────────────────────────────────────────────────

export interface HelloFrame {
  t: 'hello'
  pv: number
  /** Last room sequence the client already has; replay resumes after it. */
  since?: number
}
export interface NeedFrame {
  t: 'need'
  pv: number
  since: number
}
export interface PresenceFrame {
  t: 'p'
  pv: number
  /** Opaque presence payload (cursor/selection); the relay stamps a trusted name. */
  presence?: unknown
}
export interface ByeFrame {
  t: 'bye'
  pv: number
}
export interface OpsFrame {
  t: 'ops'
  pv: number
  /** Client-assigned frame counter, echoed back in the ack (`k`). */
  k: number
  /** Globally-unique frame id for dedup: unique `(docId, frameId)` (§7.3). */
  frameId: string
  /** Permission epoch the client believed it held; checked against live epoch. */
  epoch: number
  ops: unknown[]
}
export interface SnapFrame {
  t: 'snap'
  pv: number
  /** Client-assigned frame counter, echoed back in the ack (`k`). Optional. */
  k?: number
  epoch: number
  /** Room sequence this snapshot covers (ops <= q become prunable). */
  q: number
  /** The authoritative BentoDoc snapshot. */
  doc: unknown
}

export type ClientFrame = HelloFrame | NeedFrame | PresenceFrame | ByeFrame | OpsFrame | SnapFrame

// ── Server control frames ───────────────────────────────────────────────────

export interface ReadyCtl {
  ctl: 'ready'
  /**
   * Highest op sequence the client is synced through after this replay: the last
   * op actually delivered, or the snapshot's covered seq / the resume cursor when
   * no tail op followed. NOT the room's counter high-water — that can exceed what
   * was delivered (e.g. a seq allocated by an append not yet visible), and
   * reporting it would make the client skip an op it never received (XIN-1655 C6).
   * A resume cursor ABOVE the room high-water is REFUSED as a protocol error (it
   * cannot arise legitimately — the counter never regresses), never clamped and
   * endorsed back here (XIN-1693 P2-e).
   *
   * NOTE on GAPS: the delivered op sequence is monotonic but NOT necessarily
   * contiguous. The durable per-room counter allocates a seq inside the append
   * transaction; a rolled-back append (or the P1-1(b) op-dup reconciliation, which
   * burns a freshly-allocated seq and re-acks the op's original one) leaves that
   * seq permanently unused. A client must treat a missing intermediate seq as a
   * legal gap, not a lost op — it never blocks on "waiting for seq N".
   */
  q: number
  snapshotVersion: number
  epoch: number
  role: string
}
export interface AckCtl {
  ctl: 'ack'
  /** Echo of the client's frame counter. */
  k: number
  /** Room sequence assigned to the persisted frame. */
  q: number
  snapshotVersion: number
}
export interface RefusedCtl {
  ctl: 'refused'
  code: RefusedCode
  retryable: boolean
  retryInMs?: number
  /** Echo of the offending frame's `k` / `frameId` when present. */
  k?: number
  frameId?: string
  message?: string
}
export interface RoleChangedCtl {
  ctl: 'role-changed'
  role: string
  epoch: number
}
export interface SnapshotReplayCtl {
  ctl: 'snapshot'
  snapshotVersion: number
  doc: unknown
}
export interface OpReplayCtl {
  ctl: 'op'
  q: number
  /** The original persisted `ops` frame, replayed verbatim. */
  frame: unknown
}
export interface PresenceBroadcastCtl {
  ctl: 'presence'
  uid: string
  /** Server-trusted display name (never the client-supplied one). */
  name?: string
  presence?: unknown
}

export type ServerFrame =
  | ReadyCtl
  | AckCtl
  | RefusedCtl
  | RoleChangedCtl
  | SnapshotReplayCtl
  | OpReplayCtl
  | PresenceBroadcastCtl

/**
 * Parse + shape-validate a raw client frame. Returns the typed frame, or a
 * refusal code when the envelope is invalid. A missing/incompatible `pv` is
 * `protocol-version` (the relay must not attempt to decode or persist it, §7.2).
 * Unknown/malformed frames are `protocol-version` too — the relay speaks exactly
 * one protocol and treats anything off-contract as a version mismatch rather
 * than guessing.
 */
export type FrameParseResult =
  | { ok: true; frame: ClientFrame }
  | { ok: false; code: RefusedCode; k?: number; frameId?: string; message: string }

export function parseClientFrame(raw: unknown, expectedPv: number): FrameParseResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, code: 'protocol-version', message: 'frame must be a JSON object' }
  }
  const f = raw as Record<string, unknown>
  const k = typeof f.k === 'number' ? f.k : undefined
  const frameId = typeof f.frameId === 'string' ? f.frameId : undefined

  // Protocol version is checked FIRST, before any type-specific decode.
  if (typeof f.pv !== 'number' || f.pv !== expectedPv) {
    return { ok: false, code: 'protocol-version', k, frameId, message: `expected pv=${expectedPv}` }
  }
  const t = f.t
  if (typeof t !== 'string' || !CLIENT_FRAME_TYPES.includes(t as ClientFrameType)) {
    return { ok: false, code: 'protocol-version', k, frameId, message: 'unknown frame type' }
  }
  // frameId is persisted into a VARCHAR(64) dedup column. A longer value would
  // raise ER_DATA_TOO_LONG (1406) at insert time and surface as a PERMANENT
  // `storage-failed` rather than an up-front protocol refusal — cap it here so an
  // over-length frameId is rejected on the wire (XIN-1693 Batch 1).
  if (frameId !== undefined && frameId.length > MAX_FRAME_ID_LEN) {
    return { ok: false, code: 'protocol-version', k, frameId: undefined, message: `frameId exceeds ${MAX_FRAME_ID_LEN} chars` }
  }
  // The numeric envelope fields are room sequences / counters — never fractional.
  // A fractional/NaN/±Infinity/unsafe value (e.g. `snap.q=4.5`) would otherwise
  // pass the relay's `typeof === 'number'` guards, be silently rounded by the
  // BIGINT columns, and prune a co-editor's committed op the snapshot never
  // covered (P0-1). Require `Number.isSafeInteger` for `k`, `since`, `q`, and
  // `epoch` up front and refuse anything else as a protocol error.
  if (f.k !== undefined && !Number.isSafeInteger(f.k)) {
    return { ok: false, code: 'protocol-version', k, frameId, message: 'k must be an integer' }
  }
  switch (t as ClientFrameType) {
    case 'hello':
      if (f.since !== undefined && !isSafeSeq(f.since)) {
        return { ok: false, code: 'protocol-version', k, frameId, message: 'since must be a non-negative integer' }
      }
      break
    case 'need':
      if (!isSafeSeq(f.since)) {
        return { ok: false, code: 'protocol-version', k, frameId, message: 'need requires a non-negative integer since' }
      }
      break
    case 'ops':
      if (f.epoch !== undefined && !Number.isSafeInteger(f.epoch)) {
        return { ok: false, code: 'protocol-version', k, frameId, message: 'epoch must be an integer' }
      }
      break
    case 'snap':
      if (!isSafeSeq(f.q)) {
        return { ok: false, code: 'protocol-version', k, frameId, message: 'snap q must be a non-negative integer' }
      }
      if (f.epoch !== undefined && !Number.isSafeInteger(f.epoch)) {
        return { ok: false, code: 'protocol-version', k, frameId, message: 'epoch must be an integer' }
      }
      break
  }
  return { ok: true, frame: f as unknown as ClientFrame }
}

/** True when every entry in `ops` is a well-formed op with a whitelisted kind. */
export function opsAreValid(ops: unknown): ops is unknown[] {
  if (!Array.isArray(ops)) return false
  for (const op of ops) {
    if (typeof op !== 'object' || op === null) return false
    const kind = (op as Record<string, unknown>).kind
    if (typeof kind !== 'string' || !OP_KIND_SET.has(kind)) return false
  }
  return true
}
