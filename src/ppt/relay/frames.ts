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
import type { SyncStateJSON } from '../sync/slidesSync.js'

/** The five Bento op kinds the relay accepts (§7.2). */
export const OP_KINDS = ['set', 'ins', 'del', 'ord', 'txt'] as const
export type OpKind = (typeof OP_KINDS)[number]
const OP_KIND_SET: ReadonlySet<string> = new Set(OP_KINDS)


/** Client → server frame types. */
export const CLIENT_FRAME_TYPES = ['hello', 'ops', 'need', 'p', 'bye', 'snap', 'reauth'] as const
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
/**
 * In-place re-authorization on an already-open socket (XIN-1739 P1-3). A
 * NON-persisted control frame: before its current ticket's membership claim
 * expires, a share-derived client mints a FRESH relay ticket via the collab-token
 * endpoint and sends it here, so the relay can re-verify membership in place
 * instead of forcing a full disconnect/replay (the 30s connect/replay/close loop).
 * The relay verifies the fresh ticket, consumes its jti, and requires the SAME
 * uid/docId/documentName as the live connection before refreshing its authority.
 */
export interface ReauthFrame {
  t: 'reauth'
  pv: number
  /** A freshly-minted single-use relay ticket (same credential as the handshake). */
  ticket: string
}

export type ClientFrame = HelloFrame | NeedFrame | PresenceFrame | ByeFrame | OpsFrame | SnapFrame | ReauthFrame

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
  /**
   * The serialized Bento `SyncState` (version vector / registers / positions /
   * births / tombs / text generations / stash / limbo) the `doc` was materialized
   * from (XIN-1759 Part B / XIN-1764 Option 2). A late joiner needs BOTH `doc` and
   * `state` to deterministically apply the ops that follow (`q > coveredSeq`): the
   * doc alone cannot converge concurrent edits against the snapshot boundary. Null
   * only for a legacy doc-only snapshot with no persisted state (pre-Part-B rows).
   */
  state: SyncStateJSON | null
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
    case 'reauth':
      if (typeof f.ticket !== 'string' || f.ticket === '') {
        return { ok: false, code: 'protocol-version', k, frameId, message: 'reauth requires a non-empty ticket string' }
      }
      break
  }
  return { ok: true, frame: f as unknown as ClientFrame }
}

/** True when every entry in `ops` is a structurally-valid Bento `Op` (XIN-1759
 * Part B / XIN-1764 Option 2). The relay no longer accepts the legacy octo op
 * envelope (`{kind,key,prop,delta}`): persisted ops now carry Bento's own wire op
 * so the server-side snapshotter can reduce them through the vendored Bento
 * `SyncEngine`. Every op MUST carry the `OpBase` metadata (`a` actor, `s` per-actor
 * sequence, `l` lamport) plus the per-kind fields the engine reads — validated here
 * up front so a malformed op is refused on the wire rather than corrupting a
 * reduction. Envelope validation stays SEPARATE from the CRDT reducer's own
 * semantics (birth gates, RGA seeds): this only checks shape. */
