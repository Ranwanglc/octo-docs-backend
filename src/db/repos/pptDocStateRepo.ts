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
import { query, type Tx } from '../pool.js'
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

/** {@link PptDocState} plus the materialized `draft_doc` deck (R3-B1 source read). */
export interface PptDocSource extends PptDocState {
  /** The persisted working deck (materialized from a template at create time). */
  draftDoc: BentoDoc
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

  /**
   * Transaction-scoped twin of {@link create}: insert the PPT state row + starter
   * deck on the tx connection so it participates in the caller's atomic create
   * (rolls back with doc_meta/membership on a partial failure).
   */
  async createTx(tx: Tx, input: CreatePptDocStateInput): Promise<void> {
    await tx.query(
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

  /**
   * Fetch the scalar state PLUS the materialized `draft_doc` deck for source
   * loading (R3-B1). Separate from {@link getByDocId} because the deck blob is
   * large (MEDIUMTEXT) and most callers only need the counters — the source
   * route is the one path that needs the actual bytes.
   *
   * `draft_doc` is persisted as a JSON string (MEDIUMTEXT); it is parsed back to
   * a {@link BentoDoc} here. A row whose stored deck is not valid JSON is a
   * corrupt row, surfaced as a thrown error rather than a silent null so the
   * caller renders a 500 rather than a misleading 404. Returns null only when
   * there is NO state row for the doc.
   */
  async getSource(docId: string): Promise<PptDocSource | null> {
    const rows = await query<PptDocStateRow & { draft_doc: string }>(
      `SELECT doc_id, template_id, draft_revision, snapshot_version, published_version_seq,
              ppt_format_version, bento_sync_pv, draft_doc
         FROM ppt_doc_state
        WHERE doc_id = ?`,
      [docId],
    )
    const row = rows[0]
    if (!row) return null
    // mysql2 returns MEDIUMTEXT as a string; be tolerant of a driver/column that
    // already hands back a parsed object (e.g. a JSON column in a future schema).
    const raw = row.draft_doc
    let draftDoc: BentoDoc
    if (typeof raw === 'string') {
      draftDoc = JSON.parse(raw) as BentoDoc
    } else {
      draftDoc = raw as unknown as BentoDoc
    }
    return { ...toState(row), draftDoc }
  },
}
