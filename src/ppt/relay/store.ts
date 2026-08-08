/**
 * Durable persistence seam for the PPT relay (§7.3).
 *
 * The relay's correctness contract — "ack ONLY after durable persistence, then
 * broadcast" and "advance snapshot version atomically, prune covered ops only
 * after the snapshot is durable" — is expressed against this interface, so the
 * engine is independent of the concrete store. Production wires a MySQL-backed
 * store ({@link ../../db/repos/pptCollabOpRepo} + {@link
 * ../../db/repos/pptLiveSnapshotRepo}); tests use {@link InMemoryPptRelayStore}.
 *
 * Ordering invariants a store MUST uphold:
 *  - `appendOp` assigns a strictly monotonic room sequence per docId and is
 *    UNIQUE on `(docId, frameId)` — a re-sent frame returns its original seq
 *    with `duplicate:true` (idempotent, never a second row).
 *  - `saveSnapshot` writes the snapshot AND advances the version atomically;
 *    `pruneOpsThrough` runs only after that write is durable.
 */
import { createHash } from 'node:crypto'
import type { BentoDoc } from '../bentoDoc.js'

/** A durably-persisted op frame, addressed by its room sequence. */
export interface PersistedOp {
  /** Monotonic per-room sequence assigned at persist time. */
  seq: number
  /** Unique-per-room frame id (dedup key). */
  frameId: string
  /** The original `ops` frame, stored verbatim (plaintext JSON, §7.3). */
  frame: unknown
  /** Persisted JSON byte size, used to bound replay pages by bytes. */
  frameBytes?: number
}

export interface AppendOpResult {
  seq: number
  /** True when `(docId, frameId)` already existed — `seq` is the original. */
  duplicate: boolean
  /** Byte size of the persisted frame JSON (room-budget accounting). */
  frameBytes: number
}

export interface FrameIdentity {
  seq: number
  payloadHash: string | null
}

export class DuplicateFramePayloadError extends Error {
  readonly duplicatePayloadMismatch = true as const
  constructor(frameId: string) {
    super(`frameId ${frameId} was already used with a different payload`)
    this.name = 'DuplicateFramePayloadError'
  }
}

/**
 * Thrown when {@link canonicalStringify} / {@link canonicalPayloadHash} hits a
 * payload nested deeper than {@link MAX_CANONICAL_DEPTH} (XIN-1739 P2). It converts
 * an unbounded native recursion — which a ~5000-deep `ops` frame (well under every
 * byte cap) would drive into a `RangeError: Maximum call stack size exceeded` that
 * escapes the relay's handler and is swallowed by the serialized-chain tail,
 * leaving the client with NEITHER an ack NOR a refusal — into a controlled, early,
 * TYPED throw the relay maps to a `protocol-version` refusal, so every frame still
 * gets a verdict.
 */
export class CanonicalDepthError extends Error {
  readonly canonicalDepthExceeded = true as const
  constructor() {
    super('payload nesting exceeds the canonical-hash depth limit')
    this.name = 'CanonicalDepthError'
  }
}

export function isCanonicalDepthError(err: unknown): err is CanonicalDepthError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { canonicalDepthExceeded?: unknown }).canonicalDepthExceeded === true
  )
}

/**
 * Max structural nesting {@link canonicalStringify} will descend before throwing
 * {@link CanonicalDepthError}. Legitimate `ops` payloads (slide element props and
 * their values) are only a handful of levels deep, so this cap is orders of
 * magnitude above any real frame yet far below the native-recursion stack limit —
 * a pathological deep-nest frame is refused, never crashes the handler (XIN-1739 P2).
 */
export const MAX_CANONICAL_DEPTH = 500

/**
 * Stable, key-order-independent JSON serialization: object keys are emitted in
 * sorted order at every depth so two structurally-equal payloads that differ
 * only in key order (or were re-serialized by a different client build) hash
 * identically. Arrays keep their order (op order is semantic).
 *
 * Descends at most {@link MAX_CANONICAL_DEPTH} levels; a deeper payload throws
 * {@link CanonicalDepthError} rather than overflowing the stack (XIN-1739 P2).
 */
