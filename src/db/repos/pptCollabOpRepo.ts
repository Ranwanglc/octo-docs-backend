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
 *
 * Idempotent-resend dedup is owned by the durable ledger `ppt_collab_frame` (see
 * {@link ../repos/pptCollabFrameRepo}), which is written at APPEND time and
 * OUTLIVES this table's rows. A snapshot prunes covered ops from here with a plain
 * `DELETE` (see {@link pruneThroughTx}); the mapping a resent frame needs to re-ack
 * its original seq survives in that ledger, never in this table.
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

  /**
   * Ops with `seq > sinceSeq`, ascending (replay). When `limit` is given, at most
   * `limit` rows are returned (the next page starts at the last returned seq), so a
   * huge op backlog is streamed in bounded batches on replay rather than read
   * unbounded into memory (XIN-1660 hardening).
   */
  async since(docId: string, sinceSeq: number, limit?: number): Promise<PptCollabOpRow[]> {
    if (limit !== undefined && limit >= 0) {
      const rows = await query<RawRow>(
        `SELECT seq, frame_id, frame_json FROM ppt_collab_op
          WHERE doc_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
        [docId, sinceSeq, limit],
      )
      return rows.map(toOp)
    }
    const rows = await query<RawRow>(
      `SELECT seq, frame_id, frame_json FROM ppt_collab_op
        WHERE doc_id = ? AND seq > ? ORDER BY seq ASC`,
      [docId, sinceSeq],
    )
    return rows.map(toOp)
  },

  /**
   * Ops with `seq > sinceSeq`, ascending, INSIDE the caller's transaction so the
   * read shares one consistent snapshot with the other replay reads (P1-4 atomic
   * replay view). Bounded to `limit` rows when given (paged fetch).
   */
  async sinceTx(tx: Tx, docId: string, sinceSeq: number, limit?: number): Promise<PptCollabOpRow[]> {
    if (limit !== undefined && limit >= 0) {
      const rows = await tx.query<RawRow>(
        `SELECT seq, frame_id, frame_json FROM ppt_collab_op
          WHERE doc_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
        [docId, sinceSeq, limit],
      )
      return rows.map(toOp)
    }
    const rows = await tx.query<RawRow>(
      `SELECT seq, frame_id, frame_json FROM ppt_collab_op
        WHERE doc_id = ? AND seq > ? ORDER BY seq ASC`,
      [docId, sinceSeq],
    )
    return rows.map(toOp)
  },

  /**
   * Seq of the row already stored for `(doc_id, frame_id)` under a LOCKING read,
   * or null if unseen. Used on the op-table duplicate-key retry path (P1-1 b): a
   * pre-upgrade op row can exist for a frame that has no dedup-ledger row, so on an
   * `ER_DUP_ENTRY` from the op insert we read the op's ORIGINAL seq here and re-ack
   * it instead of failing permanently.
   */
  async getSeqByFrameIdForUpdateTx(tx: Tx, docId: string, frameId: string): Promise<number | null> {
    const rows = await tx.query<{ seq: number }>(
      `SELECT seq FROM ppt_collab_op WHERE doc_id = ? AND frame_id = ? FOR UPDATE`,
      [docId, frameId],
    )
    return rows[0] ? Number(rows[0].seq) : null
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
   *
   * A plain `DELETE` inside the caller's transaction. Dedup no longer needs a
   * copy-at-prune step — the `ppt_collab_frame` ledger is written at APPEND time
   * and outlives the op row — so this avoids the old `INSERT IGNORE … SELECT`,
   * whose shared next-key locks over the gap ABOVE `coveredSeq` blocked a
   * concurrent append there into `ER_LOCK_WAIT_TIMEOUT` (XIN-1660 D2).
   */
  async pruneThroughTx(tx: Tx, docId: string, coveredSeq: number): Promise<number> {
    const rows = await tx.query<{ freed: number | null }>(
      `SELECT COALESCE(SUM(frame_bytes), 0) AS freed FROM ppt_collab_op WHERE doc_id = ? AND seq <= ?`,
      [docId, coveredSeq],
    )
    const freed = rows[0] ? Number(rows[0].freed ?? 0) : 0
    await tx.query(`DELETE FROM ppt_collab_op WHERE doc_id = ? AND seq <= ?`, [docId, coveredSeq])
    return freed
  },
}
