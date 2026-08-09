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
 * How far (in room seqs) the un-materialized op tail may grow above the covered
 * watermark before a permanently-buffered op is AGED OUT to unfreeze GC (XIN-1792
 * P1-3). A wire-legal `set`/`txt`/`ord` op against an element that NO `ins` in the
 * entire durable log ever creates parks in the engine's `pending` buffer forever;
 * `reduceProving` then never advances the covered watermark past it, so `coveredSeq`
 * pins at its old value, nothing prunes, `roomBytes` climbs to the hard cap, and the
 * room bricks read-only with a PERMANENT `room-full`. This bound trades that
 * permanent brick for a bounded, audited drop: once the frozen tail grows past this
 * many seqs the buffered op is not fillable by anything ALREADY durable (the whole
 * tail was just reduced and it is still parked), so the snapshotter persists the
 * whole-tail materialized `(doc, state)` — which excludes the buffered ops — and
 * prunes through it, escalating what was dropped on the operational channel.
 *
 * RESIDUAL, stated honestly (XIN-1800 P1-2): "not fillable by anything ALREADY
 * durable" is NOT "not fillable by a FUTURE durable op". The engine buffers a missing
 * dependency in `pending`/`gap` precisely so a later op can drain it (crdt.ts). A
 * dropped op whose dependency arrives LATER — e.g. a peer's offline `ins` for the
 * referenced element, flushed after this drop — will be applied by live peers that
 * still hold it but never by the server or a future joiner, a silent divergence this
 * bound does NOT detect. The drop is therefore a bounded, best-effort HEURISTIC, not a
 * proof of unfillability; it is strictly better than a permanent brick but the
 * residual is real. The lag is sized far above any legitimate cross-actor out-of-order
 * window (a peer's `ins` for a referenced element lands within a handful of ops in
 * room order), so a genuine transient buffer is never aged — but a truly delayed
 * dependency past the cap is dropped, which is why the drop is escalated for
 * reconciliation/alerting (see {@link AgedOpDropHandler}).
 */
export const DEFAULT_MAX_BUFFERED_OP_LAG = 4096

/**
 * One permanently-buffered op aged out of a room to unfreeze GC (XIN-1800 P1-2).
 * `a`/`s` identify the dropped op's actor + per-actor sequence so a downstream
 * handler can persist it for later reconciliation or alert on the divergence.
 */
export interface AgedOpDrop {
  a: string
  s: number
}

/**
 * Operational escalation for aged-out ops (XIN-1800 P1-2). The aging path can drop an
 * op that a FUTURE durable op would have filled (see {@link DEFAULT_MAX_BUFFERED_OP_LAG}
 * residual), diverging the server from live peers with no in-band signal — so the drop
 * must reach an operational surface, NOT just `console.warn`. Production wires this to
 * structured logging + a metric/alert and MAY additionally persist the `(a,s)` pairs
 * durably for reconciliation; the snapshotter stays storage-agnostic by taking this
 * callback rather than owning an audit table. Called synchronously inside the room
 * chain AFTER the compacting snapshot + prune committed; a throw is swallowed so a
 * logging/alerting failure can never abort GC (the room must not re-brick because the
 * alert sink was down).
 */
export type AgedOpDropHandler = (event: {
  docId: string
  /** Room seq the compacting snapshot was persisted at. */
  targetSeq: number
  /** Frozen-tail lag (seqs) at the drop. */
  bufferedLag: number
  /** The seq-lag age-out cap ({@link DEFAULT_MAX_BUFFERED_OP_LAG}). */
  lagCap: number
  /**
   * What forced the age-out (XIN-1819 B1):
   *   • `'seq-lag'`     — the frozen tail grew past `lagCap` seqs.
   *   • `'byte-budget'` — a forced (`room-full`) snapshot could not advance because the
   *                       tail is ghost-pinned and the room is at/over its byte budget,
   *                       so the op was aged out BELOW the lag cap to keep the room from
   *                       bricking read-only. `bufferedLag < lagCap` on this path.
   */
  trigger: 'seq-lag' | 'byte-budget'
  /** The dropped ops' `(actor, s)` identities. */
  dropped: AgedOpDrop[]
}) => void

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
/**
 * Seed a fresh reduction engine + doc from a base. `baseState === null` is genesis:
 * seed positions from the base deck's array order via `adopt` (the SAME seeding the
 * frontend performs on a never-synced deck). A non-null `baseState` restores the
 * engine verbatim. Neither input is mutated — both are cloned first.
 */
