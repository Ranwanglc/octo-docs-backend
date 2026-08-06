/**
 * MySQL-backed {@link PptRelayStore} (R4-B1, §7.3).
 *
 * Wires the relay's durability contract onto `ppt_collab_op` +
 * `ppt_live_snapshot` + `ppt_collab_seq` + `ppt_collab_frame`:
 *  - `appendOp` runs in a transaction. `ppt_collab_frame` (PK `(doc_id, frame_id)`)
 *    is the dedup AUTHORITY and is written at APPEND time, so dedup is a CURRENT
 *    read (the PRIMARY-KEY uniqueness check sees committed rows regardless of the
 *    transaction snapshot) rather than a REPEATABLE-READ snapshot read. A fast-path
 *    ledger read re-acks a resend already visible in this tx's snapshot without
 *    burning a seq; otherwise the next seq is allocated from the durable per-room
 *    counter (`ppt_collab_seq`, atomic increment under the counter row's lock) and
 *    the ledger row is inserted. If a concurrent resend already claimed the frame,
 *    the ledger insert raises `ER_DUP_ENTRY` and we re-ack the winner's seq via a
 *    LOCKING read (latest committed) — never `storage-failed`. A committed row (and
 *    its ack) therefore reflects a monotonic order that neither races on a room's
 *    first write, nor regresses after a full-coverage prune, nor re-mints a fresh
 *    seq for a frame whose op row was pruned (XIN-1655 C1), nor rebroadcasts a
 *    duplicate on the pre-commit-resend interleaving (XIN-1660 D1).
 *  - `saveSnapshot` advances `snapshot_version` and writes the doc atomically in
 *    one covered-guarded upsert (§7.3).
 *  - `pruneOpsThrough` runs only AFTER `saveSnapshot` has committed (the relay
 *    engine sequences these two calls), matching "GC only after a durable
 *    snapshot". Because the dedup ledger is now written at append time it needs no
 *    copy-at-prune step, so the prune is a plain `DELETE` — no `INSERT … SELECT`
 *    that took shared next-key locks over the gap above `coveredSeq` and blocked a
 *    concurrent append there into `ER_LOCK_WAIT_TIMEOUT` (XIN-1660 D2). It returns
 *    the bytes reclaimed so the relay's room-budget counter stays in step.
 */
import { transaction } from '../../db/pool.js'
import { pptCollabFrameRepo } from '../../db/repos/pptCollabFrameRepo.js'
import { pptCollabOpRepo } from '../../db/repos/pptCollabOpRepo.js'
import { pptLiveSnapshotRepo } from '../../db/repos/pptLiveSnapshotRepo.js'
import { pptRelaySeqRepo } from '../../db/repos/pptRelaySeqRepo.js'
import type {
  AppendOpResult,
  PersistedOp,
  PptRelayStore,
  RelaySnapshot,
  SaveSnapshotInput,
  SaveSnapshotResult,
} from './store.js'

/** MySQL duplicate-key error code (surfaced by mysql2 on a unique/PK conflict). */
function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'ER_DUP_ENTRY'
  )
}

export class DbPptRelayStore implements PptRelayStore {
  async appendOp(docId: string, frameId: string, frame: unknown): Promise<AppendOpResult> {
    const frameJson = JSON.stringify(frame)
    const frameBytes = Buffer.byteLength(frameJson, 'utf8')
    return transaction(async (tx) => {
      // Fast-path: a resend whose ledger row is already committed AND visible in
      // this tx's snapshot re-acks without allocating (burning) a fresh seq. NOT
      // the authority for the concurrent race — the ledger PK insert below is —
      // so a snapshot miss here is still caught by `ER_DUP_ENTRY` (XIN-1660 D1).
      const existing = await pptCollabFrameRepo.getSeqByFrameIdTx(tx, docId, frameId)
      if (existing !== null) return { seq: existing, duplicate: true, frameBytes }
      const seq = await pptRelaySeqRepo.nextSeqTx(tx, docId)
      try {
        // Dedup authority: the `(doc_id, frame_id)` PRIMARY KEY, written at APPEND
        // time so the uniqueness check is a CURRENT read, not a snapshot read.
        await pptCollabFrameRepo.insertTx(tx, docId, frameId, seq)
      } catch (err) {
        // A concurrent resend of the same frameId won the ledger race: re-read the
        // winner's seq (LOCKING read = latest committed) and re-ack it as a
        // duplicate — never a permanent failure, never a re-minted seq.
        if (isDuplicateKeyError(err)) {
          const orig = await pptCollabFrameRepo.getSeqByFrameIdForUpdateTx(tx, docId, frameId)
          if (orig !== null) return { seq: orig, duplicate: true, frameBytes }
        }
        throw err
      }
      await pptCollabOpRepo.insertTx(tx, docId, seq, frameId, frameJson, frameBytes)
      return { seq, duplicate: false, frameBytes }
    })
  }

  /** Seq recorded for a frame id, or null if unseen (pre-gate dedup lookup, D3). */
  async frameSeq(docId: string, frameId: string): Promise<number | null> {
    return pptCollabFrameRepo.getSeqByFrameId(docId, frameId)
  }

  async opsSince(docId: string, sinceSeq: number, limit?: number): Promise<PersistedOp[]> {
    const ops = await pptCollabOpRepo.since(docId, sinceSeq, limit)
    return ops.map((o) => ({ seq: o.seq, frameId: o.frameId, frame: o.frame }))
  }

  async currentSeq(docId: string): Promise<number> {
    // The authoritative high-water is the durable counter, NOT MAX(seq) over the
    // op table (which regresses after a prune empties it).
    return pptRelaySeqRepo.currentSeq(docId)
  }

  async roomBytes(docId: string): Promise<number> {
    return pptCollabOpRepo.sumFrameBytes(docId)
  }

  async getSnapshot(docId: string): Promise<RelaySnapshot | null> {
    const snap = await pptLiveSnapshotRepo.get(docId)
    if (!snap) return null
    return { snapshotVersion: snap.snapshotVersion, coveredSeq: snap.coveredSeq, doc: snap.doc }
  }

  async saveSnapshot(input: SaveSnapshotInput): Promise<SaveSnapshotResult> {
    return transaction(async (tx) => {
      const { snapshotVersion } = await pptLiveSnapshotRepo.upsertAdvanceTx(
        tx,
        input.docId,
        input.coveredSeq,
        input.doc,
      )
      return { snapshotVersion }
    })
  }

  async pruneOpsThrough(docId: string, coveredSeq: number): Promise<number> {
    // The dedup ledger (`ppt_collab_frame`) is written at APPEND time, so a prune
    // no longer has to copy mappings out of `ppt_collab_op` first: it is a plain
    // `DELETE`. Dropping the old `INSERT IGNORE … SELECT` also drops the shared
    // next-key locks it took over the gap above `coveredSeq`, which used to block a
    // concurrent append there into `ER_LOCK_WAIT_TIMEOUT` (XIN-1660 D2).
    return transaction((tx) => pptCollabOpRepo.pruneThroughTx(tx, docId, coveredSeq))
  }
}
