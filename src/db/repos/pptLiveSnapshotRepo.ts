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

  /** Current version under a row lock (0 when none), tx-scoped. */
  async versionForUpdateTx(tx: Tx, docId: string): Promise<number> {
    const rows = await tx.query<{ snapshot_version: number }>(
      `SELECT snapshot_version FROM ppt_live_snapshot WHERE doc_id = ? FOR UPDATE`,
      [docId],
    )
    return rows[0] ? Number(rows[0].snapshot_version) : 0
  },

  /**
   * Upsert the live snapshot at an already-computed version (tx-scoped). The
   * caller advances `version` under the lock taken by {@link versionForUpdateTx},
   * so the write is atomic w.r.t. concurrent snapshot saves for the same doc.
   */
  async upsertTx(
    tx: Tx,
    docId: string,
    snapshotVersion: number,
    coveredSeq: number,
    doc: BentoDoc,
  ): Promise<void> {
    const docJson = JSON.stringify(doc)
    const sha = createHash('sha256').update(docJson).digest('hex')
    const bytes = Buffer.byteLength(docJson, 'utf8')
    await tx.query(
      `INSERT INTO ppt_live_snapshot (doc_id, snapshot_version, covered_seq, doc_json, doc_sha, doc_bytes)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         snapshot_version = VALUES(snapshot_version),
         covered_seq      = VALUES(covered_seq),
         doc_json         = VALUES(doc_json),
         doc_sha          = VALUES(doc_sha),
         doc_bytes        = VALUES(doc_bytes)`,
      [docId, snapshotVersion, coveredSeq, docJson, sha, bytes],
    )
  },
}
