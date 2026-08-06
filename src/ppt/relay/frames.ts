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
 * Refused-frame codes (§7.3). Retry classification is fixed: ONLY `rate-limited`
 * is transient/retryable; every other code is a permanent refusal the client
 * must surface as unsynced (never silently drop). See {@link isRetryable}.
 */
export const REFUSED_CODES = [
  'too-large',
  'storage-failed',
  'room-full',
  'rate-limited',
  'forbidden-role',
  'stale-epoch',
  'protocol-version',
  'snapshot-conflict',
  'doc-deleted',
] as const
export type RefusedCode = (typeof REFUSED_CODES)[number]

/** Only rate limiting is transient; all other refusals are permanent (§7.3). */
export function isRetryable(code: RefusedCode): boolean {
  return code === 'rate-limited'
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
   * The resume cursor is client-supplied, so it is CLAMPED to the room's real
   * high-water before it can seed this value — a bogus client number can never be
   * endorsed back as a synced boundary (XIN-1660).
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
