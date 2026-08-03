/**
 * doc_meta repository (§3.4 / §8.4).
 *
 * Business metadata: title/owner/space/folder/status/permission_epoch.
 * Holds both doc_id (business PK) and document_name (Hocuspocus routing/
 * persistence key, unique). See appendix B for the naming convention.
 */
import { query, transaction, type Tx } from '../pool.js'
import { SHARE_SCOPE_ANYONE, SHARE_ROLE_EDIT } from '../../permission/shareScope.js'
import { STORED_ROLE_VALUES } from '../../permission/role.js'

/**
 * True when a thrown DB error is a duplicate-key violation. mysql2 surfaces it
 * as `code: 'ER_DUP_ENTRY'` / `errno: 1062`; we check both so the TOCTOU
 * recovery in upsertHtmlByOctoDocSlug is robust to how the driver labels it.
 */
function isDupEntry(err: unknown): boolean {
  const e = err as { code?: string; errno?: number } | null
  return e?.code === 'ER_DUP_ENTRY' || e?.errno === 1062
}

/**
 * Broken-object-level-authorization guard (P0 default-deny). Thrown when a
 * non-owner tries to upsert a slug an existing row already owns: the space-scoped
 * lookup resolves the OTHER bot's row, so mutating it here would overwrite its
 * title, restamp updated_by, and revive a soft-deleted row with no ownership
 * check. The route maps this to 403 (never fail-open). Ownership is owner-only
 * here (owner is implicit admin, §4.2); an admin-member override would need a
 * doc_member round-trip this repo layer does not carry, and is not required.
 */
export class DocOwnershipError extends Error {
  constructor(message = 'forbidden') {
    super(message)
    this.name = 'DocOwnershipError'
  }
}

export interface DocMeta {
  doc_id: string
  document_name: string
  title: string
  owner_id: string
  space_id: string
  folder_id: string
  doc_type: string
  octo_doc_slug: string | null
  status: number // 1=active 0=deleted 2=archived
  permission_epoch: number
  /**
   * Share scope (#64): 0=restricted (default), 1=anyone_in_space. A `SELECT *`
   * carries it onto every read (getByDocId / getByDocumentName), so the
   * effective-role path and the WS recheck see it with no query edit.
   */
  share_scope: number
  /**
   * Share role (#64) applied when share_scope=anyone_in_space: 1=read, 2=edit.
   * Ignored when restricted (the update API normalizes it to 1 in that case).
   */
  share_role: number
  created_at: Date
  updated_at: Date
  created_by: string
  updated_by: string
}

export interface CreateDocInput {
  docId: string
  documentName: string
  title: string
  ownerId: string
  spaceId: string
  folderId: string
  docType: string
  octoDocSlug?: string
  createdBy: string
}

const VALID_STORED_ROLES_SQL = STORED_ROLE_VALUES.join(', ')
const validMemberRole = `dm.role IN (${VALID_STORED_ROLES_SQL})`