export function opsAreValid(ops: unknown): ops is unknown[] {
  if (!Array.isArray(ops)) return false
  for (const op of ops) {
    if (!isBentoOp(op)) return false
  }
  return true
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/**
 * The actor-id charset the relay accepts on the wire (XIN-1772 P0-2). The
 * server-side snapshot reducer runs under a RESERVED actor (`@relay`, see
 * {@link ../relay/snapshotter.ts SNAPSHOT_REDUCER_ACTOR}) that the vendored
 * engine's `applyOne` SKIPS as "own, pre-applied". Real client ids are drawn from
 * `[a-z0-9-]` and can never mint the reserved `@`-namespace; enforcing that charset
 * at the trust boundary is what makes the "no client can mint the reducer actor"
 * comment TRUE rather than a convention. Without it a client could send `a:"@relay"`
 * — the frame validates, persists, acks, and live peers apply it, but the
 * snapshotter (actor `@relay`) skips it, saves a state that never saw it, advances
 * the covered seq past it, and prunes it: an acked-durable write silently destroyed.
 * A concrete length bound (a client id is a short opaque token, never unbounded)
 * also keeps `a` from bloating persisted frames / the dedup ledger.
 */
export const ACTOR_ID_PATTERN = /^[a-z0-9-]{1,64}$/

/**
 * Coarse structural ceiling for a Bento op's clock fields `s`/`l` (XIN-1772 P0-2).
 * This is a DEFENSE-IN-DEPTH sanity bound that keeps a wire value from being an
 * absurd near-`MAX_SAFE_INTEGER` integer. It does NOT prove a value is consistent
 * with the room's live clock — the MEANINGFUL, room-aware enforcement is the relay's
 * RELATIVE clock bound (XIN-1821 / XIN-1789 P1-2/P1-3): a `l` / text seed `sd[0]`
 * above `roomLamport + {@link OP_CLOCK_SLACK}` is refused, applied to EVERY connection
 * (it needs nothing from the client half, so it is retained in Half A). An absolute
 * cap alone was insufficient: a wire-legal value FAR below this ceiling but far ABOVE
 * the room's live clock still pins the Lamport clock (`lamport = max(lamport, op.l)`)
 * and invalidates every legitimate successor. The per-actor `s`-continuity gate and
 * the server-minted actor binding remain deferred to Half B (they depend on the client
 * sending `clientSessionId`). 2^45 (≈3.5e13) leaves an astronomically large runway for
 * the coarse bound while the relative bound does the real work.
 */
export const MAX_OP_CLOCK = 2 ** 45

/**
 * Slack above the room's live Lamport clock the relay admits on an incoming `l` /
 * text seed `sd[0]` (XIN-1789 P1-2/P1-3, retained server-only in Half A per XIN-1821).
 * A legitimate client may be ahead of the server's last-observed clock by the ops it
 * minted while offline plus the concurrent peer ops it applied but the relay has not
 * yet serialized — so the bound must not be `<= roomLamport`. 2^20 (≈1e6) is generous
 * headroom for any real editing session (a slide deck never mints a million offline
 * ops) while still refusing a poison value orders of magnitude above the live clock
 * long before it reaches {@link MAX_OP_CLOCK}.
 */
export const OP_CLOCK_SLACK = 2 ** 20

/** True for a wire-legal client actor id: `[a-z0-9-]`, non-reserved, bounded. */
export function isValidActorId(v: unknown): v is string {
  return typeof v === 'string' && ACTOR_ID_PATTERN.test(v)
}

/** A positive safe integer within the op-clock bound (Bento's `stamp` starts at 1). */
function isBoundedOpClock(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= MAX_OP_CLOCK
}

/** A Bento register stamp `[lamport, actor]`. */
function isReg(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    typeof v[0] === 'number' &&
    Number.isSafeInteger(v[0]) &&
    v[0] >= 0 &&
    typeof v[1] === 'string'
  )
}

/**
 * Reserved JS object-key names that are dangerous when used as a map key against a
 * plain (`Object.prototype`-backed) object: `__proto__` invokes the prototype
 * accessor rather than creating an own key, and `constructor` / `prototype` walk the
 * chain (XIN-1821 P0-4). The vendored engine keys `pending`/`pos`/`births`/`tombs`/
 * `txt`/`stash`/`regs` — and the persisted doc node itself, via `set` — by the bare
 * wire id/key, so a wire-legal op naming one of these could crash the reducer (an
 * `ins` under `id:'__proto__'` makes `pending[id]` resolve to a non-iterable
 * `Object.prototype`) or mutate a prototype instead of the intended own key, and
 * because the reducer is downstream of the snapshotter that permanently disables GC
 * for the room. The engine ALSO hardens against this by using null-prototype maps, so
 * this wire rejection is defense-in-depth (and it additionally protects the real doc
 * node written by `set d[op.k]`, which is not an engine map). `a` is already
 * charset-restricted so it cannot carry one; `id`/`el`/`sl`/`k` were only checked as
 * non-empty strings.
 */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** True for a non-empty string that is safe to use as a map / object key. */
function isSafeKeyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && !RESERVED_KEYS.has(v)
}

/**
 * True for a safe `set` op key. A `set` `k` is written onto the real doc node via
 * `d[op.k]`, and a `blobs.`/`assets.` key is split on the FIRST `.` and its remainder
 * used as a sub-map key (`doc.assets[k.slice(...)]`, `crdt.ts` `applySet`). So no
 * `.`-delimited segment may be a reserved prototype key: `assets.__proto__` would
 * otherwise mutate the assets map's prototype. `style.fontFamily` and the like are
 * unaffected — only the exact reserved names are rejected (XIN-1821 P0-4).
 */
