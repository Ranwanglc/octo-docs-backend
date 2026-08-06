/**
 * MySQL-backed {@link PptRelayStore} (R4-B1, §7.3).
 *
 * Wires the relay's durability contract onto `ppt_collab_op` +
 * `ppt_live_snapshot` + `ppt_collab_seq` + `ppt_collab_frame`:
 *  - `appendOp` runs in a transaction: it dedups on `(doc_id, frame_id)` against
 *    BOTH the live op row and the durable dedup ledger (`ppt_collab_frame`, which
 *    retains the mapping past a prune), allocates the next seq from the durable
 *    per-room counter (`ppt_collab_seq`, atomic increment under the counter row's
 *    lock), and inserts the frame. A committed row (and its ack) therefore always
 *    reflects a monotonic order that neither races on a room's first write, nor
 *    regresses after a full-coverage prune, nor re-mints a fresh seq for a frame
 *    whose op row was already pruned (XIN-1655 C1). A concurrent resend of the
 *    same frameId that loses the `(doc_id, frame_id)` unique-key race is caught
 *    and re-acked at its original seq rather than surfaced as `storage-failed`.
 *  - `saveSnapshot` advances `snapshot_version` and writes the doc atomically in
 *    one covered-guarded upsert (§7.3).
 *  - `pruneOpsThrough` runs only AFTER `saveSnapshot` has committed (the relay
 *    engine sequences these two calls), matching "GC only after a durable
 *    snapshot". It copies each pruned frame's `(frame_id, seq)` into
 *    `ppt_collab_frame` before deleting (one transaction) so dedup survives GC,
 *    and returns the bytes reclaimed so the relay's room-budget counter stays in
 *    step.
 */
import { transaction } from '../../db/pool.js'
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
      const existing = await pptCollabOpRepo.getSeqByFrameIdTx(tx, docId, frameId)
      if (existing !== null) return { seq: existing, duplicate: true, frameBytes }
      // Dedup must survive op-log pruning: a frame whose op row was already pruned
      // by a snapshot still lives in the durable dedup ledger, so re-ack its
      // original seq instead of minting a duplicate (XIN-1655 C1).
      const pruned = await pptCollabOpRepo.getPrunedSeqByFrameIdTx(tx, docId, frameId)
      if (pruned !== null) return { seq: pruned, duplicate: true, frameBytes }
      const seq = await pptRelaySeqRepo.nextSeqTx(tx, docId)
      try {
        await pptCollabOpRepo.insertTx(tx, docId, seq, frameId, frameJson, frameBytes)
      } catch (err) {
        // A concurrent resend of the same frameId lost the `(doc_id, frame_id)`
        // unique-key race: re-read the winner's seq (locking read, latest
        // committed) and re-ack it as a duplicate — never a permanent failure.
        if (isDuplicateKeyError(err)) {
          const orig = await pptCollabOpRepo.getSeqByFrameIdForUpdateTx(tx, docId, frameId)
          if (orig !== null) return { seq: orig, duplicate: true, frameBytes }
        }
        throw err
      }
      return { seq, duplicate: false, frameBytes }
    })
  }

  async opsSince(docId: string, sinceSeq: number): Promise<PersistedOp[]> {
    const ops = await pptCollabOpRepo.since(docId, sinceSeq)
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
    // Copy the pruned frames' `(frame_id, seq)` into the durable dedup ledger and
    // delete them in ONE transaction, so a frame is never delete-visible while
    // still absent from the ledger (which would reopen the C1 duplicate window).
    return transaction((tx) => pptCollabOpRepo.pruneThroughTx(tx, docId, coveredSeq))
  }
}
