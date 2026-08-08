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
 * Reduce `baseDoc` + `baseState` through `frames` (ascending seq) into a fresh
 * engine, returning both the materialized doc and the live engine. Internal seam
 * shared by {@link reduceFrames} (which serializes the engine) and the
 * snapshotter's watermark probe (which inspects {@link SyncEngine.bufferedOps}).
 * Neither `baseDoc` nor `baseState` is mutated — both are cloned first.
 */
function reduceInto(
  baseDoc: BentoDoc,
  baseState: SyncStateJSON | null,
  frames: ReducibleFrame[],
): { doc: BentoDoc; engine: SyncState } {
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
  return { doc, engine }
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
  const { doc, engine } = reduceInto(baseDoc, baseState, frames)
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
   * current coverage), when no base doc is available yet (no durable snapshot and
   * `baseDocProvider` yields nothing — a genesis deck the relay cannot source), or
   * when the existing snapshot is a legacy doc-only row (`state === null`) whose
   * Bento SyncState cannot be faithfully reduced (XIN-1770 — see the guard below).
   * A storage failure propagates to the caller, which classifies it (retryable →
   * `storage-retry`) — the snapshot is never acked as done when its write failed.
   */
  async advance(
    docId: string,
    baseDocProvider: ((docId: string) => Promise<BentoDoc | null>) | undefined,
  ): Promise<SnapshotRunResult | null> {
    const existing = await this.store.getSnapshot(docId)
    // Legacy doc-only boundary guard (XIN-1770). A snapshot row persisted before
    // Part B added the state column carries `state === null`: its doc is durable
    // but the Bento SyncState it was reduced to is not. We CANNOT advance past such
    // a boundary. Reducing the tail here would pass `existing.state ?? null` = null
    // into `reduceFrames`, which treats the already-materialized doc as a
    // never-synced genesis and re-`adopt`s it — minting FRESH Bento RGA/text
    // generations that the tail's `txt`/`ins`/`ord`/`del` ops (minted against the
    // ORIGINAL generation state) no longer address, so those ops silently no-op and
    // the compacted doc diverges from the full-log reduction. The ops that built
    // this boundary (`seq <= coveredSeq`) were pruned before the migration, so the
    // state cannot be deterministically reconstructed from the durable log either.
    // Advancing would therefore compact the boundary into a CORRUPT snapshot and
    // then prune the tail that proves it wrong — silent upgrade-boundary data loss.
    // Refuse: never compact + prune a boundary whose SyncState we cannot faithfully
    // reduce. The relay keeps replaying this row doc-only (frames.ts wire contract)
    // until a future full-log/state backfill rewrites it with a real state; the op
    // log is simply not pruned in the meantime (a forced trigger degrades to
    // `room-full`, a safe non-lossy fallback — never a lossy prune).
    //
    // P1-1 (XIN-1772): `state === null` is not the ONLY un-reducible boundary. A
    // state persisted at a DIFFERENT `SYNC_V` restores as an EMPTY engine
    // (`SyncEngine.fromJSON` returns a bare engine when `j.v !== SYNC_V`, crdt.ts),
    // so reducing the tail against it silently produces the SAME fresh-adopt
    // divergence as the doc-only case — then prunes the tail that proves it wrong.
    // `assertSyncVersionAligned()` only compares the two compile-time constants; it
    // cannot catch a ROW written under an older engine build. Treat a version-drifted
    // persisted state exactly like the legacy doc-only boundary: refuse to advance.
    //
    // P1-2 mode 2 (XIN-1772): give the un-reducible boundary a bounded reclaim path
    // instead of a terminal read-only brick. Ops at/below `coveredSeq` are already
    // subsumed by the durable doc (that is what the snapshot materialized), so they
    // are safe to prune even though the tail above cannot be folded in. Re-attempt
    // that idempotent prune here so a legacy/version-drifted room reclaims its
    // covered prefix rather than growing unbounded to `room-full`.
    if (existing && (existing.state === null || existing.state.v !== SYNC_V)) {
      return this.reattemptPrune(docId, existing.coveredSeq)
    }
    const highWater = await this.store.currentSeq(docId)
    const coveredSeq = existing?.coveredSeq ?? 0
    // Nothing above the current coverage to fold in → no NEW work. But a prior run
    // may have committed its snapshot save and then FAILED (or died) before its
    // separate prune transaction ran (P1-2 mode 1, XIN-1772): the ops it already
    // covers are still on disk, charged against the room budget, and the raw
    // `highWater <= coveredSeq` short-circuit would skip pruning them forever →
    // the room fills and deadlocks read-only. Re-attempt the idempotent prune of
    // the covered prefix before declaring a no-op.
    if (highWater <= coveredSeq) return this.reattemptPrune(docId, coveredSeq)

    const baseDoc = await this.resolveBaseDoc(docId, existing, baseDocProvider)
    if (!baseDoc) return null

    const tail = await this.readTail(docId, coveredSeq, highWater)
    // Guard: the tail cursor must reach the target high-water contiguously enough
    // for the engine to apply it. Missing intermediate seqs are legal holes (burned
    // op-dup seqs / rolled-back appends); the engine tolerates them per actor. The
    // target coverage is the highest seq actually present in the tail, never a hole
    // above it — pruning is bound to what the persisted doc truly subsumes.
    const targetSeq = tail.length > 0 ? tail[tail.length - 1]!.seq : coveredSeq
    if (targetSeq <= coveredSeq) return this.reattemptPrune(docId, coveredSeq)

    const frames: ReducibleFrame[] = tail.map((op) => ({ seq: op.seq, ops: opsOfFrame(op.frame) }))
    // Reduce the WHOLE tail once, then bind the covered watermark to what the engine
    // PROVABLY applied. The vendored engine BUFFERS (never applies) an op whose
    // per-actor `s` exceeds its running contiguous sequence + 1 — a gap left by a
    // lower-`s` frame that was refused (too-large/malformed) while a higher-`s` frame
    // committed (frames.ts validates each `s` only as a bounded positive int, so a
    // gap CAN persist). A buffered op advances neither the applied doc nor the
    // version vector and is absent from `toJSON()`, so folding the tail up to
    // `targetSeq` into the persisted state and pruning `<= targetSeq` would DESTROY
    // that acked-durable op and diverge the room from peers who applied it live
    // (XIN-1772 P0-1). The post-reduction version vector is the proof of application:
    // an op is applied iff `op.s <= vv[op.a]` (vv is the per-actor max CONTIGUOUS
    // sequence). Refuse to advance past the earliest frame carrying an unapplied op.
    const probe = reduceInto(baseDoc, existing?.state ?? null, frames)
    const safeSeq = this.appliedContiguousSeq(frames, probe.engine.vv, targetSeq, coveredSeq)
    if (safeSeq <= coveredSeq) {
      // The boundary op itself is a gap — nothing new can be safely folded in yet.
      // Leave the whole tail durable (it is the proof of the buffered op) and only
      // re-attempt the idempotent prune of the already-covered prefix.
      return this.reattemptPrune(docId, coveredSeq)
    }
    // Persist the reduction of ONLY the proven-applied prefix. When the whole tail
    // applied cleanly (`safeSeq === targetSeq`, the common case) reuse the probe;
    // otherwise re-reduce the prefix so the persisted state stops exactly at the
    // proven-applied boundary and the unapplied tail is re-reduced next time (once
    // its missing lower-`s` frame lands).
    const { doc, engine } =
      safeSeq === targetSeq
        ? probe
        : reduceInto(baseDoc, existing?.state ?? null, frames.filter((f) => f.seq <= safeSeq))
    const state = engine.toJSON()

    // Persist doc + state + coverage atomically BEFORE any prune (§7.3).
    const saved = await this.store.saveSnapshot({ docId, coveredSeq: safeSeq, doc, state })
    // Prune with the AUTHORITATIVE post-write coveredSeq the store read back
    // (GREATEST(existing, incoming)), never the raw target: a snapshot may only
    // ever prune the op prefix the persisted doc actually subsumes (XIN-1693 P0-1).
    const prunableSeq = saved.coveredSeq ?? safeSeq
    const freedBytes = await this.store.pruneOpsThrough(docId, prunableSeq)
    return { snapshotVersion: saved.snapshotVersion, coveredSeq: saved.coveredSeq ?? safeSeq, prunedThroughSeq: prunableSeq, freedBytes }
  }

  /**
   * The highest tail seq the reduction PROVABLY applied: `targetSeq` when every op
   * applied, otherwise the highest seq strictly below the earliest frame carrying an
   * unapplied op. An op is applied iff `op.s <= vv[op.a]` (the post-reduction version
   * vector is the per-actor max CONTIGUOUS sequence; a gapped op leaves `vv[a]` below
   * its `s`). `frames` is ascending. Returns `coveredSeq` when even the first tail
   * frame carries an unapplied op (nothing safe to advance). Consulting only the
   * public `vv` keeps the vendored engine untouched (XIN-1772 P0-1).
   */
  private appliedContiguousSeq(
    frames: ReducibleFrame[],
    vv: Record<string, number>,
    targetSeq: number,
    coveredSeq: number,
  ): number {
    const frameApplied = (f: ReducibleFrame): boolean =>
      f.ops.every((o) => typeof o.a === 'string' && typeof o.s === 'number' && o.s <= (vv[o.a] ?? 0))
    let earliestUnapplied = Infinity
    for (const f of frames) {
      if (!frameApplied(f)) {
        earliestUnapplied = f.seq
        break
      }
    }
    if (earliestUnapplied === Infinity) return targetSeq
    let safe = coveredSeq
    for (const f of frames) {
      if (f.seq >= earliestUnapplied) break
      if (f.seq > safe) safe = f.seq
    }
    return safe
  }

  /**
   * Idempotently re-attempt the prune of the op prefix `seq <= coveredSeq`. Used
   * on every no-advance path so a snapshot whose save committed but whose prune did
   * not (separate transactions — a crash/failure between them, P1-2 mode 1) is
   * eventually reclaimed instead of deadlocking the room read-only at its byte cap.
   * Also gives a legacy / version-drifted boundary (P1-2 mode 2) a bounded reclaim
   * of its already-covered prefix. Restart-safe: it re-derives "is there an
   * un-pruned covered row?" from the op table rather than a separate durable
   * cursor, and the store DELETE is a no-op once the prefix is gone — so it is
   * cheap to call repeatedly and never re-prunes the tail above `coveredSeq`.
   */
  private async reattemptPrune(docId: string, coveredSeq: number): Promise<SnapshotRunResult | null> {
    if (coveredSeq <= 0) return null
    // Cheap probe: the single lowest surviving op. If none survive at/below
    // `coveredSeq`, the prune already completed — nothing to do.
    const lowest = await this.store.opsSince(docId, 0, 1)
    if (lowest.length === 0 || lowest[0]!.seq > coveredSeq) return null
    const freedBytes = await this.store.pruneOpsThrough(docId, coveredSeq)
    const snap = await this.store.getSnapshot(docId)
    return {
      snapshotVersion: snap?.snapshotVersion ?? 0,
      coveredSeq,
      prunedThroughSeq: coveredSeq,
      freedBytes,
    }
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