function seedReduction(
  baseDoc: BentoDoc,
  baseState: SyncStateJSON | null,
): { doc: BentoDoc; engine: SyncState } {
  const doc = clone(baseDoc)
  let engine: SyncState
  if (baseState) {
    engine = SyncState.fromJSON(SNAPSHOT_REDUCER_ACTOR, clone(baseState))
  } else {
    engine = new SyncState(SNAPSHOT_REDUCER_ACTOR)
    engine.adopt(doc)
  }
  return { doc, engine }
}

function reduceInto(
  baseDoc: BentoDoc,
  baseState: SyncStateJSON | null,
  frames: ReducibleFrame[],
): { doc: BentoDoc; engine: SyncState } {
  const { doc, engine } = seedReduction(baseDoc, baseState)
  // Ascending seq is the room's authoritative total order; the CRDT converges
  // regardless of interleaving, but applying in room order keeps a snapshot's
  // materialized array order deterministic and matches the frontend's live apply.
  const ordered = [...frames].sort((a, b) => a.seq - b.seq)
  for (const f of ordered) engine.apply(doc, f.ops)
  return { doc, engine }
}

/**
 * The result of a materialization-proving reduction: the doc + engine after the
 * WHOLE tail, plus `provenSeq` — the highest frame seq at which the running
 * reduction held ZERO buffered ops ({@link SyncEngine.bufferedOps} empty).
 */
export interface ProvingReduction {
  doc: BentoDoc
  engine: SyncState
  provenSeq: number
}

/**
 * Reduce `baseDoc` + `baseState` through `frames` (ascending seq) and, at EACH
 * frame boundary, check whether the running reduction has any buffered op (an op
 * accepted by `applyOne` but parked in `gap`/`pending`, which `toJSON()` does NOT
 * serialize). `provenSeq` is the highest boundary that held ZERO buffered ops —
 * the highest prefix whose `(doc, state)` is byte-lossless to persist and whose op
 * log is therefore safe to prune.
 *
 * Because frames are applied in seq order, the engine state after boundary frame
 * `provenSeq` is IDENTICAL to independently reducing only `frames (seq <=
 * provenSeq)` — so the watermark is proven against the SAME artifact that is
 * persisted, not a wider whole-tail probe (XIN-1783 P0-1b). `provenSeq` starts at
 * `coveredSeq`: the base state is buffer-clean by construction (a snapshot is only
 * ever persisted at a proven boundary; legacy/version-drifted states are refused
 * upstream), so the existing boundary is itself proven.
 */
