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
import type { SyncStateJSON } from '../../ppt/sync/slidesSync.js'

export interface PptLiveSnapshot {
  snapshotVersion: number
  coveredSeq: number
  doc: BentoDoc
  /**
   * Serialized Bento `SyncState` persisted atomically with `doc`/`covered_seq`
   * (XIN-1759 Part B). Null for a legacy row written before the state column
   * existed, or one whose `state_json` is SQL NULL.
   */
  state: SyncStateJSON | null
}

interface RawRow {
  snapshot_version: number
  covered_seq: number
  doc_json: string
  state_json: string | null
}

/**
 * MySQL `MEDIUMTEXT` byte ceiling (2^24 − 1). `doc_json` and `state_json` are
 * `MEDIUMTEXT` (`migrations/schema.sql`), so a serialized value ABOVE this cannot be
 * stored intact: in strict mode the write errors `ER_DATA_TOO_LONG` (not a transient
 * lock error, so `withStoreRetry` rethrows it non-retryably) and, worse, if `sql_mode`
 * omits `STRICT_TRANS_TABLES` MySQL TRUNCATES the value with only a warning, the upsert
 * "succeeds", `covered_seq` advances, and the relay then prunes the op log behind a
 * truncated, unparseable `doc_json` — total, silent loss of the deck (XIN-1821 P1-3).
 * We therefore fail CLOSED in application code BEFORE the write, so neither outcome is
 * reachable regardless of server `sql_mode`.
 */
export const SNAPSHOT_COLUMN_MAX_BYTES = 16_777_215

/**
 * A snapshot whose serialized `doc_json`/`state_json` exceeds the `MEDIUMTEXT` column
 * ceiling. Thrown BEFORE the write so the op log is never pruned behind a value that
 * could not be persisted intact (XIN-1821 P1-3). Non-retryable by construction (it is
 * not a transient lock error), so the relay's forced-snapshot path surfaces it as a
 * permanent `room-full` (the deck is at storage capacity) rather than retrying forever,
 * and the soft path leaves the op log durable. OPERATOR SIGNAL (XIN-1825 P2-7): unlike
 * `ppt_relay_aged_op_drop`, this is NOT yet wired to a structured operator-alert channel
 * — today it is observable only as the `room-full` refusal (forced path) or a
 * `console.warn` (soft path). Wiring it through the same `onAgedOpDrop`-style handler is
 * deferred; the guard's job here is to make the failure LOUD-and-safe (a refusal, never a
 * silent truncate-then-prune), which it does regardless of that channel. When it fires,
 * the deck's materialized state has outgrown the column and needs a schema/segmentation
 * change.
 */
export class SnapshotColumnOverflowError extends Error {
  constructor(
    readonly column: 'doc_json' | 'state_json',
    readonly bytes: number,
  ) {
    super(`ppt_live_snapshot.${column} is ${bytes} bytes, over the ${SNAPSHOT_COLUMN_MAX_BYTES}-byte MEDIUMTEXT ceiling`)
    this.name = 'SnapshotColumnOverflowError'
  }
}

/** Parse a persisted snapshot row (doc + optional state JSON) into the model. */
function rowToSnapshot(row: RawRow): PptLiveSnapshot {
  const rawDoc = row.doc_json
  const doc = typeof rawDoc === 'string' ? (JSON.parse(rawDoc) as BentoDoc) : (rawDoc as unknown as BentoDoc)
  let state: SyncStateJSON | null = null
  const rawState = row.state_json
  if (rawState != null) {
    state = typeof rawState === 'string' ? (JSON.parse(rawState) as SyncStateJSON) : (rawState as unknown as SyncStateJSON)
  }
  return { snapshotVersion: Number(row.snapshot_version), coveredSeq: Number(row.covered_seq), doc, state }
}

