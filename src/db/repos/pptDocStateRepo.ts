/**
 * `ppt_doc_state` — per-document PPT state that does not belong on the shared
 * `doc_meta` row: the originating `template_id`, the Bento format/sync versions,
 * the draft/live/published counters, and the initial materialized BentoDoc that
 * `POST /api/v1/ppt/docs` mints from a template.
 *
 * R2-B1 writes one row per created deck with `draft_revision = 0` and
 * `snapshot_version = 0` and the freshly instantiated deck as `draft_doc`, so the
 * later source/draft (R2-B2) and live-snapshot/relay (R4) rounds have a concrete
 * baseline to read and advance. Those rounds add their own tables/columns; this
 * table is the create-time home for the deck and its scalar state.
 */
import { query } from '../pool.js'
import { BENTO_FORMAT_VERSION, BENTO_SYNC_V, type BentoDoc } from '../../ppt/bentoDoc.js'

export interface PptDocState {
  docId: string
  templateId: string
  draftRevision: number
  snapshotVersion: number
  publishedVersionSeq: number | null
  pptFormatVersion: number
  bentoSyncPv: number
}

export interface CreatePptDocStateInput {
  docId: string
  templateId: string
  /** The materialized starter deck (already stripped of template/collab). */
  draftDoc: BentoDoc
}

interface PptDocStateRow {
  doc_id: string
  template_id: string
  draft_revision: number
  snapshot_version: number
  published_version_seq: number | null
  ppt_format_version: number
  bento_sync_pv: number
}

function toState(row: PptDocStateRow): PptDocState {
  return {
    docId: row.doc_id,
    templateId: row.template_id,
    draftRevision: row.draft_revision,
    snapshotVersion: row.snapshot_version,
    publishedVersionSeq: row.published_version_seq,
    pptFormatVersion: row.ppt_format_version,
    bentoSyncPv: row.bento_sync_pv,
  }
}

export const pptDocStateRepo = {
  /**
   * Insert the create-time state row for a freshly minted PPT deck. `draft_doc`
   * carries the materialized BentoDoc; counters start at 0 (no draft saved, no
   * live snapshot, nothing published yet). One row per doc — the PK is `doc_id`.
   */
  async create(input: CreatePptDocStateInput): Promise<void> {
    await query(
      `INSERT INTO ppt_doc_state
         (doc_id, template_id, draft_revision, snapshot_version, published_version_seq,
          ppt_format_version, bento_sync_pv, draft_doc)
       VALUES (?, ?, 0, 0, NULL, ?, ?, ?)`,
      [
        input.docId,
        input.templateId,
        BENTO_FORMAT_VERSION,
        BENTO_SYNC_V,
        JSON.stringify(input.draftDoc),
      ],
    )
  },

  /** Fetch the scalar state for a doc (without the potentially large deck blob). */
  async getByDocId(docId: string): Promise<PptDocState | null> {
    const rows = await query<PptDocStateRow>(
      `SELECT doc_id, template_id, draft_revision, snapshot_version, published_version_seq,
              ppt_format_version, bento_sync_pv
         FROM ppt_doc_state
        WHERE doc_id = ?`,
      [docId],
    )
    return rows[0] ? toState(rows[0]) : null
  },
}
