/**
 * doc_member repository (§3.4 / §4.2 / §8.4).
 *
 * Document-autonomous membership. resolveRole queries this table + owner only
 * (§4.2); no group inheritance. PK (doc_id, uid) => at most one row per pair.
 */
import { query, getPool, type Tx } from '../pool.js'
import { roleFromNumber, type Role } from '../../permission/role.js'

export interface DocMemberRow {
  doc_id: string
  uid: string
  role: number
  granted_by: string
  source: number // 1=direct 2=invite
  invite_token: string
  created_at: Date
  updated_at: Date
}

export const SOURCE_DIRECT = 1
export const SOURCE_INVITE = 2

/**
 * SQL rank of a stored role value — mirrors roleRank() in permission/role.ts.
 * The stored TINYINT (1=reader 2=writer 3=admin 4=commenter) is NOT ordered by
 * privilege because commenter was added as value 4 without renumbering, yet it
 * ranks BETWEEN reader and writer. FIELD() maps each stored value to its
 * privilege position (reader<commenter<writer<admin), so the "never downgrade"
 * max-merge below compares by rank instead of by the raw value — otherwise a
 * commenter (4) would out-rank a writer (2) under a plain GREATEST. `$col` is
 * substituted with the column/expression to rank (e.g. `role` or `VALUES(role)`).
 */
const roleRankSql = (col: string): string => `FIELD(${col}, 1, 4, 2, 3)`

export const docMemberRepo = {
  /** Read a single member row's role (§4.2 resolveRole). Returns undefined if no row. */
  async getRole(docId: string, uid: string): Promise<Role | undefined> {
    const rows = await query<{ role: number }>(
      'SELECT role FROM doc_member WHERE doc_id = ? AND uid = ? LIMIT 1',
      [docId, uid],
    )
    if (rows.length === 0) return undefined
    return roleFromNumber(Number(rows[0]!.role))
  },

  async list(docId: string): Promise<DocMemberRow[]> {
    return query<DocMemberRow>(
      'SELECT * FROM doc_member WHERE doc_id = ? ORDER BY created_at ASC',
      [docId],
    )
  },

  /** Direct add / update role (§8.4 PUT members). Upsert by (doc_id, uid). */
  async upsertDirect(params: {
    docId: string
    uid: string
    roleNum: number
    grantedBy: string
  }): Promise<void> {
    await query(
      `INSERT INTO doc_member (doc_id, uid, role, granted_by, source, invite_token)
       VALUES (?, ?, ?, ?, ${SOURCE_DIRECT}, '')
       ON DUPLICATE KEY UPDATE role = VALUES(role), granted_by = VALUES(granted_by)`,
      [params.docId, params.uid, params.roleNum, params.grantedBy],
    )
  },

  async remove(docId: string, uid: string): Promise<void> {
    await query('DELETE FROM doc_member WHERE doc_id = ? AND uid = ?', [docId, uid])
  },

  /**
   * Forward-grant upsert — "grant only, never downgrade" (max-merge).
   *
   * The forward-to-chat flow authorizes a recipient at the chosen level but must
   * NEVER lower an existing higher role (권한 matrix §7 "不降级" / AC-12). Uses a
   * single atomic statement, comparing by PRIVILEGE RANK (roleRankSql) rather
   * than the raw stored value — commenter's stored value (4) is not its rank
   * position, so a plain GREATEST would misorder it against writer (2):
   *
   *   role       = IF(rank(VALUES(role)) > rank(role), VALUES(role), role)        -- only up
   *   granted_by = IF(rank(VALUES(role)) > rank(role), VALUES(granted_by), ...)   -- audit only on real upgrade
   *
   * This is a DISTINCT method from upsertDirect (admin precise set, downgradable,
   * reused by PUT /members) and upsertFromInviteTx (invite, no-upgrade). The three
   * write paths are physically isolated so their opposite semantics never leak
   * into one another. source=direct, invite_token=''.
   *
   * Returns true when the row was inserted or genuinely upgraded (affectedRows>0),
   * false when it was already >= the target level (no-op). Callers bump the epoch
   * only on a real change. Because the rank compare is monotonic and single-statement,
   * the op is atomic and idempotent under concurrent/duplicate forwards (E-13).
   *
   * NOTE: never call this for an owner (owner has no doc_member row); doing so
   * would INSERT a misleading low-role row. Callers resolveRole first and skip
   * owners / existing admins.
   */
  async upsertGrantMax(params: {
    docId: string
    uid: string
    roleNum: number
    grantedBy: string
  }): Promise<boolean> {
    const [result] = await getPool().execute(
      `INSERT INTO doc_member (doc_id, uid, role, granted_by, source, invite_token)
       VALUES (?, ?, ?, ?, ${SOURCE_DIRECT}, '')
       ON DUPLICATE KEY UPDATE
         granted_by = IF(${roleRankSql('VALUES(role)')} > ${roleRankSql('role')}, VALUES(granted_by), granted_by),
         role       = IF(${roleRankSql('VALUES(role)')} > ${roleRankSql('role')}, VALUES(role), role)`,
      [params.docId, params.uid, params.roleNum, params.grantedBy] as never[],
    )
    // mysql2 ResultSetHeader.affectedRows: insert => 1, real update => 2,
    // "no change" (already >= target) => 0. Non-zero means a genuine grant/upgrade.
    return (result as unknown as { affectedRows?: number }).affectedRows! > 0
  },

  // ── transaction-scoped variants for the invite accept flow (§4.6) ──────────

  async getRoleTx(tx: Tx, docId: string, uid: string): Promise<Role | undefined> {
    const rows = await tx.query<{ role: number }>(
      'SELECT role FROM doc_member WHERE doc_id = ? AND uid = ? LIMIT 1',
      [docId, uid],
    )
    if (rows.length === 0) return undefined
    return roleFromNumber(Number(rows[0]!.role))
  },

  /** Insert/rebuild a member row from an accepted invite (§4.6 branch c/d). */
  async upsertFromInviteTx(
    tx: Tx,
    params: { docId: string; uid: string; roleNum: number; grantedBy: string; inviteToken: string },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO doc_member (doc_id, uid, role, granted_by, source, invite_token)
       VALUES (?, ?, ?, ?, ${SOURCE_INVITE}, ?)
       ON DUPLICATE KEY UPDATE role = VALUES(role), granted_by = VALUES(granted_by),
                               source = VALUES(source), invite_token = VALUES(invite_token)`,
      [params.docId, params.uid, params.roleNum, params.grantedBy, params.inviteToken],
    )
  },
}
