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
  /** Ops with `seq > sinceSeq`, ascending. */
  opsSince(docId: string, sinceSeq: number): Promise<PersistedOp[]>
  /** Highest assigned room sequence for the doc (0 when none). */
  currentSeq(docId: string): Promise<number>
  /** Latest durable snapshot, or null when none exists yet. */
  getSnapshot(docId: string): Promise<RelaySnapshot | null>
  /**
   * Persist a snapshot and advance the version ATOMICALLY. The caller prunes
   * covered ops via {@link pruneOpsThrough} only AFTER this resolves.
   */
  saveSnapshot(input: SaveSnapshotInput): Promise<SaveSnapshotResult>
  /** Delete persisted ops with `seq <= coveredSeq` (post-snapshot GC). */
  pruneOpsThrough(docId: string, coveredSeq: number): Promise<void>
}

interface RoomState {
  ops: PersistedOp[]
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
    const existing = r.byFrameId.get(frameId)
    if (existing !== undefined) return { seq: existing, duplicate: true }
    const seq = r.seq + 1
    r.seq = seq
    r.ops.push({ seq, frameId, frame })
    r.byFrameId.set(frameId, seq)
    return { seq, duplicate: false }
  }

  async opsSince(docId: string, sinceSeq: number): Promise<PersistedOp[]> {
    const r = this.room(docId)
    return r.ops.filter((o) => o.seq > sinceSeq).map((o) => ({ ...o }))
  }

  async currentSeq(docId: string): Promise<number> {
    return this.room(docId).seq
  }

  async getSnapshot(docId: string): Promise<RelaySnapshot | null> {
    const s = this.room(docId).snapshot
    return s ? { ...s } : null
  }

  async saveSnapshot(input: SaveSnapshotInput): Promise<SaveSnapshotResult> {
    const r = this.room(input.docId)
    const snapshotVersion = (r.snapshot?.snapshotVersion ?? 0) + 1
    r.snapshot = { snapshotVersion, coveredSeq: input.coveredSeq, doc: input.doc }
    return { snapshotVersion }
  }

  async pruneOpsThrough(docId: string, coveredSeq: number): Promise<void> {
    const r = this.room(docId)
    r.ops = r.ops.filter((o) => o.seq > coveredSeq)
  }
}
