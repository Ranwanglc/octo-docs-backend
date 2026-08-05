/**
 * `ppt_idempotency` — the scoped idempotency replay/conflict store for the PPT
 * write endpoints (create in R2-B1; register/publish reuse the same table in
 * later rounds via distinct `scope` values).
 *
 * A record is keyed by `(space_id, scope, uid, idempotency_key)`. The `uid` is
 * part of the key on purpose: the created resource is owned by / grants admin to
 * the authenticated caller, and the stored response carries that caller's
 * `ownerId`/`role`. Scoping only by `(space_id, scope, idempotency_key)` would
 * let a DIFFERENT user in the same space, reusing the same `Idempotency-Key`,
 * replay the FIRST user's doc response — a cross-user identity leak. Per-user
 * scoping makes replay/conflict strictly per-caller: a second user reusing the
 * same key simply mints their OWN deck, and the first user's replay still returns
 * their original response byte-for-byte.
 *
 * Two-phase write to avoid ever creating an orphaned document on a concurrent
 * same-key race:
 *   1. {@link reserve} claims the key with a placeholder row BEFORE the caller
 *      creates anything. The unique key makes exactly one concurrent request the
 *      winner; the losers get `{ reserved: false }` and never create a doc.
 *   2. {@link complete} fills the placeholder with the real response once the
 *      side effect has succeeded.
 * A completed record (response_status > 0) is what a later replay reads.
 */
import { query } from '../pool.js'

/** Operation namespaces that share the one idempotency table. */
export const PPT_IDEMPOTENCY_SCOPE_CREATE = 'create'

export interface PptIdempotencyRecord {
  spaceId: string
  scope: string
  uid: string
  idempotencyKey: string
  /** SHA-256 (hex) of the canonical request payload (see hashCanonicalPayload). */
  requestHash: string
  /** HTTP status of the stored response, or 0 while the row is a placeholder. */
  responseStatus: number
  /** The original enveloped `data` payload; null until the record is completed. */
  responseData: unknown
  /** The created doc id, when the operation created one (else null). */
  docId: string | null
  /** True once {@link complete} has stored the real response. */
  completed: boolean
}

/**
 * True when a thrown DB error is a duplicate-key violation. mysql2 surfaces it
 * as `code: 'ER_DUP_ENTRY'` / `errno: 1062`; check both so the concurrent-insert
 * recovery is robust to how the driver labels it.
 */
function isDupEntry(err: unknown): boolean {
  const e = err as { code?: string; errno?: number } | null
  return e?.code === 'ER_DUP_ENTRY' || e?.errno === 1062
}

interface IdempotencyRow {
  request_hash: string
  response_status: number
  response_body: string | null
  doc_id: string | null
}

export const pptIdempotencyRepo = {
  /** Look up a prior record for this (space, scope, uid, key), or null if none. */
  async get(spaceId: string, scope: string, uid: string, idempotencyKey: string): Promise<PptIdempotencyRecord | null> {
    const rows = await query<IdempotencyRow>(
      `SELECT request_hash, response_status, response_body, doc_id
         FROM ppt_idempotency
        WHERE space_id = ? AND scope = ? AND uid = ? AND idempotency_key = ?`,
      [spaceId, scope, uid, idempotencyKey],
    )
    const row = rows[0]
    if (!row) return null
    const completed = row.response_status > 0
    return {
      spaceId,
      scope,
      uid,
      idempotencyKey,
      requestHash: row.request_hash,
      responseStatus: row.response_status,
      responseData: completed && row.response_body ? JSON.parse(row.response_body) : null,
      docId: row.doc_id,
      completed,
    }
  },

  /**
   * Claim the key with a placeholder row (status 0) recording the request hash.
   * Returns `{ reserved: true }` when this caller won the key and may proceed to
   * create the resource, or `{ reserved: false }` when a concurrent request
   * already claimed it (the caller then re-reads via {@link get} to replay or
   * conflict — WITHOUT creating a duplicate resource).
   */
  async reserve(
    spaceId: string,
    scope: string,
    uid: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<{ reserved: boolean }> {
    try {
      await query(
        `INSERT INTO ppt_idempotency
           (space_id, scope, uid, idempotency_key, request_hash, response_status, response_body, doc_id)
         VALUES (?, ?, ?, ?, ?, 0, NULL, NULL)`,
        [spaceId, scope, uid, idempotencyKey, requestHash],
      )
      return { reserved: true }
    } catch (err) {
      if (isDupEntry(err)) return { reserved: false }
      throw err
    }
  },

  /** Fill a reserved placeholder with the final response once the side effect committed. */
  async complete(
    spaceId: string,
    scope: string,
    uid: string,
    idempotencyKey: string,
    responseStatus: number,
    responseData: unknown,
    docId: string | null,
  ): Promise<void> {
    await query(
      `UPDATE ppt_idempotency
          SET response_status = ?, response_body = ?, doc_id = ?
        WHERE space_id = ? AND scope = ? AND uid = ? AND idempotency_key = ?`,
      [responseStatus, JSON.stringify(responseData), docId, spaceId, scope, uid, idempotencyKey],
    )
  },
}