export const docMetaRepo = {
  async create(input: CreateDocInput): Promise<void> {
    await query(
      `INSERT INTO doc_meta
         (doc_id, document_name, title, owner_id, space_id, folder_id, doc_type, octo_doc_slug, status, permission_epoch, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, '')`,
      [
        input.docId,
        input.documentName,
        input.title,
        input.ownerId,
        input.spaceId,
        input.folderId,
        input.docType,
        input.docType === 'html' ? (input.octoDocSlug ?? null) : null,
        input.createdBy,
      ],
    )
  },

  async upsertHtmlByOctoDocSlug(input: CreateDocInput & { octoDocSlug: string }): Promise<{ meta: DocMeta; created: boolean }> {
    // Tenant isolation (P0): resolve the slug WITHIN the caller's space only. A
    // slug is unique per (space_id, octo_doc_slug), so a same-slug row in another
    // space is invisible here and can never be updated/revived across tenants.
    const existing = await docMetaRepo.getByOctoDocSlug(input.octoDocSlug, input.spaceId)
    if (existing) {
      // Re-authorize before mutating the resolved row (P0). The space-scoped
      // lookup can resolve a DIFFERENT bot's row for the same slug; updating it
      // would overwrite its title/updated_by and revive a soft-deleted row with
      // no auth. Owner固化: only the owning bot converges idempotently.
      if (existing.owner_id !== input.createdBy) throw new DocOwnershipError()
      // space_id in the WHERE is defense-in-depth: `existing` is already
      // space-scoped, so pinning the space here means no cross-tenant row can
      // ever be the UPDATE target.
      await query(
        `UPDATE doc_meta
         SET title = ?, updated_by = ?, status = 1
         WHERE doc_id = ? AND doc_type = 'html' AND space_id = ?`,
        [input.title, input.createdBy, existing.doc_id, input.spaceId],
      )
      const updated = await docMetaRepo.getByDocId(existing.doc_id)
      if (!updated) throw new Error('html doc disappeared after upsert')
      return { meta: updated, created: false }
    }

    try {
      await docMetaRepo.create(input)
    } catch (err) {
      // TOCTOU: two concurrent registrations of the same (space, slug) both miss
      // the SELECT, then race on INSERT. The composite unique key makes the loser
      // fail with ER_DUP_ENTRY — re-fetch the now-committed row and fall through
      // to the idempotent UPDATE branch instead of surfacing a 500.
      if (!isDupEntry(err)) throw err
      const raced = await docMetaRepo.getByOctoDocSlug(input.octoDocSlug, input.spaceId)
      if (!raced) throw err
      // Same P0 re-authorization on the TOCTOU recovery branch: the racing
      // winner may be another bot's row, so a non-owner loser must be rejected
      // rather than silently overwriting/reviving it.
      if (raced.owner_id !== input.createdBy) throw new DocOwnershipError()
      await query(
        `UPDATE doc_meta
         SET title = ?, updated_by = ?, status = 1
         WHERE doc_id = ? AND doc_type = 'html' AND space_id = ?`,
        [input.title, input.createdBy, raced.doc_id, input.spaceId],
      )
      const updated = await docMetaRepo.getByDocId(raced.doc_id)
      if (!updated) throw new Error('html doc disappeared after upsert')
      return { meta: updated, created: false }
    }
    const created = await docMetaRepo.getByDocId(input.docId)
    if (!created) throw new Error('html doc missing after create')
    return { meta: created, created: true }
  },

  async getByDocId(docId: string): Promise<DocMeta | null> {
    const rows = await query<DocMeta>('SELECT * FROM doc_meta WHERE doc_id = ? LIMIT 1', [docId])
    return rows[0] ?? null
  },

  async getByDocumentName(documentName: string): Promise<DocMeta | null> {
    const rows = await query<DocMeta>(
      'SELECT * FROM doc_meta WHERE document_name = ? LIMIT 1',
      [documentName],
    )
    return rows[0] ?? null
  },

  async getByOctoDocSlug(octoDocSlug: string, spaceId: string): Promise<DocMeta | null> {
    // Tenant isolation (P0): the slug is only globally unique WITHIN a space
    // (uk_octo_doc_slug is (space_id, octo_doc_slug)). Scoping the lookup by
    // space_id stops space B from resolving — and thus reviving / rewriting /
    // leaking — space A's row for the same slug.
    const rows = await query<DocMeta>(
      `SELECT * FROM doc_meta
       WHERE octo_doc_slug = ? AND doc_type = 'html' AND space_id = ?
       LIMIT 1`,
      [octoDocSlug, spaceId],
    )
    return rows[0] ?? null
  },

  /** Resolve the canonical document_name for a doc_id (§7.3 resolveDocumentName). */
  async resolveDocumentName(docId: string): Promise<string | null> {
    const rows = await query<{ document_name: string }>(
      'SELECT document_name FROM doc_meta WHERE doc_id = ? AND status <> 0 LIMIT 1',
      [docId],
    )
    return rows[0]?.document_name ?? null
  },

  async rename(docId: string, title: string, updatedBy = ''): Promise<void> {
    await query('UPDATE doc_meta SET title = ?, updated_by = ? WHERE doc_id = ?', [title, updatedBy, docId])
  },

  /**
   * Update a doc's share settings (#64) AND bump permission_epoch in the SAME
   * transaction, so a narrowing (e.g. anyone_in_space -> restricted) is atomic:
   * the row can never be observed at its new scope with a stale epoch, which
   * would leave live non-members editing until the next unrelated bump. Mirrors
   * softDelete's flip-status-and-bump pattern. The caller (PUT /share handler)
   * has already validated + normalized scopeNum/roleNum (restricted forces
   * role=1); the migration CHECK constraints are a defense-in-depth backstop.
   * Returns the new epoch so the caller refreshes caches + publishes the
   * invalidation event (via refreshAndPublish), exactly like softDelete.
   */
  async setShareSettings(docId: string, scopeNum: number, roleNum: number): Promise<number> {
    return transaction(async (tx) => {
      await tx.query('UPDATE doc_meta SET share_scope = ?, share_role = ? WHERE doc_id = ?', [
        scopeNum,
        roleNum,
        docId,
      ])
      await docMetaRepo.bumpEpochTx(tx, docId)
      const rows = await tx.query<{ permission_epoch: number }>(
        'SELECT permission_epoch FROM doc_meta WHERE doc_id = ? LIMIT 1',
        [docId],
      )
      return Number(rows[0]?.permission_epoch ?? 0)
    })
  },

  /**
   * Soft delete (status=0), §8.4.
   *
   * Flips status AND bumps permission_epoch in the SAME transaction (reusing
   * bumpEpochTx, §4.5). The epoch bump is what severs live collaboration: a
   * connected writer's beforeHandleMessage sees the advanced epoch, rechecks,
   * and resolveRole returns 'none' (status===0) -> 4403 reject + readOnly.
   * Without the bump the recheck never fires and writers keep editing a deleted
   * doc. Returns the doc's document_name and the new epoch so the caller can
   * publish the invalidation event (mirrors acceptInvite); null if no such doc.
   */
  async softDelete(docId: string): Promise<{ documentName: string; permissionEpoch: number } | null> {
    return transaction(async (tx) => {
      await tx.query('UPDATE doc_meta SET status = 0 WHERE doc_id = ?', [docId])
      await docMetaRepo.bumpEpochTx(tx, docId)
      const rows = await tx.query<{ document_name: string; permission_epoch: number }>(
        'SELECT document_name, permission_epoch FROM doc_meta WHERE doc_id = ? LIMIT 1',
        [docId],
      )
      const row = rows[0]
      if (!row) return null
      return { documentName: row.document_name, permissionEpoch: Number(row.permission_epoch) }
    })
  },

  /**
   * List documents the caller can see in a space/folder.
   * By default listing is scoped to docs the uid owns OR is a member of (joined
   * with doc_member), with the resolved role surfaced per row.
   *
   * `owner: 'me'` (FEAT-B "my documents") tightens visibility to STRICTLY the
   * docs the caller owns (owner_id == uid) and drops the shared-with-me branch —
   * role is then always admin(3). `q` (FEAT-B filename search) adds a
   * case-insensitive substring match on title with LIKE wildcards escaped so a
   * user-typed `%`/`_`/`\` matches literally. `types` (FEAT-B/XIN-1188 kind
   * filter) narrows to a multi-value OR set of `doc_type`s at the same layer as
   * `q` — BEFORE pagination, so count and page agree. Empty `types` applies no
   * predicate (backward compatible).
   */
  async listForUser(params: {
    uid: string
    spaceId: string
    isSpaceMember?: boolean
    folderId?: string
    owner?: 'me'
    ownedBots?: string[]
    q?: string
    types?: string[]
    page: number
    pageSize: number
    sort: 'updatedAt:desc' | 'updatedAt:asc'
  }): Promise<{ total: number; items: Array<DocMeta & { role: number }> }> {
    const where: string[] = ['m.status <> 0']
    // Optional space/folder/q filters appear in the WHERE clause between the
    // JOIN's `dm.uid = ?` and the trailing owner/visibility predicate. Collect
    // their bind values in clause order so the full args array lines up
    // positionally with the SQL.
    const filterArgs: unknown[] = []
    // role: owner => admin(3), else doc_member.role
    // Space isolation (P1): listing is always scoped to the caller's space; the
    // space filter is unconditional now that spaceId is required (sourced from
    // the enforced X-Space-Id header). Docs in other spaces are never returned.
    where.push('m.space_id = ?')
    filterArgs.push(params.spaceId)
    if (params.folderId) {
      where.push('m.folder_id = ?')
      filterArgs.push(params.folderId)
    }
    const q = (params.q ?? '').trim()
    if (q !== '') {
      // utf8mb4 default collation is case-insensitive, so LIKE is CI without
      // LOWER(). Escape `%`/`_`/`\` so they match literally; ESCAPE '\\'.
      const qEsc = q.replace(/[\\%_]/g, (c) => `\\${c}`)
      where.push(`m.title LIKE ? ESCAPE '\\\\'`)
      filterArgs.push(`%${qEsc}%`)
    }
    // FEAT-B/XIN-1188 kind filter: multi-value OR on doc_type, same layer as `q`
    // (before pagination). Values are pre-validated by the route; empty => no
    // predicate (pre-FEAT-B behavior unchanged).
    const types = (params.types ?? []).filter((t) => typeof t === 'string' && t !== '')
    if (types.length > 0) {
      where.push(`m.doc_type IN (${types.map(() => '?').join(', ')})`)
      filterArgs.push(...types)
    }
    // Visibility predicate — two orthogonal concerns merged:
    //  (a) owner='me' authorship widening: "owner" spans the caller AND any bot
    //      the caller owns, so docs a user's bots created show up in "my
    //      documents". ownerSet = [uid, ...ownedBots] de-duped, empties stripped;
    //      degrades to exactly [uid] when ownedBots empty (backward compatible).
    //      FAIL-CLOSED: ownedBots only ADDS the caller's own bots. owner='me'
    //      still excludes shared-with-me AND space-share (FEAT-B Q7 — authorship,
    //      not access), so no share branch here.
    //  (b) non-me space share (#64): owner OR doc_member OR share_scope=anyone,
    //      gated on isSpaceMember (same check the write side runs). space_id filter
    //      pins the named space but does NOT prove membership; without the gate a
    //      non-member could read another space's anyone_in_space metadata
    //      (cross-space leak). Non-member => collapses to owner OR doc_member.
    // SHARE_SCOPE_ANYONE is a numeric constant, inlined (no extra bind).
    const includeSpaceShare = params.owner !== 'me' && params.isSpaceMember === true
    let visibility: string
    let ownerSet: string[] | null = null
    // Bind values contributed by the visibility clause, in placeholder order.
    const visibilityArgs: unknown[] = []
    if (params.owner === 'me') {
      ownerSet = [
        params.uid,
        ...(params.ownedBots ?? []).filter((b) => typeof b === 'string' && b !== ''),
      ].filter((v, i, arr) => arr.indexOf(v) === i)
      // ownerSet always has >=1 element (params.uid); empty ownedBots => IN (?).
      visibility = `m.owner_id IN (${ownerSet.map(() => '?').join(', ')})`
      visibilityArgs.push(...ownerSet)
    } else if (includeSpaceShare) {
      visibility = `(m.owner_id = ? OR ${validMemberRole} OR m.share_scope = ${SHARE_SCOPE_ANYONE})`
      visibilityArgs.push(params.uid)
    } else {
      visibility = `(m.owner_id = ? OR ${validMemberRole})`
      visibilityArgs.push(params.uid)
    }
    // Placeholders in `base`, in order: JOIN `dm.uid = ?`, then the optional
    // space/folder/q filters, then the trailing visibility `m.owner_id IN (...)`
    // (1 bind for the default branch, 1+N for owner=me). The join uid leads and
    // the visibility owner set(s) trail — they are not interchangeable. The bind
    // count MUST match the placeholder count exactly or mysql2 execute errno
    // 1210 fires.
    const args: unknown[] = [params.uid, ...filterArgs, ...visibilityArgs]
    const whereSql = where.join(' AND ')
    const order = params.sort === 'updatedAt:asc' ? 'ASC' : 'DESC'
    // `query()` runs on mysql2 `.execute()` (a prepared statement), which rejects
    // numeric LIMIT/OFFSET bound via `?` with ER_WRONG_ARGUMENTS (errno 1210) — a
    // guaranteed 500. Coerce and clamp pageSize to a positive integer in 1..100
    // and offset to a non-negative integer; both are then provably integers and
    // safe to inline directly (no injection surface).
    const pageSize = Math.min(100, Math.max(1, Number.isInteger(params.pageSize) ? params.pageSize : 20))
    const offsetRaw = (params.page - 1) * pageSize
    const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0

    const base = `
      FROM doc_meta m
      LEFT JOIN doc_member dm ON dm.doc_id = m.doc_id AND dm.uid = ?
      WHERE ${whereSql} AND ${visibility}
    `
    const countRows = await query<{ cnt: number }>(`SELECT COUNT(*) AS cnt ${base}`, args)
    const total = Number(countRows[0]?.cnt ?? 0)

    // tie-break on doc_id keeps offset paging stable when rows share updated_at.
    // role projection MUST mirror the write side (effectiveRole, shareScope.ts):
    // Stored commenter=4 is not privilege-ordered, so the share merge uses an
    // explicit writer/admin set instead of a raw numeric GREATEST.
    const roleOwnerPredicate = ownerSet
      ? `m.owner_id IN (${ownerSet.map(() => '?').join(', ')})`
      : 'm.owner_id = ?'
    const roleOwnerArgs: unknown[] = ownerSet ?? [params.uid]
    const roleExpr = includeSpaceShare
      ? `CASE WHEN ${roleOwnerPredicate} THEN 3
              WHEN m.share_scope = ${SHARE_SCOPE_ANYONE} AND m.share_role = ${SHARE_ROLE_EDIT}
                THEN CASE WHEN dm.role = 3 THEN 3 WHEN dm.role = 2 THEN 2 ELSE 2 END
              WHEN m.share_scope = ${SHARE_SCOPE_ANYONE}
                THEN CASE WHEN dm.role = 3 THEN 3 WHEN dm.role = 2 THEN 2 WHEN dm.role = 4 THEN 4 WHEN dm.role = 1 THEN 1 ELSE 1 END
              WHEN dm.role = 3 THEN 3 WHEN dm.role = 2 THEN 2 WHEN dm.role = 4 THEN 4 WHEN dm.role = 1 THEN 1
              ELSE NULL END`
      : `CASE WHEN ${roleOwnerPredicate} THEN 3
              WHEN dm.role = 3 THEN 3 WHEN dm.role = 2 THEN 2 WHEN dm.role = 4 THEN 4 WHEN dm.role = 1 THEN 1
              ELSE NULL END`
    const items = await query<DocMeta & { role: number }>(
      `SELECT m.*, ${roleExpr} AS role
       ${base}
       ORDER BY m.updated_at ${order}, m.doc_id ${order}
       LIMIT ${pageSize} OFFSET ${offset}`,
      [...roleOwnerArgs, ...args],
    )
    return { total, items }
  },

  /**
   * Permission down-push for full-text search (P4, §5.3(a) / §5.4). Compute the
   * caller's visible doc_id set in `spaceId` so the route can push it into
   * OpenSearch as a `terms: { doc_id: [...] }` filter branch.
   *
   * The set is owner OR direct doc_member, PLUS space-share (share_scope=anyone)
   * when the caller is a confirmed space member (fail-closed: a non-member
   * collapses to owner OR doc_member). Space-share IS enumerated here (same
   * predicate as listForUser's includeSpaceShare branch, #64) rather than being
   * pushed to an OS-side share_scope branch: with the status=1 filter, a
   * soft-deleted doc is simply absent from the set, so it cannot be searched even
   * if OS still holds a stale copy — OS never needs to carry fresh share_scope /
   * status. The trade-off is terms-list size for large space-share sets (§5.4).
   *
   * owner scope is the caller alone (owner_id = uid) — matching requireDocRole /
   * resolveRole, which key off `uid === meta.owner_id` with no ownedBots widening.
   * A content-returning search endpoint MUST fail-closed to the read guard: a doc
   * owned by a bot the caller owns is NOT auto-visible here (it would return title
   * + body highlight for a docId whose GET /content is 403 when the human has no
   * doc_member row — reachable via the non-transactional grantBotOwnerAdmin path,
   * see docs.ts). status=1 (active only). Optional docType narrows to a
   * multi-value doc_type set. Returns the doc_id strings.
   *
   * When `limit` is given the SQL caps at `limit + 1` rows, so an oversized
   * visible set is detected here (the caller compares `length > limit`) BEFORE
   * the full set is streamed out of MySQL and a large terms array is built —
   * the row cost is bounded to limit+1 instead of the true (unbounded) count.
   */
  async listVisibleDocIdSet(params: {
    uid: string
    spaceId: string
    docType?: string[]
    isSpaceMember?: boolean
    limit?: number
  }): Promise<string[]> {
    // owner set: caller only (owner_id = uid), matching requireDocRole /
    // resolveRole. Deliberately NOT widened to ownedBots (unlike listForUser
    // owner='me'): this endpoint returns body highlights, so it must fail-closed
    // to the read guard. A bot-owned doc without a doc_member row for the human
    // stays out of the visible set here, same as GET /content would 403.
    const ownerSet = [params.uid]

    const docTypes = (params.docType ?? []).filter((t) => typeof t === 'string' && t !== '')

    // Bind order MUST match placeholder order (mysql2 execute, errno 1210 on a
    // mismatch): JOIN `dm.uid = ?` first, then space_id, then the optional
    // doc_type IN (...), then the owner IN (...) set in the visibility tail.
    const ownerPlaceholders = ownerSet.map(() => '?').join(', ')
    const where = ['m.status = 1', 'm.space_id = ?']
    const args: unknown[] = [params.uid, params.spaceId]
    if (docTypes.length > 0) {
      where.push(`m.doc_type IN (${docTypes.map(() => '?').join(', ')})`)
      args.push(...docTypes)
    }
    // Visibility: owner OR direct doc_member, PLUS space-share (share_scope=anyone)
    // for a confirmed space member — the SAME predicate as listForUser's
    // includeSpaceShare branch (#64), gated on isSpaceMember (fail-closed: a
    // non-member collapses to owner OR doc_member). Enumerating space-share here
    // (with the status=1 filter above) means the search endpoint no longer needs
    // OS to carry a fresh share_scope/status — an already-soft-deleted doc simply
    // isn't in this set, so it can't be searched even if OS still holds a stale
    // copy. SHARE_SCOPE_ANYONE is a numeric constant, inlined (no extra bind).
    const spaceShare = params.isSpaceMember === true ? ` OR m.share_scope = ${SHARE_SCOPE_ANYONE}` : ''
    where.push(`(m.owner_id IN (${ownerPlaceholders}) OR ${validMemberRole}${spaceShare})`)
    args.push(...ownerSet)

    // Cap rows at limit+1 (when a limit is given) so overflow is detectable by
    // the caller (length > limit) without materializing the whole set. No ORDER
    // BY: membership is set-semantics only (fed to an OS terms filter), so which
    // limit+1 rows come back does not matter — only whether the count exceeds
    // the bound. mysql2 forbids a bound `?` in LIMIT, so inline the validated int.
    const limitClause =
      typeof params.limit === 'number' && Number.isInteger(params.limit) && params.limit >= 0
        ? ` LIMIT ${params.limit + 1}`
        : ''
    const sql = `
      SELECT m.doc_id
      FROM doc_meta m
      LEFT JOIN doc_member dm ON dm.doc_id = m.doc_id AND dm.uid = ?
      WHERE ${where.join(' AND ')}${limitClause}
    `
    const rows = await query<{ doc_id: string }>(sql, args)
    return rows.map((r) => r.doc_id)
  },

  /** Bump permission_epoch within an existing transaction (§4.5). */
  async bumpEpochTx(tx: Tx, docId: string): Promise<void> {
    await tx.query('UPDATE doc_meta SET permission_epoch = permission_epoch + 1 WHERE doc_id = ?', [docId])
  },

  /** Bump permission_epoch (standalone), returns the new epoch. */
  async bumpEpoch(docId: string): Promise<number> {
    return transaction(async (tx) => {
      await tx.query('UPDATE doc_meta SET permission_epoch = permission_epoch + 1 WHERE doc_id = ?', [docId])
      const rows = await tx.query<{ permission_epoch: number }>(
        'SELECT permission_epoch FROM doc_meta WHERE doc_id = ? LIMIT 1',
        [docId],
      )
      return Number(rows[0]?.permission_epoch ?? 0)
    })
  },

  /** Read current epoch authoritatively from DB by document_name (§4.5 P2-E). */
  async getEpochByDocumentName(documentName: string): Promise<number | null> {
    const rows = await query<{ permission_epoch: number }>(
      'SELECT permission_epoch FROM doc_meta WHERE document_name = ? LIMIT 1',
      [documentName],
    )
    if (rows.length === 0) return null
    return Number(rows[0]!.permission_epoch)
  },
}
