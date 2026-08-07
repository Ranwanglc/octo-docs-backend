/**
 * `ppt_collab_frame` — durable dedup authority for the PPT relay (R4-B1, §7.3).
 *
 * Maps `(doc_id, frame_id) -> seq` and is written at APPEND time (not copied at
 * prune), with `(doc_id, frame_id)` as its PRIMARY KEY. That makes the ledger the
 * single dedup authority for a room, and it is what closes the two round-4
 * durability defects the reviewers found in `DbPptRelayStore.appendOp`:
 *
 *  - The old append deduped by reading `ppt_collab_op` (and a prune-populated
 *    ledger) with NON-locking `SELECT`s. Under REPEATABLE READ those are snapshot
 *    reads: a resend whose transaction opened BEFORE the original append committed
 *    saw neither row, minted a fresh seq, and rebroadcast a duplicate — permanent
 *    peer divergence for an `ins`/`txt` RGA op. Writing the mapping here at append
 *    time and letting the PRIMARY KEY raise `ER_DUP_ENTRY` turns dedup into a
 *    CURRENT read (the uniqueness check sees committed rows regardless of the
 *    transaction snapshot); the duplicate branch then re-acks the original seq via
 *    a LOCKING read ({@link getSeqByFrameIdForUpdateTx}), which reads the latest
 *    committed value rather than the stale snapshot.
 *  - Because the ledger no longer has to be COPIED from `ppt_collab_op` at prune
 *    time, `pruneOpsThrough` reverts to a plain `DELETE` (no `INSERT … SELECT` that
 *    took shared next-key locks over the gap above `coveredSeq` and blocked a
 *    concurrent append there into `ER_LOCK_WAIT_TIMEOUT`).
 *
 * The mapping OUTLIVES the op row: a snapshot prunes `ppt_collab_op` but never this
 * ledger, so a re-send of a pruned frame still re-acks its original seq instead of
 * being minted a fresh one and rebroadcast as a duplicate the snapshot already
 * subsumes (XIN-1655 C1).
 */
import { query, type Tx } from '../pool.js'

export const pptCollabFrameRepo = {
  /**
   * Seq recorded for this frame id, or null if unseen. Non-transactional current
   * read used by the relay's pre-gate dedup lookup so a known-duplicate resend
   * bypasses the room-full/rate gates and re-acks its original seq rather than
   * being permanently refused (XIN-1660 D3).
   */
  async getByFrameId(docId: string, frameId: string): Promise<{ seq: number; payloadHash: string | null } | null> {
    const rows = await query<{ seq: number; payload_hash?: string | null }>(
      `SELECT seq, payload_hash FROM ppt_collab_frame WHERE doc_id = ? AND frame_id = ?`,
      [docId, frameId],
    )
    return rows[0] ? { seq: Number(rows[0].seq), payloadHash: rows[0].payload_hash ?? null } : null
  },

  async getSeqByFrameId(docId: string, frameId: string): Promise<number | null> {
    const row = await this.getByFrameId(docId, frameId)
    return row?.seq ?? null
  },

  /**
   * Seq recorded for this frame id (tx-scoped, NON-locking), or null if unseen.
   * The append fast-path: a resend whose ledger row is already committed AND
   * visible in this transaction's snapshot re-acks without allocating (and
   * burning) a fresh seq. It is NOT the dedup authority for the concurrent-resend
   * race — that is the PRIMARY-KEY insert below — so a snapshot miss here is
   * still caught by {@link insertTx}'s `ER_DUP_ENTRY`.
   */
  async getByFrameIdTx(tx: Tx, docId: string, frameId: string): Promise<{ seq: number; payloadHash: string | null } | null> {
    const rows = await tx.query<{ seq: number; payload_hash?: string | null }>(
      `SELECT seq, payload_hash FROM ppt_collab_frame WHERE doc_id = ? AND frame_id = ?`,
      [docId, frameId],
    )
    return rows[0] ? { seq: Number(rows[0].seq), payloadHash: rows[0].payload_hash ?? null } : null
  },

  async getSeqByFrameIdTx(tx: Tx, docId: string, frameId: string): Promise<number | null> {
    const row = await this.getByFrameIdTx(tx, docId, frameId)
    return row?.seq ?? null
  },

  /**
   * Locking twin of {@link getSeqByFrameIdTx}, used on the duplicate-frame retry
   * path. A `FOR UPDATE` read returns the LATEST committed row rather than the
   * transaction's start snapshot, so after a concurrent resend loses the
   * `(doc_id, frame_id)` PRIMARY-KEY race we can still read the winner's assigned
   * seq and re-ack it as a duplicate instead of surfacing `storage-failed`.
   */
  async getByFrameIdForUpdateTx(tx: Tx, docId: string, frameId: string): Promise<{ seq: number; payloadHash: string | null } | null> {
    const rows = await tx.query<{ seq: number; payload_hash?: string | null }>(
      `SELECT seq, payload_hash FROM ppt_collab_frame WHERE doc_id = ? AND frame_id = ? FOR UPDATE`,
      [docId, frameId],
    )
    return rows[0] ? { seq: Number(rows[0].seq), payloadHash: rows[0].payload_hash ?? null } : null
  },

  async getSeqByFrameIdForUpdateTx(tx: Tx, docId: string, frameId: string): Promise<number | null> {
    const row = await this.getByFrameIdForUpdateTx(tx, docId, frameId)
    return row?.seq ?? null
  },

  /**
   * Record the `(doc_id, frame_id) -> seq` mapping at append time. The PRIMARY KEY
   * `(doc_id, frame_id)` is the dedup authority: a second insert for the same
   * frame raises `ER_DUP_ENTRY`, which the caller catches to re-ack the original
   * seq. Runs inside the caller's append transaction.
   */
  async insertTx(tx: Tx, docId: string, frameId: string, seq: number, payloadHash: string): Promise<void> {
    await tx.query(
      `INSERT INTO ppt_collab_frame (doc_id, frame_id, seq, payload_hash) VALUES (?, ?, ?, ?)`,
      [docId, frameId, seq, payloadHash],
    )
  },

  /**
   * Repoint an existing ledger row at `seq`. Used only on the P1-1(b) op-table
   * duplicate-key reconciliation path: the append inserted a fresh ledger row at a
   * newly-allocated seq, then discovered a pre-upgrade op row already holds the
   * frame at its ORIGINAL seq. We repoint the ledger to that original seq so a
   * later resend re-acks the same seq the op is actually stored at (the freshly
   * allocated seq is burned — seq gaps are legal on the wire, §7.3 / P2-d).
   */
  async updateSeqTx(tx: Tx, docId: string, frameId: string, seq: number): Promise<void> {
    await tx.query(
      `UPDATE ppt_collab_frame SET seq = ? WHERE doc_id = ? AND frame_id = ?`,
      [seq, docId, frameId],
    )
  },
}