export function reduceProving(
  baseDoc: BentoDoc,
  baseState: SyncStateJSON | null,
  frames: ReducibleFrame[],
  coveredSeq: number,
): ProvingReduction {
  const { doc, engine } = seedReduction(baseDoc, baseState)
  const ordered = [...frames].sort((a, b) => a.seq - b.seq)
  let provenSeq = coveredSeq
  for (const f of ordered) {
    engine.apply(doc, f.ops)
    // An empty buffer set proves every op applied so far materialized into
    // (doc, state); nothing sits in the non-serialized gap/pending buffers, so
    // this prefix survives a snapshot round-trip losslessly.
    if (engine.bufferedOps.length === 0) provenSeq = f.seq
  }
  return { doc, engine, provenSeq }
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
 * The default {@link AgedOpDropHandler}: escalate to `console.warn` so the drop is at
 * least recorded when a deployment wires no richer sink. Production overrides this
 * with a structured-log + metric handler (XIN-1800 P1-2).
 */
export function defaultAgedOpDropHandler(event: {
  docId: string
  targetSeq: number
  bufferedLag: number
  lagCap: number
  trigger: 'seq-lag' | 'byte-budget'
  dropped: AgedOpDrop[]
}): void {
  // eslint-disable-next-line no-console
  console.warn(
    `[ppt-relay] doc ${event.docId}: aged out ${event.dropped.length} permanently-buffered op(s) to unfreeze GC ` +
      `(XIN-1792 P1-3 / XIN-1800 P1-2 / XIN-1819 B1; trigger=${event.trigger}, frozen tail=${event.bufferedLag} seqs, ` +
      `lag cap ${event.lagCap} at seq ${event.targetSeq}); these ops may still be filled by a FUTURE durable dependency ` +
      `on live peers — reconcile/alert: dropped=${JSON.stringify(event.dropped)}`,
  )
}

/**
 * The server-side snapshotter. Constructed once per {@link PptRelay}; every method
 * is invoked from inside the relay's per-room chain, so its store reads and writes
 * are atomic w.r.t. appends and other snapshot jobs on the same room.
 */
export class PptSnapshotter {
  constructor(
    private readonly store: PptRelayStore,
    /** Seq lag above which a permanently-buffered op is aged out (XIN-1792 P1-3). */
    private readonly maxBufferedOpLag: number = DEFAULT_MAX_BUFFERED_OP_LAG,
    /**
     * Operational escalation for aged-out ops (XIN-1800 P1-2). Defaults to a
     * `console.warn` so a deployment that does not wire an alert sink still records
     * the drop; production passes a handler that emits a structured log + metric and
     * MAY persist the `(a,s)` pairs for reconciliation. A throw here is swallowed.
     */
    private readonly onAgedOpDrop: AgedOpDropHandler = defaultAgedOpDropHandler,
  ) {
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
   *
   * `opts.forceUnfreeze` (XIN-1819 B1) is set by the relay's forced (`room-full`)
   * snapshot path: it signals the room is at/over its byte budget and MUST reclaim
   * rather than brick. On that path, if the tail is ghost-pinned (a permanently-
   * buffered op holds `provenSeq` at `coveredSeq`), the buffered op(s) are aged out
   * and the tail pruned REGARDLESS of seq lag — the byte-aware unfreeze trigger. The
   * normal soft-snapshot path leaves `forceUnfreeze` unset, so it still only ages a
   * buffered op once the frozen tail crosses `maxBufferedOpLag`; the materialization
   * durability contract on the non-forced path is unchanged.
   */
  async advance(
    docId: string,
    baseDocProvider: ((docId: string) => Promise<BentoDoc | null>) | undefined,
    opts?: { forceUnfreeze?: boolean },
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
    // Reduce the WHOLE tail once, proving materialization at every frame boundary,
    // and bind the covered watermark to the highest seq the engine PROVABLY
    // materialized INTO THE STATE BEING PERSISTED (XIN-1783 P0-1 — the durability
    // contract, expressed once, here). Two engine buffers hold an accepted-but-not-
    // materialized op and NEITHER is serialized by `toJSON()`:
    //   • `gap`     — an op whose per-actor `s` exceeds the running contiguous seq
    //                 (a lower-`s` frame was refused/rolled back; frames.ts validates
    //                 each `s` only as a bounded positive int, so a gap CAN persist).
    //   • `pending` — an op whose target node does not exist yet (`set`/`txt`/`ord`
    //                 against a not-yet-created element), parked by `applyEffect`.
    // An op in either buffer advances neither the doc nor `toJSON()`, so folding a
    // prefix that still holds one and pruning `<= that prefix` DESTROYS an acked-
    // durable op and diverges the room from peers who applied it live. The previous
    // watermark trusted the version vector (`op.s <= vv[op.a]`) — but `applyOne`
    // advances `vv` BEFORE `applyEffect`, so a `pending`-parked op reads as "applied"
    // (variant a); and it probed the WHOLE-tail vector while persisting a PREFIX
    // reduction, so a gap filled above the boundary marked a frame below it "applied"
    // (variant b). The proof below instead reports `provenSeq` = the highest boundary
    // at which the running reduction held ZERO buffered ops, evaluated against the
    // exact prefix that is persisted. `reduceProving` never advances past a frame
    // with any buffered op, so it is STRUCTURALLY unable to exceed materialization.
    const probe = reduceProving(baseDoc, existing?.state ?? null, frames, coveredSeq)
    const safeSeq = probe.provenSeq
    if (safeSeq <= coveredSeq) {
      // The boundary op itself is still buffered — nothing new can normally be safely
      // folded in yet, so leave the whole tail durable (it is the proof of the
      // buffered op) and only re-attempt the idempotent prune of the already-covered
      // prefix. BUT a GHOST-TARGET op (a wire-legal `set`/`txt`/`ord` against an
      // element no `ins` in the durable log ever creates) parks in `pending` FOREVER,
      // so this branch would otherwise pin `coveredSeq` forever and brick the room
      // read-only at `room-full` (XIN-1792 P1-3). There are TWO age-out triggers:
      //
      //   • SEQ-LAG (XIN-1792 P1-3): once the frozen tail has grown to or past
      //     `maxBufferedOpLag` seqs the buffered op is not fillable by anything ALREADY
      //     durable — the whole tail was just reduced and it is still parked.
      //   • BYTE-BUDGET (XIN-1819 B1): the seq-lag trigger is NOT byte-aware, so a room
      //     that fills its `maxRoomFrameBytes` budget while the frozen tail is still
      //     BELOW `maxBufferedOpLag` (≈51 large 1.9 MB frames reach a 96 MiB cap far
      //     below the 4096-seq cap) would brick read-only PERMANENTLY: every forced
      //     `room-full` snapshot re-enters this branch, `reattemptPrune` reclaims
      //     nothing (the covered prefix is already gone), and the room refuses writes
      //     for every participant. The relay's forced (`room-full`) path therefore sets
      //     `opts.forceUnfreeze`, signalling the room is at/over its byte budget and
      //     MUST reclaim: on that path a ghost-pinned tail is aged out regardless of
      //     seq lag. The soft-snapshot path never sets it, so the normal materialization
      //     durability contract (age only past the lag cap) is unchanged.
      //
      // Either way: persist the whole-tail materialized `(doc, state)` (which excludes
      // the buffered ops) at `targetSeq` and prune through it, ESCALATING what was
      // dropped on the operational channel. This bounds a permanent brick to a bounded
      // drop. RESIDUAL (XIN-1800 P1-2): "not fillable by anything ALREADY durable" is
      // NOT "unfillable by a FUTURE durable op" — a delayed dependency arriving after
      // the drop is applied by live peers but never the server, a silent divergence
      // this heuristic does not detect. That is why the drop is escalated, not merely
      // `console.warn`-ed, so a handler can persist the `(a,s)` pairs / alert.
      const bufferedLag = highWater - coveredSeq
      const lagAged = bufferedLag >= this.maxBufferedOpLag
      const byteAged = opts?.forceUnfreeze === true
      if (probe.engine.bufferedOps.length > 0 && (lagAged || byteAged)) {
        const dropped: AgedOpDrop[] = probe.engine.bufferedOps.map((o) => ({ a: o.a, s: o.s }))
        const trigger: 'seq-lag' | 'byte-budget' = lagAged ? 'seq-lag' : 'byte-budget'
        const doc = probe.doc
        const state = probe.engine.toJSON()
        const saved = await this.store.saveSnapshot({ docId, coveredSeq: targetSeq, doc, state })
        const prunableSeq = saved.coveredSeq ?? targetSeq
        const freedBytes = await this.store.pruneOpsThrough(docId, prunableSeq)
        // Escalate AFTER the compacting snapshot + prune committed, so the room is
        // already unfrozen even if the sink throws (swallowed — GC must never re-brick
        // because the alert channel was down).
        try {
          this.onAgedOpDrop({ docId, targetSeq: prunableSeq, bufferedLag, lagCap: this.maxBufferedOpLag, trigger, dropped })
        } catch {
          /* an operational-escalation failure must not abort GC */
        }
        return { snapshotVersion: saved.snapshotVersion, coveredSeq: saved.coveredSeq ?? targetSeq, prunedThroughSeq: prunableSeq, freedBytes }
      }
      return this.reattemptPrune(docId, coveredSeq)
    }
    // Persist the reduction of ONLY the proven-materialized prefix. When the whole
    // tail materialized cleanly (`safeSeq === targetSeq`, the common single-author
    // case) reuse the probe's doc/engine — after the last frame the engine holds no
    // buffered op, so its `(doc, state)` IS the prefix reduction. Otherwise re-reduce
    // the prefix so the persisted state stops exactly at the proven-materialized
    // boundary and the unmaterialized tail is re-reduced next time (once its missing
    // dependency lands).
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
