/**
 * In-process, server-side snapshotter for the PPT relay (R4-B1 XIN-1759 Part B,
 * owner-approved XIN-1758 / XIN-1764 Option 2).
 *
 * The relay is a single-replica, per-room total-order broadcast relay: it already
 * owns process-local room membership, byte accounting, and a per-room mutation
 * chain ({@link PptRelay} `roomChains`). Snapshot advancement and op-log pruning
 * therefore serialize in that SAME room chain — no distributed lock, no second
 * service, no cross-replica scheduler. This module holds the deterministic Bento
 * op reducer and the read → reduce → save → prune sequence; {@link PptRelay} runs
 * every call inside the room chain so it is atomic w.r.t. appends and other
 * snapshot jobs.
 *
 * PRUNE SAFETY (the whole reason this moved server-side): a snapshot may prune
 * `ppt_collab_op.seq <= coveredSeq` ONLY after `(doc, state, coveredSeq)` is
 * durable. Because the reducer applies each op through the vendored Bento
 * `SyncEngine` — the SAME engine the R4-F1 frontend runs (version-pinned, see
 * {@link assertSyncVersionAligned}) — a late joiner rendering `snapshot + ops(>N)`
 * lands on the byte-identical `(doc, state)` an early participant reached by
 * applying every op from genesis. That equivalence is what makes discarding the
 * pruned ops safe; a divergent reducer would destroy them irrecoverably, which is
 * exactly what both GitHub reviewers flagged as un-shippable unless verified.
 */
import { BENTO_SYNC_V, type BentoDoc } from '../bentoDoc.js'
import { SyncState, SYNC_V, type Op, type SyncStateJSON } from '../sync/slidesSync.js'
import type { PersistedOp, PptRelayStore, RelaySnapshot } from './store.js'

/**
 * The reserved reducer actor. Bento's `SyncEngine.applyOne` SKIPS an op whose
 * actor equals the engine's own (`op.a === this.actor`, "own ops are pre-applied
 * at diff time"). The server reduces ops it never authored, so its actor MUST be a
 * value no client can ever mint, or a colliding client's ops would be silently
 * dropped from the reduction. `@` is reserved by the model (real ids are
 * `[a-z0-9-]`), and this exact string is also what the shared golden fixtures
 * reduce under, so the server and the fixtures converge by construction.
 */
export const SNAPSHOT_REDUCER_ACTOR = '@relay'

/**
 * Assert the vendored engine's sync version matches the backend's `BENTO_SYNC_V`
 * (Jeff constraint #1 — front and back MUST run the same kernel version/build, or
 * Option 2's single-reducer guarantee breaks). Called once at snapshotter
 * construction so a re-vendor that bumps `SYNC_V` without bumping `BENTO_SYNC_V`
 * (or vice versa) fails loudly at startup rather than silently forking persisted
 * state from the wire format. Exported for direct unit coverage.
 */
export function assertSyncVersionAligned(): void {
  if (SYNC_V !== BENTO_SYNC_V) {
    throw new Error(
      `Bento sync version drift: vendored engine SYNC_V=${SYNC_V} but backend BENTO_SYNC_V=${BENTO_SYNC_V}; ` +
        're-align the pinned engine before serving the relay (XIN-1759 Part B / Jeff #1)',
    )
  }
}

/** A persisted op frame reduced to the pair the reducer consumes. */
export interface ReducibleFrame {
  seq: number
  ops: Op[]
}

/** The materialized result of a reduction: the doc + the serialized sync state. */
export interface ReductionResult {
  doc: BentoDoc
  state: SyncStateJSON
}

/** Deep structural clone via JSON (the doc/state are plain JSON by contract). */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

/**
 * Extract the `ops` array from a persisted op frame. Frames were shape-validated
 * on append ({@link opsAreValid}), so `frame.ops` is a Bento `Op[]`; a frame that
 * somehow lacks it contributes no ops (defensive — never throws mid-reduction).
 */
export function opsOfFrame(frame: unknown): Op[] {
  if (frame && typeof frame === 'object' && Array.isArray((frame as { ops?: unknown }).ops)) {
    return (frame as { ops: Op[] }).ops
  }
  return []
}

/**
 * The deterministic Bento reduction (pure). Reduces `baseDoc` + `baseState`
 * through `frames` (ascending seq) into a fresh `(doc, state)` via the vendored
 * `SyncEngine`, under the reserved reducer actor.
 *
 * `baseState === null` is genesis: seed positions from the base deck's current
 * array order via `adopt` — the SAME deterministic seeding the frontend performs
 * on a never-synced deck, so a full-log reduction from genesis and a
 * snapshot@N + tail reduction converge (the convergence invariant). A non-null
 * `baseState` restores the engine verbatim and applies only the ops above it.
 *
 * Neither `baseDoc` nor `baseState` is mutated — both are cloned first.
 */
export function reduceFrames(
  baseDoc: BentoDoc,
  baseState: SyncStateJSON | null,
  frames: ReducibleFrame[],
): ReductionResult {
  const doc = clone(baseDoc)
  let engine: SyncState
  if (baseState) {
    engine = SyncState.fromJSON(SNAPSHOT_REDUCER_ACTOR, clone(baseState))
  } else {
    engine = new SyncState(SNAPSHOT_REDUCER_ACTOR)
    engine.adopt(doc)
  }
  // Ascending seq is the room's authoritative total order; the CRDT converges
  // regardless of interleaving, but applying in room order keeps a snapshot's
  // materialized array order deterministic and matches the frontend's live apply.
  const ordered = [...frames].sort((a, b) => a.seq - b.seq)
  for (const f of ordered) engine.apply(doc, f.ops)
  return { doc, state: engine.toJSON() }
}

