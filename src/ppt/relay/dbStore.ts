/**
 * MySQL-backed {@link PptRelayStore} (R4-B1, §7.3).
 *
 * Wires the relay's durability contract onto `ppt_collab_op` +
 * `ppt_live_snapshot`:
 *  - `appendOp` runs in a transaction: it dedups on `(doc_id, frame_id)`, takes
 *    a row lock on the room's max seq, assigns `maxSeq + 1`, and inserts — so a
 *    committed row (and its ack) always reflects a monotonic, gap-free order and
 *    a resent frame re-acks its original seq without a second row.
 *  - `saveSnapshot` advances `snapshot_version` under a row lock atomically.
 *  - `pruneOpsThrough` runs only AFTER `saveSnapshot` has committed (the relay
 *    engine sequences these two calls), matching "GC only after a durable
 *    snapshot".
 */
import { transaction } from '../../db/pool.js'
import { pptCollabOpRepo } from '../../db/repos/pptCollabOpRepo.js'
import { pptLiveSnapshotRepo } from '../../db/repos/pptLiveSnapshotRepo.js'
import type {
  AppendOpResult,
  PersistedOp,
  PptRelayStore,
  RelaySnapshot,
  SaveSnapshotInput,
  SaveSnapshotResult,
} from './store.js'

export class DbPptRelayStore implements PptRelayStore {
  async appendOp(docId: string, frameId: string, frame: unknown): Promise<AppendOpResult> {
    const frameJson = JSON.stringify(frame)
    const frameBytes = Buffer.byteLength(frameJson, 'utf8')
    return transaction(async (tx) => {
      const existing = await pptCollabOpRepo.getSeqByFrameIdTx(tx, docId, frameId)
      if (existing !== null) return { seq: existing, duplicate: true }
      const maxSeq = await pptCollabOpRepo.maxSeqForUpdateTx(tx, docId)
      const seq = maxSeq + 1
      await pptCollabOpRepo.insertTx(tx, docId, seq, frameId, frameJson, frameBytes)
      return { seq, duplicate: false }
    })
  }

  async opsSince(docId: string, sinceSeq: number): Promise<PersistedOp[]> {
    const ops = await pptCollabOpRepo.since(docId, sinceSeq)
    return ops.map((o) => ({ seq: o.seq, frameId: o.frameId, frame: o.frame }))
  }

  async currentSeq(docId: string): Promise<number> {
    return pptCollabOpRepo.maxSeq(docId)
  }

  async getSnapshot(docId: string): Promise<RelaySnapshot | null> {
    const snap = await pptLiveSnapshotRepo.get(docId)
    if (!snap) return null
    return { snapshotVersion: snap.snapshotVersion, coveredSeq: snap.coveredSeq, doc: snap.doc }
  }

  async saveSnapshot(input: SaveSnapshotInput): Promise<SaveSnapshotResult> {
    return transaction(async (tx) => {
      const current = await pptLiveSnapshotRepo.versionForUpdateTx(tx, input.docId)
      const snapshotVersion = current + 1
      await pptLiveSnapshotRepo.upsertTx(tx, input.docId, snapshotVersion, input.coveredSeq, input.doc)
      return { snapshotVersion }
    })
  }

  async pruneOpsThrough(docId: string, coveredSeq: number): Promise<void> {
    await pptCollabOpRepo.pruneThrough(docId, coveredSeq)
  }
}