export const pptLiveSnapshotRepo = {
  /** Latest live snapshot for the doc, or null when none exists yet. */
  async get(docId: string): Promise<PptLiveSnapshot | null> {
    const rows = await query<RawRow>(
      `SELECT snapshot_version, covered_seq, doc_json, state_json FROM ppt_live_snapshot WHERE doc_id = ?`,
      [docId],
    )
    const row = rows[0]
    if (!row) return null
    return rowToSnapshot(row)
  },

  /**
   * Latest live snapshot read INSIDE the caller's transaction, so it shares one
   * consistent snapshot with the other replay reads (P1-4 atomic replay view).
   */
  async getTx(tx: Tx, docId: string): Promise<PptLiveSnapshot | null> {
    const rows = await tx.query<RawRow>(
      `SELECT snapshot_version, covered_seq, doc_json, state_json FROM ppt_live_snapshot WHERE doc_id = ?`,
      [docId],
    )
    const row = rows[0]
    if (!row) return null
    return rowToSnapshot(row)
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
   * version, doc, state, sha and byte columns are only replaced when the incoming
   * `coveredSeq` is >= the stored one, and `covered_seq` moves via `GREATEST`, so
   * `doc_json`, `state_json` and `covered_seq` always advance TOGETHER — a late
   * snapshot that covers LESS than the current one neither rewinds the coverage nor
   * overwrites the doc/state with a shorter prefix (XIN-1759 Part B keeps doc and
   * state atomic so a late joiner never mixes a doc at seq N with state at seq M).
   * The caller reads the authoritative post-write `(snapshot_version, covered_seq)`
   * back on the same connection.
   *
   * STATE GROWTH (XIN-1821 P1-3): `state_json` embeds the Bento version vector `vv`
   * (one entry per actor that ever landed an op) plus the `regs`/`tombs`/`txt`/`stash`/
   * `limbo` maps, and NONE of them is GC'd. In Half A the actor id is CLIENT-CHOSEN
   * (`[a-z0-9-]{1,64}`, `frames.ts`), not server-minted, so `vv` cardinality is not
   * bounded by authenticated sessions — a writer could inflate it. Two controls keep
   * this from becoming an unrecoverable loss: (1) the relay is gated OFF by default
   * (`PPT_RELAY_ENABLED`), so this surface is unreachable in production until Half B
   * lands the server-minted actor binding that re-bounds `vv`; and (2) the hard column
   * guard below fails CLOSED before any write/prune. A `vv`-retirement / per-actor cap
   * is deferred to Half B alongside the actor binding (adding it here, without the
   * binding, risks dropping a live replica's seq — the silent-loss class XIN-1800 P0-1
   * fixed). Bounding per-frame junk further is covered by the op/frame byte caps.
   */
  async upsertAdvanceTx(
    tx: Tx,
    docId: string,
    coveredSeq: number,
    doc: BentoDoc,
    state: SyncStateJSON | null,
  ): Promise<{ snapshotVersion: number; coveredSeq: number }> {
    const docJson = JSON.stringify(doc)
    const sha = createHash('sha256').update(docJson).digest('hex')
    const bytes = Buffer.byteLength(docJson, 'utf8')
    // Treat both null and undefined as "no state" so a legacy doc-only caller that
    // omits it never crashes the hash/byte computation below.
    const stateJson = state == null ? null : JSON.stringify(state)
    const stateSha = stateJson === null ? null : createHash('sha256').update(stateJson).digest('hex')
    const stateBytes = stateJson === null ? 0 : Buffer.byteLength(stateJson, 'utf8')
    // Fail CLOSED before the write if either column would overflow the MEDIUMTEXT
    // ceiling (XIN-1821 P1-3): a silent truncation followed by a prune destroys the
    // deck. Throwing here (non-retryable) leaves the op log durable; the relay surfaces
    // it as `room-full` on the forced path.
    if (bytes > SNAPSHOT_COLUMN_MAX_BYTES) throw new SnapshotColumnOverflowError('doc_json', bytes)
    if (stateBytes > SNAPSHOT_COLUMN_MAX_BYTES) throw new SnapshotColumnOverflowError('state_json', stateBytes)
    await tx.query(
      `INSERT INTO ppt_live_snapshot (doc_id, snapshot_version, covered_seq, doc_json, doc_sha, doc_bytes, state_json, state_sha, state_bytes)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         snapshot_version = IF(VALUES(covered_seq) >= covered_seq, snapshot_version + 1, snapshot_version),
         doc_json         = IF(VALUES(covered_seq) >= covered_seq, VALUES(doc_json), doc_json),
         doc_sha          = IF(VALUES(covered_seq) >= covered_seq, VALUES(doc_sha), doc_sha),
         doc_bytes        = IF(VALUES(covered_seq) >= covered_seq, VALUES(doc_bytes), doc_bytes),
         state_json       = IF(VALUES(covered_seq) >= covered_seq, VALUES(state_json), state_json),
         state_sha        = IF(VALUES(covered_seq) >= covered_seq, VALUES(state_sha), state_sha),
         state_bytes      = IF(VALUES(covered_seq) >= covered_seq, VALUES(state_bytes), state_bytes),
         covered_seq      = GREATEST(covered_seq, VALUES(covered_seq))`,
      [docId, coveredSeq, docJson, sha, bytes, stateJson, stateSha, stateBytes],
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