/** The outcome of a snapshot run: what was pruned and the reclaimed byte count. */
export interface SnapshotRunResult {
  snapshotVersion: number
  coveredSeq: number
  prunedThroughSeq: number
  freedBytes: number
}

/**
 * The server-side snapshotter. Constructed once per {@link PptRelay}; every method
 * is invoked from inside the relay's per-room chain, so its store reads and writes
 * are atomic w.r.t. appends and other snapshot jobs on the same room.
 */
export class PptSnapshotter {
  constructor(private readonly store: PptRelayStore) {
    assertSyncVersionAligned()
  }

  /**
   * Advance the room snapshot to the current durable high-water and prune the ops
   * it subsumes. MUST be called from inside the room chain.
   *
   *  1. Read the latest durable snapshot `(doc, state, coveredSeq)`, the current
   *     high-water, and the durable op tail `(coveredSeq, highWater]`.
   *  2. Reduce base `(doc|genesis, state)` + tail through the Bento engine.
   *  3. Persist `(doc, state, targetSeq)` atomically via `saveSnapshot`.
   *  4. ONLY THEN prune `seq <= authoritative-coveredSeq` and report reclaimed bytes.
   *
   * Returns null (a no-op) when there is nothing to advance (no tail above the
   * current coverage) or when no base doc is available yet (no durable snapshot and
   * `baseDocProvider` yields nothing — a genesis deck the relay cannot source).
   * A storage failure propagates to the caller, which classifies it (retryable →
   * `storage-retry`) — the snapshot is never acked as done when its write failed.
   */
  async advance(
    docId: string,
    baseDocProvider: ((docId: string) => Promise<BentoDoc | null>) | undefined,
  ): Promise<SnapshotRunResult | null> {
    const existing = await this.store.getSnapshot(docId)
    const highWater = await this.store.currentSeq(docId)
    const coveredSeq = existing?.coveredSeq ?? 0
    // Nothing above the current coverage to fold in → no work.
    if (highWater <= coveredSeq) return null

    const baseDoc = await this.resolveBaseDoc(docId, existing, baseDocProvider)
    if (!baseDoc) return null

    const tail = await this.readTail(docId, coveredSeq, highWater)
    // Guard: the tail cursor must reach the target high-water contiguously enough
    // for the engine to apply it. Missing intermediate seqs are legal holes (burned
    // op-dup seqs / rolled-back appends); the engine tolerates them per actor. The
    // target coverage is the highest seq actually present in the tail, never a hole
    // above it — pruning is bound to what the persisted doc truly subsumes.
    const targetSeq = tail.length > 0 ? tail[tail.length - 1]!.seq : coveredSeq
    if (targetSeq <= coveredSeq) return null

    const frames: ReducibleFrame[] = tail.map((op) => ({ seq: op.seq, ops: opsOfFrame(op.frame) }))
    const { doc, state } = reduceFrames(baseDoc, existing?.state ?? null, frames)

    // Persist doc + state + coverage atomically BEFORE any prune (§7.3).
    const saved = await this.store.saveSnapshot({ docId, coveredSeq: targetSeq, doc, state })
    // Prune with the AUTHORITATIVE post-write coveredSeq the store read back
    // (GREATEST(existing, incoming)), never the raw target: a snapshot may only
    // ever prune the op prefix the persisted doc actually subsumes (XIN-1693 P0-1).
    const prunableSeq = saved.coveredSeq ?? targetSeq
    const freedBytes = await this.store.pruneOpsThrough(docId, prunableSeq)
    return { snapshotVersion: saved.snapshotVersion, coveredSeq: saved.coveredSeq ?? targetSeq, prunedThroughSeq: prunableSeq, freedBytes }
  }

  /** The base doc to reduce onto: the durable snapshot's doc, else the genesis deck. */
  private async resolveBaseDoc(
    docId: string,
    existing: RelaySnapshot | null,
    baseDocProvider: ((docId: string) => Promise<BentoDoc | null>) | undefined,
  ): Promise<BentoDoc | null> {
    if (existing) return existing.doc
    if (!baseDocProvider) return null
    return baseDocProvider(docId)
  }

  /** Read the durable op tail `(coveredSeq, highWater]`, ascending. */
  private async readTail(docId: string, coveredSeq: number, highWater: number): Promise<PersistedOp[]> {
    const out: PersistedOp[] = []
    let cursor = coveredSeq
    // Page defensively so a very long tail does not load unbounded at once; the
    // in-memory store returns everything, the DB store bounds by `limit`.
    for (;;) {
      const page = await this.store.opsSince(docId, cursor, 1000)
      if (page.length === 0) break
      for (const op of page) {
        if (op.seq > highWater) continue
        out.push(op)
      }
      const last = page[page.length - 1]!.seq
      if (last <= cursor) break
      cursor = last
      if (cursor >= highWater) break
    }
    return out
  }
}
