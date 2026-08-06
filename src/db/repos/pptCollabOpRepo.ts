/**
 * `ppt_collab_op` — durable Bento op frames for the PPT relay (R4-B1, §7.3).
 *
 * Each accepted `ops` frame is one row, addressed by the MONOTONIC per-room
 * sequence `(doc_id, seq)`. The relay's durability contract lives here: a frame
 * is committed to this table BEFORE it is acked to the sender or broadcast to
 * peers, and `UNIQUE (doc_id, frame_id)` makes a resent frame a no-op that
 * re-acks its original seq instead of inserting a duplicate.
 *
 * Sequence assignment is NOT derived from this table's `MAX(seq)` — that scheme
 * both races on a brand-new room (no row to lock) and regresses after a
 * full-coverage prune empties the table. The authoritative monotonic counter
 * lives in {@link ../repos/pptRelaySeqRepo} (`ppt_collab_seq`); this table only
 * stores the frames at the seqs that counter hands out.
 */
import { query, type Tx } from '../pool.js'

export interface PptCollabOpRow {
  seq: number
  frameId: string
  frame: unknown
}

interface RawRow {
  seq: number
  frame_id: string
  frame_json: string
}

function toOp(row: RawRow): PptCollabOpRow {
  const raw = row.frame_json
  return {
    seq: Number(row.seq),
    frameId: row.frame_id,
    frame: typeof raw === 'string' ? (JSON.parse(raw) as unknown) : (raw as unknown),
  }
}

export const pptCollabOpRepo = {
  /** Seq already assigned to this frame id, or null if unseen (tx-scoped). */
  async getSeqByFrameIdTx(tx: Tx, docId: string, frameId: string): Promise<number | null> {
    const rows = await tx.query<{ seq: number }>(
      `SELECT seq FROM ppt_collab_op WHERE doc_id = ? AND frame_id = ?`,
      [docId, frameId],
    )
    return rows[0] ? Number(rows[0].seq) : null
  },

  /**
   * Locking twin of {@link getSeqByFrameIdTx} used on the duplicate-frame retry
   * path. A locking read (`FOR UPDATE`) reads the LATEST committed row rather than
   * the transaction's start-of-tx snapshot, so after a concurrent resend of the
   * same frameId loses the `(doc_id, frame_id)` unique-key race we can still read
   * the winner's assigned seq and re-ack it as a duplicate.
   */
  async getSeqByFrameIdForUpdateTx(tx: Tx, docId: string, frameId: string): Promise<number | null> {
    const rows = await tx.query<{ seq: number }>(
      `SELECT seq FROM ppt_collab_op WHERE doc_id = ? AND frame_id = ? FOR UPDATE`,
      [docId, frameId],
    )
    return rows[0] ? Number(rows[0].seq) : null
  },

  /** Insert one op frame at an already-computed seq (tx-scoped). */
  async insertTx(
    tx: Tx,
    docId: string,
    seq: number,
    frameId: string,
    frameJson: string,
    frameBytes: number,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO ppt_collab_op (doc_id, seq, frame_id, frame_json, frame_bytes)
       VALUES (?, ?, ?, ?, ?)`,
      [docId, seq, frameId, frameJson, frameBytes],
    )
  },

  /** Ops with `seq > sinceSeq`, ascending (replay). */
  async since(docId: string, sinceSeq: number): Promise<PptCollabOpRow[]> {
    const rows = await query<RawRow>(
      `SELECT seq, frame_id, frame_json FROM ppt_collab_op
        WHERE doc_id = ? AND seq > ? ORDER BY seq ASC`,
      [docId, sinceSeq],
    )
    return rows.map(toOp)
  },

  /**
   * Highest seq still PRESENT in this table (0 when none). This is NOT the
   * room's authoritative high-water — a prune drops rows so this can regress;
   * {@link ../repos/pptRelaySeqRepo.currentSeq} is the monotonic high-water. Kept
   * only for diagnostics / tests.
   */
  async maxSeq(docId: string): Promise<number> {
    const rows = await query<{ max_seq: number | null }>(
      `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM ppt_collab_op WHERE doc_id = ?`,
      [docId],
    )
    return rows[0] ? Number(rows[0].max_seq ?? 0) : 0
  },

  /** Sum of `frame_bytes` for the ops still present (room-budget accounting). */
  async sumFrameBytes(docId: string): Promise<number> {
    const rows = await query<{ total: number | null }>(
      `SELECT COALESCE(SUM(frame_bytes), 0) AS total FROM ppt_collab_op WHERE doc_id = ?`,
      [docId],
    )
    return rows[0] ? Number(rows[0].total ?? 0) : 0
  },

  /**
   * Delete ops with `seq <= coveredSeq` (post-snapshot GC) and return the number
   * of `frame_bytes` reclaimed, so the relay's in-memory room-budget counter can
   * be decremented in step with the durable delete.
   */
  async pruneThrough(docId: string, coveredSeq: number): Promise<number> {
    const rows = await query<{ freed: number | null }>(
      `SELECT COALESCE(SUM(frame_bytes), 0) AS freed FROM ppt_collab_op WHERE doc_id = ? AND seq <= ?`,
      [docId, coveredSeq],
    )
    const freed = rows[0] ? Number(rows[0].freed ?? 0) : 0
    await query(`DELETE FROM ppt_collab_op WHERE doc_id = ? AND seq <= ?`, [docId, coveredSeq])
    return freed
  },
}
