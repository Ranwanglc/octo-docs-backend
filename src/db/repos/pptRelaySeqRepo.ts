/**
 * `ppt_collab_seq` — durable per-room op-sequence counter for the PPT relay
 * (R4-B1, §7.3).
 *
 * This is the AUTHORITATIVE source of the monotonic per-room `seq`, deliberately
 * decoupled from `ppt_collab_op`'s contents. The relay allocates the next seq by
 * atomically incrementing this row INSIDE the append transaction, which fixes two
 * defects a `MAX(seq)+1`-over-the-op-table scheme could not:
 *
 *  - First-concurrent-append race: a brand-new room has a counter row to lock (or
 *    to serialize on via the primary-key insert), so two first writers cannot both
 *    mint `seq=1` and have one insert permanently refused on the `(doc_id, seq)` PK.
 *  - Sequence regression after prune: a full-coverage snapshot empties
 *    `ppt_collab_op`, but `last_seq` never regresses, so a reused seq can never be
 *    minted (which would silently drop the op on replay).
 */
import { query, type Tx } from '../pool.js'

export const pptRelaySeqRepo = {
  /**
   * Allocate and return the next room sequence, atomically, inside the caller's
   * transaction. INSERT-or-increment on the single `(doc_id)` row: the INSERT
   * (new room) or the ON DUPLICATE KEY UPDATE (existing room) takes an exclusive
   * lock on that row, so concurrent allocators for the same doc serialize and
   * each receives a strictly greater value. `LAST_INSERT_ID(expr)` records the
   * assigned value on the session so it can be read back on the SAME connection
   * without a second locking read.
   */
  async nextSeqTx(tx: Tx, docId: string): Promise<number> {
    await tx.query(
      `INSERT INTO ppt_collab_seq (doc_id, last_seq) VALUES (?, LAST_INSERT_ID(1))
       ON DUPLICATE KEY UPDATE last_seq = LAST_INSERT_ID(last_seq + 1)`,
      [docId],
    )
    const rows = await tx.query<{ seq: number }>(`SELECT LAST_INSERT_ID() AS seq`)
    return rows[0] ? Number(rows[0].seq) : 0
  },

  /** Highest seq ever assigned for the room (0 when the room has none yet). */
  async currentSeq(docId: string): Promise<number> {
    const rows = await query<{ last_seq: number | null }>(
      `SELECT last_seq FROM ppt_collab_seq WHERE doc_id = ?`,
      [docId],
    )
    return rows[0] ? Number(rows[0].last_seq ?? 0) : 0
  },

  /**
   * Highest seq ever assigned for the room, read INSIDE the caller's transaction
   * so it shares one consistent snapshot with the other replay reads (P1-4).
   */
  async currentSeqTx(tx: Tx, docId: string): Promise<number> {
    const rows = await tx.query<{ last_seq: number | null }>(
      `SELECT last_seq FROM ppt_collab_seq WHERE doc_id = ?`,
      [docId],
    )
    return rows[0] ? Number(rows[0].last_seq ?? 0) : 0
  },
}
