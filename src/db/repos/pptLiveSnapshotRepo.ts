/**
 * `ppt_live_snapshot` — authoritative live BentoDoc snapshot per PPT doc
 * (R4-B1, §7.3).
 *
 * One row per doc (PK `doc_id`): the live snapshot is replaced in place, and its
 * `snapshot_version` advances monotonically on each save. `covered_seq` records
 * the `ppt_collab_op` prefix the snapshot subsumes, so the relay prunes ops with
 * `seq <= covered_seq` only AFTER the snapshot row is durable (the atomic
 * advance + then-prune contract). Published, immutable versions are NOT stored
 * here — they live in `ppt_version` (R5).
 */
import { createHash } from 'node:crypto'
import { query, type Tx } from '../pool.js'
import type { BentoDoc } from '../../ppt/bentoDoc.js'

export interface PptLiveSnapshot {
  snapshotVersion: number
  coveredSeq: number
  doc: BentoDoc
}

interface RawRow {
  snapshot_version: number
  covered_seq: number
  doc_json: string
}

export const pptLiveSnapshotRepo = {
  /** Latest live snapshot for the doc, or null when none exists yet. */
  async get(docId: string): Promise<PptLiveSnapshot | null> {
    const rows = await query<RawRow>(
      `SELECT snapshot_version, covered_seq, doc_json FROM ppt_live_snapshot WHERE doc_id = ?`,
      [docId],
    )
    const row = rows[0]
    if (!row) return null
    const raw = row.doc_json
    const doc = typeof raw === 'string' ? (JSON.parse(raw) as BentoDoc) : (raw as unknown as BentoDoc)
    return { snapshotVersion: Number(row.snapshot_version), coveredSeq: Number(row.covered_seq), doc }
  },

  /**
   * Latest live snapshot read INSIDE the caller's transaction, so it shares one
   * consistent snapshot with the other replay reads (P1-4 atomic replay view).
   */
  async getTx(tx: Tx, docId: string): Promise<PptLiveSnapshot | null> {
    const rows = await tx.query<RawRow>(
      `SELECT snapshot_version, covered_seq, doc_json FROM ppt_live_snapshot WHERE doc_id = ?`,
      [docId],
    )
    const row = rows[0]
    if (!row) return null
    const raw = row.doc_json
    const doc = typeof raw === 'string' ? (JSON.parse(raw) as BentoDoc) : (raw as unknown as BentoDoc)
    return { snapshotVersion: Number(row.snapshot_version), coveredSeq: Number(row.covered_seq), doc }
  },

  /**
   * Persist a snapshot AND advance the version ATOMICALLY, in one upsert (§7.3).
   *
   * A single `INSERT ... ON DUPLICATE KEY UPDATE` on the `(doc_id)` row: the
   * INSERT (first snapshot) or the ON DUPLICATE branch (subsequent saves) takes
   * the row's exclusive lock, so two concurrent first savers can no longer both
   * read version 0 and both ack version 1 — they serialize and receive 1 then 2.
   *
   * The write also fails-safe against a covered-seq regression (P0-3): the
   * version, doc, sha and byte columns are only replaced when the incoming
   * `coveredSeq` is >= the stored one, and `covered_seq` moves via `GREATEST`, so
   * `doc_json` and `covered_seq` always advance together — a late snapshot that
   * covers LESS than the current one neither rewinds the coverage nor overwrites
   * the doc with a shorter prefix. The caller reads the authoritative
   * post-write `(snapshot_version, covered_seq)` back on the same connection.
   */
  async upsertAdvanceTx(
    tx: Tx,
    docId: string,
    coveredSeq: number,
    doc: BentoDoc,
  ): Promise<{ snapshotVersion: number; coveredSeq: number }> {
    const docJson = JSON.stringify(doc)
    const sha = createHash('sha256').update(docJson).digest('hex')
    const bytes = Buffer.byteLength(docJson, 'utf8')
    await tx.query(
      `INSERT INTO ppt_live_snapshot (doc_id, snapshot_version, covered_seq, doc_json, doc_sha, doc_bytes)
       VALUES (?, 1, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         snapshot_version = IF(VALUES(covered_seq) >= covered_seq, snapshot_version + 1, snapshot_version),
         doc_json         = IF(VALUES(covered_seq) >= covered_seq, VALUES(doc_json), doc_json),
         doc_sha          = IF(VALUES(covered_seq) >= covered_seq, VALUES(doc_sha), doc_sha),
         doc_bytes        = IF(VALUES(covered_seq) >= covered_seq, VALUES(doc_bytes), doc_bytes),
         covered_seq      = GREATEST(covered_seq, VALUES(covered_seq))`,
      [docId, coveredSeq, docJson, sha, bytes],
    )
    const rows = await tx.query<{ snapshot_version: number; covered_seq: number }>(
      `SELECT snapshot_version, covered_seq FROM ppt_live_snapshot WHERE doc_id = ?`,
      [docId],
    )
    const row = rows[0]
    return {
      snapshotVersion: row ? Number(row.snapshot_version) : 1,
      coveredSeq: row ? Number(row.covered_seq) : coveredSeq,
    }
  },
}
