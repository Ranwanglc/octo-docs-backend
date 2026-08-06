/**
 * `ppt_collab_op` — durable Bento op frames for the PPT relay (R4-B1, §7.3).
 *
 * Each accepted `ops` frame is one row, addressed by the MONOTONIC per-room
 * sequence `(doc_id, seq)`. The relay's durability contract lives here: a frame
 * is committed to this table BEFORE it is acked to the sender or broadcast to
 * peers, and `UNIQUE (doc_id, frame_id)` makes a resent frame a no-op that
 * re-acks its original seq instead of inserting a duplicate.
 *
 * Sequence assignment is serialized per room: {@link appendTx} takes a row lock
 * on the room's current max seq (`SELECT ... FOR UPDATE`) inside the caller's
 * transaction, so two concurrent writers cannot mint the same seq. This is the
 * intended shape for a relay — one authoritative op order per room.
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

  /** Current max seq for the room under a row lock (0 when empty), tx-scoped. */
  async maxSeqForUpdateTx(tx: Tx, docId: string): Promise<number> {
    const rows = await tx.query<{ max_seq: number | null }>(
      `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM ppt_collab_op WHERE doc_id = ? FOR UPDATE`,
      [docId],
    )
    return rows[0] ? Number(rows[0].max_seq ?? 0) : 0
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

  /** Highest assigned seq for the room (0 when none). */
  async maxSeq(docId: string): Promise<number> {
    const rows = await query<{ max_seq: number | null }>(
      `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM ppt_collab_op WHERE doc_id = ?`,
      [docId],
    )
    return rows[0] ? Number(rows[0].max_seq ?? 0) : 0
  },

  /** Delete ops with `seq <= coveredSeq` (post-snapshot GC). */
  async pruneThrough(docId: string, coveredSeq: number): Promise<void> {
    await query(`DELETE FROM ppt_collab_op WHERE doc_id = ? AND seq <= ?`, [docId, coveredSeq])
  },
}
