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
import type { BentoDoc } from '../bentoDoc.js'

/** A durably-persisted op frame, addressed by its room sequence. */
export interface PersistedOp {
  /** Monotonic per-room sequence assigned at persist time. */
  seq: number
  /** Unique-per-room frame id (dedup key). */
  frameId: string
  /** The original `ops` frame, stored verbatim (plaintext JSON, §7.3). */
  frame: unknown
}

export interface AppendOpResult {
  seq: number
  /** True when `(docId, frameId)` already existed — `seq` is the original. */
  duplicate: boolean
  /** Byte size of the persisted frame JSON (room-budget accounting). */
  frameBytes: number
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
   * read of the dedup ledger used by the relay BEFORE its room-full/rate gates so
   * a known-duplicate resend (whose original ack was lost) re-acks its stored seq
   * instead of being permanently refused `room-full`/`rate-limited` (XIN-1660 D3).
   */
  frameSeq(docId: string, frameId: string): Promise<number | null>
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
}

interface RoomState {
  ops: Array<PersistedOp & { bytes: number }>
  seq: number
  byFrameId: Map<string, number>
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
    const existing = r.byFrameId.get(frameId)
    if (existing !== undefined) {
      const prev = r.ops.find((o) => o.seq === existing)
      return { seq: existing, duplicate: true, frameBytes: prev?.bytes ?? bytes }
    }
    const seq = r.seq + 1
    r.seq = seq
    r.ops.push({ seq, frameId, frame, bytes })
    r.byFrameId.set(frameId, seq)
    return { seq, duplicate: false, frameBytes: bytes }
  }

  async frameSeq(docId: string, frameId: string): Promise<number | null> {
    // `byFrameId` is the in-memory dedup ledger; it is retained past prune (see
    // pruneOpsThrough), so a resend of an already-persisted frame is found here
    // even after its op row is gone — the analog of the DB store's
    // append-time `ppt_collab_frame` ledger (XIN-1660 D1/D3).
    const seq = this.room(docId).byFrameId.get(frameId)
    return seq ?? null
  }

  async opsSince(docId: string, sinceSeq: number, limit?: number): Promise<PersistedOp[]> {
    const r = this.room(docId)
    const tail = r.ops.filter((o) => o.seq > sinceSeq)
    const bounded = limit !== undefined && limit >= 0 ? tail.slice(0, limit) : tail
    return bounded.map((o) => ({ seq: o.seq, frameId: o.frameId, frame: o.frame }))
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
      return { snapshotVersion }
    }
    return { snapshotVersion: cur.snapshotVersion }
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
}