export function canonicalStringify(value: unknown, depth = 0): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (depth >= MAX_CANONICAL_DEPTH) throw new CanonicalDepthError()
  if (Array.isArray(value)) return `[${value.map((v) => canonicalStringify(v, depth + 1)).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k], depth + 1)}`).join(',')}}`
}

/**
 * Canonical hash of a frame's SEMANTIC payload — its `ops` array ONLY, with
 * stable key order — NOT the whole wire envelope.
 *
 * The envelope carries transport metadata (`t`, `pv`, `k`, `frameId`, `epoch`)
 * that legitimately varies between an original frame and an idempotent resend of
 * the same edit: a resend after a permission-epoch bump carries a NEW `epoch`,
 * and a different client build may serialize the same object with a different
 * key order. Hashing the whole envelope (the previous behavior) made such a
 * resend compute a different hash and be permanently refused `protocol-version`
 * (non-retryable) for a write that had actually committed — the exact failure
 * the idempotent-resend contract exists to prevent (XIN-1736 P1-A). Hashing the
 * canonical `ops` alone makes the dedup identity depend only on the edit, so a
 * genuine resend re-acks and only a reused frameId carrying DIFFERENT ops is
 * refused.
 */
export function canonicalPayloadHash(frame: unknown): string {
  const payload =
    frame !== null && typeof frame === 'object' && 'ops' in (frame as Record<string, unknown>)
      ? (frame as { ops: unknown }).ops
      : frame
  return createHash('sha256').update(canonicalStringify(payload), 'utf8').digest('hex')
}

export function isDuplicateFramePayloadError(err: unknown): err is DuplicateFramePayloadError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { duplicatePayloadMismatch?: unknown }).duplicatePayloadMismatch === true
  )
}

export interface RelaySnapshot {
  snapshotVersion: number
  /** Room sequence this snapshot covers (ops <= coveredSeq are prunable). */
  coveredSeq: number
  doc: BentoDoc
}

export interface SaveSnapshotInput {
  docId: string
  coveredSeq: number
  doc: BentoDoc
}

export interface SaveSnapshotResult {
  /** The new authoritative snapshot version (previous + 1). */
  snapshotVersion: number
  /**
   * The authoritative POST-WRITE covered seq the store read back (via
   * `GREATEST(existing, incoming)`). The relay prunes with THIS value, never the
   * client's raw `q`, so a snapshot can never claim to cover — and prune — a seq
   * the persisted doc does not actually subsume (XIN-1693 P0-1).
   */
  coveredSeq?: number
}

/**
 * A consistent replay view: the room high-water plus the latest snapshot and the
 * op tail, all read from ONE point-in-time (a single transaction for the DB
 * store). Reading them together closes the P1-4 seam where a concurrent
 * `snap`+prune between separate autocommit reads could leave a reader with
 * neither the snapshot nor the pruned ops (XIN-1693 P1-4).
 */
export interface ReplayCursor {
  /** Authoritative room high-water (`ppt_collab_seq.last_seq`), 0 when none. */
  highWater: number
  /** Latest durable snapshot, or null when none exists yet. */
  snapshot: RelaySnapshot | null
  /** First op cursor requested by the caller. */
  fromSeq: number
  /** Next bounded page of un-pruned ops, ascending. Empty means EOF. */
  nextPage(): Promise<PersistedOp[]>
  /** Release any transaction / connection held by the cursor. Idempotent. */
  close(): Promise<void>
}

export interface ReplayView {
  highWater: number
  snapshot: RelaySnapshot | null
  ops: PersistedOp[]
}

export interface ReplayLimits {
  pageRows: number
  pageBytes: number
}

/**
 * A TRANSIENT storage failure that outlived the store's internal retries (a
 * lock-wait timeout / deadlock, or a room-budget seed read that could not be
 * confirmed). The relay maps this to the retryable `storage-retry` refusal so the
 * client re-sends, rather than the permanent `storage-failed` (XIN-1693 P1-5).
 */
export class RetryableStorageError extends Error {
  readonly retryable = true as const
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RetryableStorageError'
  }
}

function isTransientLockError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { code?: string; errno?: number }
  return (
    e.code === 'ER_LOCK_WAIT_TIMEOUT' ||
    e.code === 'ER_LOCK_DEADLOCK' ||
    e.errno === 1205 ||
    e.errno === 1213
  )
}

const STORE_RETRY_ATTEMPTS = 3
const STORE_RETRY_BACKOFF_MS = 25

/**
 * Retry a whole store operation on transient MySQL lock failures. Exhaustion
 * remains retryable to the relay/client; non-transient errors pass through.
 */
export async function withStoreRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= STORE_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (!isTransientLockError(err)) throw err
      lastErr = err
      if (attempt < STORE_RETRY_ATTEMPTS) await new Promise((r) => setTimeout(r, STORE_RETRY_BACKOFF_MS * attempt))
    }
  }
  throw new RetryableStorageError(`${operation} lock contention exceeded retries`, { cause: lastErr })
}

/** True when `err` is a transient storage failure the relay should retry. */
export function isRetryableStorageError(err: unknown): err is RetryableStorageError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { retryable?: unknown }).retryable === true
  )
}

export interface PptRelayStore {
  /**
   * Append an op frame durably, assigning the next room sequence. If `frameId`
   * already exists for `docId`, return its original seq with `duplicate:true`
   * and DO NOT create a second row.
   */
  appendOp(docId: string, frameId: string, frame: unknown): Promise<AppendOpResult>
  /**
   * Seq already recorded for `(docId, frameId)`, or null if unseen. A CURRENT
   * read of the dedup ledger used by the relay BEFORE its mutation gate
   * (epoch/role/status) and its room-full/rate gates so a known-duplicate resend
   * (whose original ack was lost) re-acks its stored seq — even from a connection
   * since downgraded or whose epoch advanced — instead of being refused
   * `forbidden-role`/`stale-epoch`/`room-full`/`rate-limited` (XIN-1660 D3,
   * idempotent-resend contract).
   */
  frameSeq(docId: string, frameId: string): Promise<number | null>
  /** Seq plus payload hash already recorded for `(docId, frameId)`, when available. */
  frameIdentity?(docId: string, frameId: string): Promise<FrameIdentity | null>
  /**
   * Resolve the re-ack identity of a ledger row whose `payload_hash` is NULL (a
   * legacy row, or one nulled by the canonical-ops hash-scheme migration) for the
   * relay's PRE-GATE re-ack path: read the stored op `frame_json` and recompute
   * its canonical-ops hash so a pure re-ack of an already-durable write can be
   * payload-verified WITHOUT the mutation gate (writer/current-epoch), exactly like
   * the non-null fast re-ack (XIN-1750). Returns `{seq, payloadHash}` (the ledger's
   * seq + the hash recomputed from `frame_json`) when the NULL-hash row's op is
   * still present, or null when the frame is unseen, is NOT a NULL-hash row, OR its
   * op row was already pruned (no `frame_json` to verify against) — in which case
   * the caller falls through to the mutation gate + {@link appendOp}, which gates
   * or fails closed as appropriate. A pure CURRENT read: it consumes neither budget
   * nor a rate slot, does not persist, and is not rebroadcast.
   */
  resolveNullHashReack?(docId: string, frameId: string): Promise<{ seq: number; payloadHash: string } | null>
  /** Ops with `seq > sinceSeq`, ascending. Bounded to `limit` rows when given. */
  opsSince(docId: string, sinceSeq: number, limit?: number): Promise<PersistedOp[]>
  /** Highest assigned room sequence for the doc (0 when none). */
  currentSeq(docId: string): Promise<number>
  /** Sum of persisted frame bytes still present for the room (budget seeding). */
  roomBytes(docId: string): Promise<number>
  /** Latest durable snapshot, or null when none exists yet. */
  getSnapshot(docId: string): Promise<RelaySnapshot | null>
  /**
   * Persist a snapshot and advance the version ATOMICALLY. The caller prunes
   * covered ops via {@link pruneOpsThrough} only AFTER this resolves.
   */
  saveSnapshot(input: SaveSnapshotInput): Promise<SaveSnapshotResult>
  /** Delete persisted ops with `seq <= coveredSeq`; returns the bytes reclaimed. */
  pruneOpsThrough(docId: string, coveredSeq: number): Promise<number>
  /**
   * OPTIONAL streaming replay cursor: reads high-water + snapshot and each op
   * page from one consistent point-in-time (§7.3 / XIN-1693 P1-4). `limits`
   * bounds each page by row count and by approximate persisted JSON bytes.
   */
  openReplay?(docId: string, sinceSeq: number, limits: ReplayLimits): Promise<ReplayCursor>
}

interface RoomState {
  ops: Array<PersistedOp & { bytes: number }>
  seq: number
  byFrameId: Map<string, { seq: number; payloadHash: string | null }>
  snapshot: RelaySnapshot | null
}

/**
 * In-memory {@link PptRelayStore} for tests and single-node/dev use. Enforces the
 * same monotonic-seq, unique-frameId, and atomic-snapshot-then-prune invariants
 * as the DB store so relay behavior tests exercise the real ordering contract.
 */
export class InMemoryPptRelayStore implements PptRelayStore {
  private readonly rooms = new Map<string, RoomState>()

  private room(docId: string): RoomState {
    let r = this.rooms.get(docId)
    if (!r) {
      r = { ops: [], seq: 0, byFrameId: new Map(), snapshot: null }
      this.rooms.set(docId, r)
    }
    return r
  }

  async appendOp(docId: string, frameId: string, frame: unknown): Promise<AppendOpResult> {
    const r = this.room(docId)
    const bytes = Buffer.byteLength(JSON.stringify(frame), 'utf8')
    const payloadHash = canonicalPayloadHash(frame)
    const existing = r.byFrameId.get(frameId)
    if (existing !== undefined) {
      if (existing.payloadHash !== payloadHash) throw new DuplicateFramePayloadError(frameId)
      const prev = r.ops.find((o) => o.seq === existing.seq)
      return { seq: existing.seq, duplicate: true, frameBytes: prev?.bytes ?? bytes }
    }
    const seq = r.seq + 1
    r.seq = seq
    r.ops.push({ seq, frameId, frame, bytes })
    r.byFrameId.set(frameId, { seq, payloadHash })
    return { seq, duplicate: false, frameBytes: bytes }
  }

  async frameSeq(docId: string, frameId: string): Promise<number | null> {
    // `byFrameId` is the in-memory dedup ledger; it is retained past prune (see
    // pruneOpsThrough), so a resend of an already-persisted frame is found here
    // even after its op row is gone — the analog of the DB store's
    // append-time `ppt_collab_frame` ledger (XIN-1660 D1/D3).
    return this.room(docId).byFrameId.get(frameId)?.seq ?? null
  }

  async frameIdentity(docId: string, frameId: string): Promise<FrameIdentity | null> {
    const r = this.room(docId)
    const identity = r.byFrameId.get(frameId)
    if (identity === undefined) return null
    return { seq: identity.seq, payloadHash: identity.payloadHash }
  }

  async resolveNullHashReack(docId: string, frameId: string): Promise<{ seq: number; payloadHash: string } | null> {
    // Only a NULL-hash ledger row routes through this pre-gate re-ack path; a row
    // that already carries a canonical-ops hash is resolved on the fast path via
    // `frameIdentity`. The stored op frame is the verification source: recompute
    // its canonical-ops hash so the caller can payload-verify the resend without
    // the mutation gate. A frame whose op row was pruned (or never seen) has no
    // frame to verify against and returns null → the caller falls through and
    // `appendOp` fails closed (XIN-1750 / XIN-1736 P2-d).
    const r = this.room(docId)
    const identity = r.byFrameId.get(frameId)
    if (identity === undefined || identity.payloadHash !== null) return null
    const op = r.ops.find((o) => o.frameId === frameId)
    if (op === undefined) return null
    return { seq: identity.seq, payloadHash: canonicalPayloadHash(op.frame) }
  }

  async opsSince(docId: string, sinceSeq: number, limit?: number): Promise<PersistedOp[]> {
    const r = this.room(docId)
    const tail = r.ops.filter((o) => o.seq > sinceSeq)
    const bounded = limit !== undefined && limit >= 0 ? tail.slice(0, limit) : tail
    return bounded.map((o) => ({ seq: o.seq, frameId: o.frameId, frame: o.frame, frameBytes: o.bytes }))
  }

  async currentSeq(docId: string): Promise<number> {
    return this.room(docId).seq
  }

  async roomBytes(docId: string): Promise<number> {
    return this.room(docId).ops.reduce((sum, o) => sum + o.bytes, 0)
  }

  async getSnapshot(docId: string): Promise<RelaySnapshot | null> {
    const s = this.room(docId).snapshot
    return s ? { ...s } : null
  }

  async saveSnapshot(input: SaveSnapshotInput): Promise<SaveSnapshotResult> {
    const r = this.room(input.docId)
    const cur = r.snapshot
    // Mirror the DB store's atomic covered-guard: only advance the version and
    // replace the doc when the incoming coverage does not regress (P0-3).
    if (!cur || input.coveredSeq >= cur.coveredSeq) {
      const snapshotVersion = (cur?.snapshotVersion ?? 0) + 1
      r.snapshot = { snapshotVersion, coveredSeq: input.coveredSeq, doc: input.doc }
      return { snapshotVersion, coveredSeq: input.coveredSeq }
    }
    return { snapshotVersion: cur.snapshotVersion, coveredSeq: cur.coveredSeq }
  }

  async pruneOpsThrough(docId: string, coveredSeq: number): Promise<number> {
    const r = this.room(docId)
    let freed = 0
    r.ops = r.ops.filter((o) => {
      if (o.seq <= coveredSeq) {
        freed += o.bytes
        return false
      }
      return true
    })
    // Deliberately DO NOT drop `byFrameId` for pruned frames: idempotent-resend
    // dedup must survive GC (XIN-1655 C1). A frame re-sent after its op row is
    // pruned still re-acks its original seq via the retained mapping rather than
    // being minted a fresh seq and rebroadcast. This mirrors the DB store's
    // `ppt_collab_frame` dedup ledger.
    return freed
  }

  /**
   * Atomic replay view. The in-memory store's reads are already consistent (no
   * interleaving await between them touches the same room synchronously), so this
   * composes the individual reads THROUGH `this` — a subclass that overrides
   * `currentSeq`/`getSnapshot`/`opsSince` (the test doubles) still sees its
   * override honored here.
   */
  async openReplay(docId: string, sinceSeq: number, limits: ReplayLimits): Promise<ReplayCursor> {
    const view = await this.readReplay(docId, sinceSeq)
    let cursor = sinceSeq
    let closed = false
    return {
      highWater: view.highWater,
      snapshot: view.snapshot,
      fromSeq: sinceSeq,
      nextPage: async () => {
        if (closed) return []
        const rows = view.ops.filter((o) => o.seq > cursor).slice(0, limits.pageRows)
        const page: PersistedOp[] = []
        let bytes = 0
        for (const row of rows) {
          const frameBytes = row.frameBytes ?? Buffer.byteLength(JSON.stringify(row.frame), 'utf8')
          if (page.length > 0 && bytes + frameBytes > limits.pageBytes) break
          page.push(row)
          bytes += frameBytes
        }
        if (page.length > 0) cursor = page[page.length - 1]!.seq
        return page
      },
      close: async () => {
        closed = true
      },
    }
  }

  async readReplay(docId: string, sinceSeq: number): Promise<ReplayView> {
    const highWater = await this.currentSeq(docId)
    const snapshot = await this.getSnapshot(docId)
    const ops = await this.opsSince(docId, sinceSeq)
    return { highWater, snapshot, ops }
  }
}