function isSafeSetKey(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0) return false
  return !v.split('.').some((seg) => RESERVED_KEYS.has(seg))
}

/**
 * Structural validation of a single Bento `Op`. Mirrors the op shapes the vendored
 * engine mints (`src/ppt/sync/crdt.ts` `SetOp`/`InsOp`/`DelOp`/`OrdOp`/`TxtOp`) and
 * reads in `applyEffect`. Checks the discriminant (`op`), the shared `OpBase`
 * metadata (`a`/`s`/`l`), and the required per-kind fields; optional fields are
 * type-checked only when present. Exported for direct unit coverage.
 */
export function isBentoOp(op: unknown): boolean {
  if (typeof op !== 'object' || op === null) return false
  const o = op as Record<string, unknown>
  if (typeof o.op !== 'string' || !OP_KIND_SET.has(o.op)) return false
  // OpBase: every op carries actor + per-actor seq + lamport. `a` must be a
  // wire-legal client actor id (charset-restricted, non-reserved — a client can
  // NEVER mint the snapshot reducer's `@`-namespace actor); `s` and `l` must be
  // positive safe integers within the coarse op-clock ceiling. The coarse ceiling is
  // only defense-in-depth: the MEANINGFUL bound on `l` (and a `txt` op's seed `sd[0]`)
  // is the relay's RELATIVE room-clock check in `handleOps` (`> roomLamport +
  // OP_CLOCK_SLACK` refused), which prevents a wire-legal value above the room's live
  // clock from poisoning the Lamport clock (XIN-1821 P0-2/P0-3, server-only bound
  // retained in Half A). The per-actor `s`-continuity gate that would stop a
  // non-contiguous `s` from manufacturing an unfillable gap is DEFERRED to Half B (it
  // needs the client-sent `clientSessionId`); Half A relies on the snapshot aged-op
  // reclaim path for a stuck gap instead.
  if (!isValidActorId(o.a) || !isBoundedOpClock(o.s) || !isBoundedOpClock(o.l)) return false
  switch (o.op) {
    case 'set':
      // node id is implicit @doc when neither el nor sl is present; `k` is required.
      // `k` and any present `el`/`sl` are used as object keys by the engine (and `k`
      // is written onto the real doc node via `d[op.k]`), so they must be safe keys
      // (reject `__proto__`/`constructor`/`prototype`, XIN-1821 P0-4).
      if (!isSafeSetKey(o.k)) return false
      if (o.el !== undefined && !isSafeKeyString(o.el)) return false
      if (o.sl !== undefined && !isSafeKeyString(o.sl)) return false
      return true // `v` is any (undefined = key delete)
    case 'ins':
      if (o.kind !== 'slide' && o.kind !== 'element') return false
      // `id` keys the engine's pos/births/pending maps, so it must be a safe key.
      if (!isSafeKeyString(o.id) || !isNonEmptyString(o.ord)) return false
      if (typeof o.node !== 'object' || o.node === null) return false
      if (o.sl !== undefined && !isSafeKeyString(o.sl)) return false
      return true
    case 'del':
      if (o.kind !== 'slide' && o.kind !== 'element') return false
      if (!isSafeKeyString(o.id)) return false
      if (o.cas !== undefined && !(Array.isArray(o.cas) && o.cas.every((c) => typeof c === 'string'))) return false
      return true
    case 'ord':
      if (o.kind !== 'slide' && o.kind !== 'element') return false
      if (!isSafeKeyString(o.id) || !isNonEmptyString(o.ord)) return false
      if (o.sl !== undefined && !isSafeKeyString(o.sl)) return false
      return true
    case 'txt':
      if (!isSafeKeyString(o.el) || !isReg(o.sd)) return false
      if (o.base !== undefined && typeof o.base !== 'string') return false
      if (o.del !== undefined && !(Array.isArray(o.del) && o.del.every((d) => typeof d === 'string'))) return false
      if (o.ins !== undefined) {
        if (!Array.isArray(o.ins)) return false
        for (const seg of o.ins) {
          if (typeof seg !== 'object' || seg === null) return false
          const s = seg as Record<string, unknown>
          if (typeof s.at !== 'string') return false
          if (!(Array.isArray(s.toks) && s.toks.every((t) => typeof t === 'string'))) return false
        }
      }
      return true
    default:
      return false
  }
}
