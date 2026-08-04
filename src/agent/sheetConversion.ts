/**
 * Server-side (no-DOM) spreadsheet <-> Y.Doc helpers for Agent (bot) access (§7.x).
 *
 * The sheet counterpart of conversion.ts. Where documents need a ProseMirror
 * round-trip, a spreadsheet's payload is a plain Y.Map, so a bot reads/writes it
 * directly — no schema, no DOM.
 *
 * CROSS-REPO CONTRACT — these MUST match octo-web/packages/docs/src/sheet/binding.ts:
 *   - Y.Map field name on the Y.Doc: 'sheet'
 *   - cell key: `${sheetId}!${row}:${col}`
 *   - cell value: { v?: string|number|boolean|null, f?: string, s?: object,
 *                   p?: object, t?: number }
 * (Same discipline as COLLAB_FIELD, which is shared between this backend and the
 * frontend.) If the frontend changes the field name or key shape, change it here
 * in lockstep or bot edits land in a Y.Map the clients never read.
 */
import * as Y from 'yjs'

/** Y.Map field that holds the spreadsheet payload on the shared Y.Doc. */
export const SHEET_YMAP_FIELD = 'sheet'

/**
 * Y.Map field holding column-width / row-height overrides. MUST match
 * octo-web/packages/docs/src/sheet/binding.ts (`SHEET_DIMS_FIELD`):
 *   - field name on the Y.Doc: 'sheetDims'
 *   - key: `c<idx>` (column width) or `r<idx>` (row height), idx a non-negative int
 *   - value: a positive finite number (pixels)
 * This is the sheet's SECOND synced map — it is two-way synced, persisted, and
 * therefore part of the grid that version-restore must reconcile alongside cells.
 */
export const SHEET_DIMS_FIELD = 'sheetDims'

/**
 * Y.Map field for floating images / drawings, keyed `${sheetId}!${drawingId}`
 * (matches octo-web binding.ts SHEET_DRAWINGS_FIELD). Each value is a serialized
 * Univer ISheetImage (opaque here — inline base64 `source`, transform, cell
 * anchor). The bot write surface lets a bot insert/remove a floating image.
 */
export const SHEET_DRAWINGS_FIELD = 'sheetDrawings'

/**
 * Y.Map field for cell hyperlinks, keyed `${sheetId}!${linkId}` (matches
 * octo-web binding.ts SHEET_HYPERLINKS_FIELD). Each value is a StoredHyperLink
 * `{ id, row, column, payload(url), display? }` managed by Univer's
 * SHEET_HYPER_LINK_PLUGIN — a link lives OUTSIDE cell data and points back at a
 * cell by row/column (the cell's visible text stays in `cell.v`). Two-way synced
 * + persisted (like dims), so version-restore reconciles it alongside the rest,
 * and unlike drawings it IS small/structured enough to ride the GET read surface.
 */
export const SHEET_HYPERLINKS_FIELD = 'sheetHyperLinks'

/**
 * Y.Map field for merged cell ranges, keyed `${logicalId}:sr:sc:er:ec`
 * (startRow:startCol:endRow:endCol, all 0-based; matches octo-web binding.ts
 * SHEET_MERGES_FIELD). Value is boolean `true` (the range is merged); deleting the
 * key un-merges it. Two-way synced + persisted like dims, so version-restore
 * reconciles it and it rides the GET read surface.
 */
export const SHEET_MERGES_FIELD = 'sheetMerges'

/**
 * Y.Map field for the sheet-tab registry, keyed by logicalId, value
 * `{ name, order }` (matches octo-web binding.ts SHEET_LIST_FIELD / SheetMeta).
 * This is what makes a sheet TAB exist in the UI: writing cells to a logicalId
 * NOT registered here leaves orphan cells the frontend won't render. The first
 * tab's logicalId is 'default'. Two-way synced + persisted; on the GET read surface.
 */
export const SHEET_LIST_FIELD = 'sheetList'

/**
 * Range/worksheet PROTECTION rules, written by the web client (see octo-web
 * `packages/docs/src/sheet/binding.ts`). Keys are `${logicalId}!r:${ruleId}` for a range rule and
 * `${logicalId}!w:` for the one-per-sheet worksheet rule.
 *
 * The backend does NOT author these — it ENFORCES them. Univer's permission check lives in the
 * browser, so before this existed any non-browser writer (a bot on `PATCH /:docId/sheet`, the CLI,
 * a script) could overwrite a protected cell: the protection was decoration outside the web UI.
 * `assertSheetWriteAllowed` below closes that on the server, for every REST/bot write.
 *
 * PROPOSED CONTRACT (forward reference): these two field names and the key shapes must match the
 * client half in octo-web#1190 (`packages/docs/src/sheet/binding.ts` + `protectionAuthz.ts`) exactly,
 * or enforcement silently reads an empty map and allows everything. Those files do NOT exist on
 * octo-web `main` yet — this server-side primitive lands first and lies dormant (no rules => early
 * return) until #1190 merges. Verified field by field against that PR's head, not against main.
 */
export const SHEET_PROTECTION_FIELD = 'sheetProtection'
/** permissionId -> { allow: uid[] , createdBy? }. Who may edit inside the object that id protects. */
export const SHEET_PROTECTION_GRANTS_FIELD = 'sheetProtectionGrants'

/**
 * Logical sheet id a V1 (single-sheet) doc uses, and the sheet an UNPREFIXED dims key addresses.
 * Must match octo-web `binding.ts` DEFAULT_SHEET_ID.
 */
const DEFAULT_LOGICAL_SHEET_ID = 'default'

/**
 * Sentinel permissionId for a rule with no readable permissionId of its own. Deliberately not a
 * possible grant key (grants are 24 hex chars from `newObjectId`), so `permits()` always answers
 * "no grant record" => denied for everyone but a doc admin.
 */
const UNPARSEABLE_RULE_PERMISSION_ID = '\u0000unparseable-protection-rule'

/**
 * Cell shape synced in V1: value, optional formula, optional resolved style, and
 * the two rich-cell fields the live editor also syncs.
 *
 * `s` mirrors the frontend's `SyncCell.s` (binding.ts): the RESOLVED IStyleData
 * object (font / color / size / bg / align), NOT a style id — a bot writing this
 * back must round-trip it verbatim so client-authored styling is preserved.
 * Kept as an opaque object here because the backend never interprets style; it
 * only stores and forwards it on the shared Y.Map.
 *
 * `p` and `t` mirror the frontend's `SyncCell.p` / `SyncCell.t`: `p` is the
 * rich-text document snapshot (Univer stores an INLINE CELL IMAGE as
 * `p.drawings[id].source`), and `t` is the cell type (1 = rich text). Both are
 * part of the live sync schema — the editor writes them and expects them back —
 * so this backend must round-trip them verbatim. They are opaque here (the
 * backend never interprets a cell's rich body or type); dropping either would
 * reload a rich/image cell blank. CLI/bot writers also emit `t`, so accepting it
 * here is what keeps version preview/restore aligned with the live doc.
 */
export interface SheetCell {
  v?: string | number | boolean | null
  f?: string
  s?: Record<string, unknown>
  // Univer also carries `p` (a rich-text cell snapshot — an inline CELL IMAGE
  // rides here as `p.drawings[id].source`) and `t` (cell type; 1 = rich text).
  // The web (Univer) writes these on image / rich cells, so they MUST round-trip
  // through the bot API or a human-edited sheet fails to read (409) / loses its
  // images on a bot write. Treated as opaque (like `s`) — see validateSheetCell.
  p?: Record<string, unknown>
  t?: number
}

/** Build the canonical cell key used by both ends of the binding. */
export function sheetCellKey(sheetId: string, row: number, col: number): string {
  return `${sheetId}!${row}:${col}`
}

/**
 * Raised when a sheet snapshot contains values that violate the
 * `{v,f,s,p,t}` cell contract (unexpected keys, wrong value types, non-object
 * entries, hostile keys). Mirrors the ProseMirror path's SchemaIncompatibleError
 * so both the HTTP-return and the live-replay paths can fail-closed instead of
 * serializing / rebroadcasting arbitrary writer-controlled data. Routes map this
 * to 409.
 */
export class SheetSnapshotInvalidError extends Error {
  readonly code = 'sheet_snapshot_invalid'
  constructor(message: string) {
    super(`sheet_snapshot_invalid: ${message}`)
    this.name = 'SheetSnapshotInvalidError'
  }
}

/**
 * A write touched a protected range the caller may not edit. Thrown from inside the live transact
 * BEFORE any mutation, so the whole batch is rejected with nothing applied and nothing broadcast —
 * the same fail-closed shape as SheetSnapshotInvalidError.
 */
export class ProtectedRangeError extends Error {
  readonly code = 'protected_range'
  /** Cell keys that were refused, capped — surfaced so a bot author can see WHICH cells blocked. */
  readonly keys: string[]
  constructor(keys: string[]) {
    const shown = keys.slice(0, 5)
    super(
      `protected_range: ${keys.length} cell(s) fall in a protected range you may not edit` +
        ` (e.g. ${shown.join(', ')})`,
    )
    this.name = 'ProtectedRangeError'
    this.keys = shown
  }
}

/**
 * A protected range as the web client stores it (binding.ts `StoredProtection`). Only the fields
 * enforcement needs are modelled; anything else on the value rides through untouched.
 */
interface StoredProtectionRule {
  kind?: unknown
  permissionId?: unknown
  ranges?: unknown
}

/** Inclusive cell rectangle. */
interface ProtectedRect {
  startRow: number
  startColumn: number
  endRow: number
  endColumn: number
}

/**
 * Parse result for a rule's `ranges`. `malformed` is the load-bearing field: it reports that at
 * least one element could NOT be read, which the caller must treat as fail-closed for the whole
 * sheet. Returning only the readable rects (the first cut) meant a rule shaped
 * `[<junk>, <good rect>]` protected ONLY the good rect and silently waved non-admin writes into the
 * area the junk element was meant to cover — a partial parse became a partial authorization bypass.
 */
interface ReadRectsResult {
  rects: ProtectedRect[]
  /** True when any element of `ranges` (or `ranges` itself) could not be parsed. */
  malformed: boolean
}

function readRects(raw: unknown): ReadRectsResult {
  // `ranges` not being a JS array at all (e.g. a Y.Array from a newer client) is itself a parse
  // failure, not "no ranges" — the caller must not read the empty result as "nothing protected".
  if (!Array.isArray(raw)) return { rects: [], malformed: true }
  const out: ProtectedRect[] = []
  let malformed = false
  for (const r of raw) {
    if (r == null || typeof r !== 'object') { malformed = true; continue }
    const { startRow, startColumn, endRow, endColumn } = r as Record<string, unknown>
    if (
      !Number.isInteger(startRow) || !Number.isInteger(startColumn) ||
      !Number.isInteger(endRow) || !Number.isInteger(endColumn)
    ) { malformed = true; continue }
    // NORMALIZE before storing. An inverted rect (startRow > endRow) has four valid integers, so it
    // would otherwise be stored as-is and the containment test `row < startRow || row > endRow`
    // would be true for EVERY row — the rule would protect zero cells and silently fail OPEN.
    // The merge write path (validateSheetMerge) already rejects sr>er; the rule-parse path agrees by
    // repairing the shape instead, so the admin's evident intent (the area between the bounds) holds.
    const sr = startRow as number
    const sc = startColumn as number
    const er = endRow as number
    const ec = endColumn as number
    const rect = {
      startRow: Math.min(sr, er),
      startColumn: Math.min(sc, ec),
      endRow: Math.max(sr, er),
      endColumn: Math.max(sc, ec),
    }
    // A rect NO CELL CAN EVER BE INSIDE is malformed intent, not a zero-area rule.
    //
    // Cell coordinates are never negative, so `endRow < 0` (or `endColumn < 0`) makes the containment
    // test unsatisfiable: the rule was present, an admin performed a protect action, and the server
    // enforced none of it. Same fail-open class as the inverted rect above, one field over — and
    // reachable, because the browser's own parser clamp-REJECTS such bounds while this one accepted
    // them, so the two sides disagreed about whether the rule existed.
    //
    // Deliberately NOT rejecting bounds merely above the visible grid: the cell-key format admits
    // those coordinates, so a write inside such a rect is correctly refused already. Treating them as
    // malformed would escalate a working rule to a whole-sheet lock. (My first probe mis-reported this
    // case as a hole because it only ever wrote A1 — outside the rect, so the allow was correct.)
    if (rect.endRow < 0 || rect.endColumn < 0) { malformed = true; continue }
    out.push(rect)
  }
  return { rects: out, malformed }
}

/**
 * Server-side enforcement of sheet protection for NON-BROWSER writers (bot / CLI / REST).
 *
 * Univer evaluates protection in the browser, so a REST write never passed through it — a bot could
 * overwrite any protected cell. This is the authoritative check: call it INSIDE the live transact,
 * before any mutation, so a refusal applies nothing and broadcasts nothing.
 *
 * Authorization model (deliberately the same one the web client uses, so the two cannot disagree):
 *   - a doc ADMIN/owner may write anywhere;
 *   - anyone else — including a bot — must appear in the rule's grant allow-list.
 * A bot is not special-cased: it is just another uid. To let a bot write a protected range, add its
 * uid to that range's allow-list in the UI.
 *
 * Fail-closed on a rule whose grant has not replicated yet: the rule proves the range is protected,
 * so an unknown allow-list denies rather than waves through.
 *
 * `worksheet` rules (`${logicalId}!w:`) protect the WHOLE sheet, so they match every cell on it.
 *
 * NOTE this covers every REST/bot path. A client driving the collab WebSocket directly still
 * bypasses it (that would need per-update inspection in the collab server's beforeHandleMessage) —
 * see the security note in octo-web `packages/docs/src/sheet/protectionAuthz.ts`.
 */
export function assertSheetWriteAllowed(
  doc: Y.Doc,
  cells: Record<string, SheetCell | null>,
  uid: string,
  isAdmin: boolean,
  /**
   * Row-height / column-width batch. Gated because a dim key addresses a WHOLE row or column: if
   * that row/column crosses a protected rectangle, resizing it changes how the protected cells
   * present to everyone. Optional so existing callers keep compiling.
   */
  dims: Record<string, number | null> = {},
  /**
   * Merge / un-merge batch. The most load-bearing of the two: merging across a protected rectangle
   * restructures it (cells disappear into the anchor), which is destructive in a way a value write
   * is not.
   */
  merges: Record<string, boolean | null> = {},
  /**
   * sheetList batch — tab DELETE (`null`) / rename / reorder, keyed by bare logicalId.
   *
   * The most destructive of the four: deleting a tab destroys every protected cell on it, so leaving
   * it ungated made the cell-level guard trivially bypassable — a non-admin sheets-only PATCH
   * (`{ sheets: { default: null } }`) removed a protected sheet from the workbook outright. Renames
   * and reorders are gated for the same reason a dim resize is: they change how the protected cells
   * present to everyone. Optional so existing callers keep compiling.
   */
  sheets: Record<string, StoredSheetMeta | null> = {},
): void {
  if (isAdmin) return
  const keys = Object.keys(cells)
  const dimKeys = Object.keys(dims)
  const mergeKeys = Object.keys(merges)
  const sheetKeys = Object.keys(sheets)
  if (keys.length === 0 && dimKeys.length === 0 && mergeKeys.length === 0 && sheetKeys.length === 0) return
  const rules = doc.getMap<StoredProtectionRule>(SHEET_PROTECTION_FIELD)
  if (rules.size === 0) return
  const grants = doc.getMap<{ allow?: unknown }>(SHEET_PROTECTION_GRANTS_FIELD)

  /** Per logical sheet: whole-sheet lock + the protected rectangles, each with its permissionId. */
  const bySheet = new Map<string, { whole: string[]; rects: Array<{ rect: ProtectedRect; permissionId: string }> }>()
  /**
   * permissionIds that lock EVERY sheet in the doc, because a rule key was unreadable so we cannot
   * attribute it to a sheet. See the fail-closed note at the `bang < 0` branch below.
   */
  const docWide: string[] = []
  for (const [key, rule] of rules.entries()) {
    const bang = key.indexOf('!')
    if (rule == null || typeof rule !== 'object') {
      // FAIL CLOSED on a rule VALUE we cannot read at all.
      //
      // Third instance of one class: a malformed KEY (below) and malformed BOUNDS (further down) both
      // escalate the extent, but a primitive value used to `continue` — so a single
      // `default!r:r1 -> "junk"` entry made `bySheet` stay empty and this guard early-returned ALLOW
      // on a document that visibly has protection. Same bypass, different field.
      //
      // A primitive carries no permissionId, so the sentinel is the only honest gate: no grant can
      // ever match it, leaving exactly the doc admins (allowed before this loop) able to repair it.
      // The KEY is still readable here, so the escalation stops at that sheet — locking the rest of
      // the document would be a guess, and a wider deny than the evidence supports.
      // `bang <= 0` — NOT `< 0`. An empty logicalId (`'!r:r1'`, `bang === 0`) is just as unreadable
      // as a missing separator: `key.slice(0, 0)` is `''`, and no write key can ever resolve to `''`
      // (every write-key regex demands at least one char before the separator). Attributing the rule
      // to sheet `''` therefore parks it where nothing can ever match, and — because `bySheet.size`
      // becomes 1 — it also defeats the `size === 0 && docWide.length === 0` early return, so the
      // whole loop silently returns ALLOW. That single condition bypassed all four deny paths at
      // once (WS-PROT-10a).
      if (bang <= 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[octo-docs] sheet protection: unreadable rule key AND value — locking the whole document under the ` +
          `admin-only sentinel. A non-admin write will now 403 until an admin repairs this entry. key=${JSON.stringify(key)}`,
        )
        docWide.push(UNPARSEABLE_RULE_PERMISSION_ID)
        continue
      }
      const orphanSheet = key.slice(0, bang)
      // eslint-disable-next-line no-console
      console.warn(
        `[octo-docs] sheet protection: rule VALUE is a primitive (${typeof rule}) — locking sheet ` +
        `${JSON.stringify(orphanSheet)} under the admin-only sentinel. Likely a corrupt map entry or a ` +
        `client version skew, NOT a cell-level permission problem. key=${JSON.stringify(key)}`,
      )
      let orphan = bySheet.get(orphanSheet)
      if (!orphan) { orphan = { whole: [], rects: [] }; bySheet.set(orphanSheet, orphan) }
      orphan.whole.push(UNPARSEABLE_RULE_PERMISSION_ID)
      continue
    }
    const permissionId = typeof rule.permissionId === 'string' && rule.permissionId
      ? rule.permissionId
      : UNPARSEABLE_RULE_PERMISSION_ID
    // `bang <= 0` for the same reason as the value branch above: an empty logicalId cannot be
    // attributed to any sheet, and parking it under `''` silently defeats every deny path
    // downstream (WS-PROT-10a/10b).
    if (bang <= 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[octo-docs] sheet protection: rule KEY cannot be attributed to a sheet — locking the whole document ` +
        `under permissionId=${JSON.stringify(permissionId)}. Granted collaborators and doc admins are unaffected; ` +
        `everyone else will 403 until an admin repairs this entry. key=${JSON.stringify(key)}`,
      )
      // FAIL CLOSED on a rule KEY we cannot attribute to a sheet.
      //
      // Keys are `${logicalId}!r:${ruleId}` / `${logicalId}!w:`. Skipping an unreadable one used to
      // mean the rule vanished: if a client's key shape ever drifts, EVERY rule is skipped, `bySheet`
      // stays empty, and this guard waves through every non-admin write on a doc that visibly has
      // protection — the loudest possible version of the hole this function exists to close.
      //
      // We cannot tell WHICH sheet the rule meant, so the conservative extent is the whole document,
      // gated by the rule's own permissionId (sentinel when that is unreadable too) so granted
      // collaborators and doc admins are unaffected and an admin can repair the rule.
      docWide.push(permissionId)
      continue
    }
    const logicalId = key.slice(0, bang)
    const kind = key.slice(bang + 1, bang + 2)
    let entry = bySheet.get(logicalId)
    if (!entry) { entry = { whole: [], rects: [] }; bySheet.set(logicalId, entry) }

    // FAIL CLOSED on a rule we cannot fully parse.
    //
    // A rule only exists in this map because an admin performed a protect action, so its PRESENCE is
    // the intent. Not being able to read it (missing permissionId, garbage bounds, a field shape from
    // a newer client) means we do not know the extent — NOT that nothing is protected. The first cut
    // skipped such rules, so one unparseable entry silently removed the protection and let the write
    // through: a corrupted or version-skewed rule became an authorization bypass.
    //
    // Unreadable => treat the whole sheet as locked, under a sentinel permissionId no grant can ever
    // match, so nobody but a doc admin gets in. Admins are allowed before we reach here, which is
    // what keeps a damaged rule fixable instead of wedging the sheet permanently.
    if (permissionId === UNPARSEABLE_RULE_PERMISSION_ID) {
      entry.whole.push(UNPARSEABLE_RULE_PERMISSION_ID)
      continue
    }
    if (kind === 'w') {
      entry.whole.push(permissionId)
      continue
    }
    const { rects, malformed } = readRects(rule.ranges)
    if (malformed) {
      // FAIL CLOSED on a PARTIALLY readable rule.
      //
      // This is the case that used to leak. `ranges: [<junk>, <good rect>]` yielded one usable rect,
      // so the sheet was protected over the good rect ONLY and a non-admin could write freely into
      // the area the junk element was meant to cover. The rule's existence proves an admin protected
      // SOMETHING there; a shape we cannot read means we do not know the extent, which is exactly the
      // "we cannot answer confidently" condition the rest of this function denies on.
      //
      // So: any unreadable element escalates the whole sheet to locked, under the rule's OWN
      // permissionId — not the sentinel. A collaborator the admin already granted keeps their access
      // instead of being locked out by a client-shape drift they had no part in, and doc admins are
      // allowed above, which is what keeps the damaged rule repairable.
      //
      // This deliberately supersedes the earlier "keep rectangle precision, do not over-lock on a
      // junk sibling" tradeoff. Over-locking is recoverable (an admin edits the rule); under-locking
      // is a silent authorization bypass on the exact path this guard exists to close.
      entry.whole.push(permissionId)
      continue
    }
    if (rects.length === 0) {
      // A well-formed but EMPTY `ranges` (whole-column / whole-row rules land here): unknown extent,
      // so the conservative reading is "all of this sheet", still gated by the rule's own
      // permissionId so a granted collaborator is not locked out by a bounds-parsing failure.
      entry.whole.push(permissionId)
      continue
    }
    for (const rect of rects) entry.rects.push({ rect, permissionId })
  }
  if (bySheet.size === 0 && docWide.length === 0) return

  /** May `uid` edit the object this permissionId protects? */
  const permits = (permissionId: string): boolean => {
    const grant = grants.get(permissionId)
    const allow = grant && Array.isArray(grant.allow) ? grant.allow : null
    // No grant record => nobody but an admin was granted (fail closed).
    if (!allow) return false
    return allow.some((u) => u === uid)
  }
  // permissionId -> decision, so a 1000-cell batch over one rule resolves the grant once.
  const permitCache = new Map<string, boolean>()
  const permitted = (permissionId: string): boolean => {
    let v = permitCache.get(permissionId)
    if (v === undefined) { v = permits(permissionId); permitCache.set(permissionId, v) }
    return v
  }

  /**
   * A rule whose key we could not attribute to a sheet locks the ENTIRE document for anyone the
   * rule does not grant. Evaluated once: it does not depend on the key being written.
   */
  const docWideBlocked = docWide.some((permissionId) => !permitted(permissionId))

  const refused: string[] = []
  for (const key of keys) {
    const bang = key.indexOf('!')
    if (bang < 0) continue
    const entry = bySheet.get(key.slice(0, bang))
    if (!entry && !docWideBlocked) continue
    const [rowStr, colStr] = key.slice(bang + 1).split(':')
    const row = Number(rowStr)
    const col = Number(colStr)
    if (!Number.isInteger(row) || !Number.isInteger(col)) continue
    let blocked = docWideBlocked
    if (!blocked && entry) {
      for (const permissionId of entry.whole) {
        if (!permitted(permissionId)) { blocked = true; break }
      }
      if (!blocked) {
        for (const { rect, permissionId } of entry.rects) {
          if (row < rect.startRow || row > rect.endRow || col < rect.startColumn || col > rect.endColumn) continue
          if (!permitted(permissionId)) { blocked = true; break }
        }
      }
    }
    if (blocked) refused.push(key)
  }

  /** Is any permissionId guarding this sheet as a WHOLE denied to `uid`? */
  const wholeSheetBlocked = (entry: { whole: string[] }): boolean =>
    entry.whole.some((permissionId) => !permitted(permissionId))

  // ── dims: `${logicalId}:c<idx>` / `${logicalId}:r<idx>` ────────────────────────────────────
  // NOTE the sheet prefix is OPTIONAL in DIMS_KEY_RE (`c5` is a legal key, addressing the legacy
  // single-sheet doc). Missing that branch would silently wave those writes through, so an
  // unprefixed key is attributed to the legacy 'default' sheet — the same id binding.ts seeds.
  for (const key of dimKeys) {
    const colon = key.lastIndexOf(':')
    const logicalId = colon < 0 ? DEFAULT_LOGICAL_SHEET_ID : key.slice(0, colon)
    const axisPart = colon < 0 ? key : key.slice(colon + 1)
    const entry = bySheet.get(logicalId)
    if (!entry && !docWideBlocked) continue
    const axis = axisPart.slice(0, 1)
    const idx = Number(axisPart.slice(1))
    if ((axis !== 'c' && axis !== 'r') || !Number.isInteger(idx)) continue
    let blocked = docWideBlocked || (entry ? wholeSheetBlocked(entry) : false)
    if (!blocked && entry) {
      for (const { rect, permissionId } of entry.rects) {
        // A column crosses the rect when its index is within [startColumn,endColumn]; a row when
        // within [startRow,endRow]. Deliberately conservative: resizing a line that cuts through a
        // protected rectangle is refused even though cells outside the rect also move.
        const crosses = axis === 'c'
          ? idx >= rect.startColumn && idx <= rect.endColumn
          : idx >= rect.startRow && idx <= rect.endRow
        if (!crosses) continue
        if (!permitted(permissionId)) { blocked = true; break }
      }
    }
    if (blocked) refused.push(key)
  }

  // ── merges: `${logicalId}:sr:sc:er:ec` (exactly 5 colon-separated parts) ───────────────────
  for (const key of mergeKeys) {
    const parts = key.split(':')
    if (parts.length !== 5) continue
    const entry = bySheet.get(parts[0]!)
    if (!entry && !docWideBlocked) continue
    const sr = Number(parts[1]); const sc = Number(parts[2])
    const er = Number(parts[3]); const ec = Number(parts[4])
    if (![sr, sc, er, ec].every((n) => Number.isInteger(n))) continue
    let blocked = docWideBlocked || (entry ? wholeSheetBlocked(entry) : false)
    if (!blocked && entry) {
      for (const { rect, permissionId } of entry.rects) {
        // Rectangle INTERSECTION (not containment): a merge that merely overlaps a protected range
        // still restructures the protected cells, so any overlap is enough to refuse.
        const disjoint = er < rect.startRow || sr > rect.endRow || ec < rect.startColumn || sc > rect.endColumn
        if (disjoint) continue
        if (!permitted(permissionId)) { blocked = true; break }
      }
    }
    if (blocked) refused.push(key)
  }

  // ── sheets: bare `${logicalId}` (no separator) — tab delete / rename / reorder ─────────────
  // Scope rule differs from cells/dims/merges: those address a POSITION inside a sheet, so they are
  // refused only when that position meets a rule. A sheetList key addresses the SHEET ITSELF, so
  // ANY rule on that sheet is enough — a range rule counts too, because deleting the tab destroys
  // the protected rectangle along with everything else. There is no coordinate to intersect, hence
  // no rect loop here: `whole` OR a non-empty `rects` both mean "this sheet carries protection".
  for (const key of sheetKeys) {
    const entry = bySheet.get(key)
    if (!entry && !docWideBlocked) continue
    let blocked = docWideBlocked
    if (!blocked && entry) {
      blocked = wholeSheetBlocked(entry)
        || entry.rects.some(({ permissionId }) => !permitted(permissionId))
    }
    if (blocked) refused.push(key)
  }

  if (refused.length > 0) throw new ProtectedRangeError(refused)
}

/** Max cell-key length — a canonical `${sheetId}!${row}:${col}` is far shorter. */
const MAX_CELL_KEY_LEN = 256
/** Canonical cell-key shape: `<sheetId>!<row>:<col>` (row/col non-negative ints). */
const CELL_KEY_RE = /^[^!]{1,64}![0-9]{1,7}:[0-9]{1,7}$/

/**
 * Validate a single raw cell key + value against the `{v,f,s,p,t}` contract.
 * Fail-closed: throws SheetSnapshotInvalidError on any deviation. Returns a
 * NEW object containing only the contract fields (drops nothing valid, strips
 * nothing — a well-formed cell round-trips byte-for-byte in content).
 *
 * The field set mirrors the live sync schema (octo-web SyncCell): `v/f/s` plus
 * the rich-cell fields `p` (rich-text/inline-image body) and `t` (cell type)
 * that the editor and CLI/bot writers both emit. All are round-tripped verbatim.
 *
 * Rules:
 *  - key: canonical `${sheetId}!${row}:${col}` shape, length-bounded.
 *  - value: a plain object; only keys v/f/s/p/t permitted.
 *  - v: string | number | boolean | null (if present).
 *  - f: string (if present).
 *  - s: plain object (resolved IStyleData; opaque here) (if present).
 *  - p: plain object (rich-text snapshot; opaque here) (if present).
 *  - t: finite number (cell type; opaque here) (if present).
 *  - at least one of v/f/s/p/t present (no empty cell).
 */
export function validateSheetCell(key: unknown, value: unknown): SheetCell {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_CELL_KEY_LEN) {
    throw new SheetSnapshotInvalidError(`invalid cell key (type/length)`)
  }
  if (!CELL_KEY_RE.test(key)) {
    throw new SheetSnapshotInvalidError(`cell key does not match ${'${sheetId}!${row}:${col}'}: ${key.slice(0, 64)}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SheetSnapshotInvalidError(`cell ${key}: value is not a plain object`)
  }
  const rec = value as Record<string, unknown>
  for (const k of Object.keys(rec)) {
    if (k !== 'v' && k !== 'f' && k !== 's' && k !== 'p' && k !== 't') {
      throw new SheetSnapshotInvalidError(`cell ${key}: unexpected field '${k}'`)
    }
  }
  const out: SheetCell = {}
  if ('v' in rec) {
    const v = rec.v
    if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      throw new SheetSnapshotInvalidError(`cell ${key}: v has invalid type`)
    }
    // A numeric `v` must be finite. Infinity / -Infinity / NaN pass the typeof
    // check but JSON.stringify serializes them to `null`, so they both mis-measure
    // at the size gate (JSON.stringify(Infinity) === 'null') and round-trip through
    // GET as a silent `{"v":null}` — a write-surface data loss. Reject fail-closed,
    // mirroring validateSheetDim's Number.isFinite guard.
    if (typeof v === 'number' && !Number.isFinite(v)) {
      throw new SheetSnapshotInvalidError(`cell ${key}: v must be a finite number`)
    }
    out.v = v as SheetCell['v']
  }
  if ('f' in rec) {
    if (typeof rec.f !== 'string') throw new SheetSnapshotInvalidError(`cell ${key}: f is not a string`)
    out.f = rec.f
  }
  if ('s' in rec) {
    const s = rec.s
    if (s === null || typeof s !== 'object' || Array.isArray(s)) {
      throw new SheetSnapshotInvalidError(`cell ${key}: s is not a plain object`)
    }
    out.s = s as Record<string, unknown>
  }
  // `p` (rich-text snapshot / inline image) is opaque, treated exactly like `s`:
  // a plain object, preserved verbatim so a human-authored image cell round-trips.
  if ('p' in rec) {
    const p = rec.p
    if (p === null || typeof p !== 'object' || Array.isArray(p)) {
      throw new SheetSnapshotInvalidError(`cell ${key}: p is not a plain object`)
    }
    out.p = p as Record<string, unknown>
  }
  if ('t' in rec) {
    const t = rec.t
    // Cell type is a small enum in the live schema; validate it as a finite
    // number (rejecting NaN / Infinity, which JSON.stringify would silently turn
    // into `null`, matching the `v` guard) and round-trip it verbatim.
    if (typeof t !== 'number' || !Number.isFinite(t)) {
      throw new SheetSnapshotInvalidError(`cell ${key}: t must be a finite number`)
    }
    out.t = t
  }
  if (
    out.v === undefined &&
    out.f === undefined &&
    out.s === undefined &&
    out.p === undefined &&
    out.t === undefined
  ) {
    throw new SheetSnapshotInvalidError(`cell ${key}: empty cell (none of v/f/s/p/t present)`)
  }
  return out
}

/**
 * Validate + sanitize a whole `{ key: cell }` map, fail-closed. Returns a new
 * map of validated cells. Used on BOTH the HTTP-return path (preview) and the
 * restore-replay path so no writer-controlled value reaches a client or the
 * live doc without passing the contract gate.
 */
export function validateSheetCells(cells: Record<string, unknown>): Record<string, SheetCell> {
  const out: Record<string, SheetCell> = {}
  for (const [key, val] of Object.entries(cells)) out[key] = validateSheetCell(key, val)
  return out
}

/** Canonical dims-key shape: `${logicalId}:c<idx>` / `${logicalId}:r<idx>` (V2
 * multi-sheet) OR bare `c<idx>` / `r<idx>` (V1 single-sheet, still accepted).
 * logicalId carries no colon. MUST match octo-web binding.ts: V1 wrote dims keys
 * UNPREFIXED; V2 prefixes them with the logical sheet id so per-sheet column widths
 * / row heights don't collide. The optional prefix lets a bot address a specific
 * sheet's dims (e.g. `default:c0`, `sheet-2:r3`). */
const DIMS_KEY_RE = /^([^:]{1,64}:)?[cr][0-9]{1,7}$/
/** Max dimension (px) — guards against a hostile/absurd width or height. */
const MAX_DIM_PX = 100000

/**
 * Validate a single raw sheetDims key + value against the dims contract.
 * Fail-closed: throws SheetSnapshotInvalidError on any deviation. Keys are
 * `c<idx>`/`r<idx>`; values must be a positive finite number (pixels).
 */
export function validateSheetDim(key: unknown, value: unknown): number {
  if (typeof key !== 'string' || !DIMS_KEY_RE.test(key)) {
    throw new SheetSnapshotInvalidError(`dims key does not match c<idx>/r<idx>: ${String(key).slice(0, 64)}`)
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_DIM_PX) {
    throw new SheetSnapshotInvalidError(`dims ${key}: value must be a positive finite number <= ${MAX_DIM_PX}`)
  }
  return value
}

/**
 * Validate + sanitize a whole `{ key: number }` dims map, fail-closed. Returns a
 * new map of validated dimensions. Used on BOTH the HTTP-return path (preview)
 * and the restore-replay path — the dims counterpart of validateSheetCells.
 */
export function validateSheetDims(dims: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, val] of Object.entries(dims)) out[key] = validateSheetDim(key, val)
  return out
}

/**
 * Read: Y.Doc binary state -> plain `{ key: cell }` map (for a bot to understand
 * the current sheet). Keys are the canonical `${sheetId}!${row}:${col}` form.
 */
export function yDocStateToSheetCells(state: Uint8Array): Record<string, SheetCell> {
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, state)
  const ymap = ydoc.getMap<SheetCell>(SHEET_YMAP_FIELD)
  const out: Record<string, SheetCell> = {}
  for (const [key, cell] of ymap.entries()) out[key] = cell
  return out
}

/**
 * The split of a `{ key: cell|null }` edit batch into deletions and validated
 * upserts — the output of the shared, DB-free, live-infra-free validation pass.
 */
export interface SheetCellBatch {
  toDelete: string[]
  toSet: Array<[string, SheetCell]>
}

/**
 * Validate a whole `{ key: cell|null }` edit batch WITHOUT mutating anything,
 * fail-closed. A null value is a deletion (key-shape-checked so a malformed key
 * cannot be smuggled in); any other value is validated against the `{v,f,s,p,t}`
 * contract. Throws SheetSnapshotInvalidError on the first deviation.
 *
 * Split out from applySheetCellsToYMap so the HTTP write path can run the exact
 * same contract check in its no-lock pre-flight (fail a bad batch with 422
 * before opening the live write connection) that the live mutation runs — one
 * source of truth for the cell contract, never two subtly different validators.
 */
export function validateSheetCellBatch(cells: Record<string, SheetCell | null>): SheetCellBatch {
  const toDelete: string[] = []
  const toSet: Array<[string, SheetCell]> = []
  for (const [key, cell] of Object.entries(cells)) {
    if (cell == null) {
      // Deletion is always safe; a hostile key simply targets a nonexistent
      // entry. We still key-shape-check so a malformed key can't be smuggled in.
      if (typeof key === 'string' && CELL_KEY_RE.test(key)) toDelete.push(key)
      else throw new SheetSnapshotInvalidError(`delete: invalid cell key ${String(key).slice(0, 64)}`)
    } else {
      // Fail-closed: validate the {v,f,s,p,t} contract before writing into the doc.
      toSet.push([key, validateSheetCell(key, cell)])
    }
  }
  return { toDelete, toSet }
}

/**
 * Pure mutation applied INSIDE a Yjs transaction (live doc or transient).
 * A null/undefined cell deletes the key; otherwise it is set. Caller owns the
 * transaction so the whole edit lands as one update (one broadcast).
 */
export function applySheetCellsToYMap(
  ymap: Y.Map<SheetCell>,
  cells: Record<string, SheetCell | null>,
): void {
  // Two-pass, validate-all-then-apply — mirrors reconcileSheetMap's discipline.
  // A mixed batch { valid, invalid } must NOT half-apply: Yjs does not roll back
  // mutations on a thrown transaction callback, and the live caller flushes on
  // disconnect, so a per-iteration set()-then-throw would broadcast a partial
  // write. Validate every entry FIRST; only mutate once the whole batch is known
  // good.
  const { toDelete, toSet } = validateSheetCellBatch(cells)
  for (const key of toDelete) ymap.delete(key)
  for (const [key, cell] of toSet) ymap.set(key, cell)
}

export interface SheetDimBatch {
  toDelete: string[]
  toSet: Array<[string, number]>
}

/**
 * Validate a whole `{ key: number|null }` dims edit batch WITHOUT mutating,
 * fail-closed. A null value is a deletion (key-shape-checked so a malformed key
 * cannot be smuggled in); any other value is validated against the dims contract
 * (`c<idx>`/`r<idx>` key, positive finite px <= MAX_DIM_PX). The dims counterpart
 * of validateSheetCellBatch — one source of truth for the dims contract, shared
 * by the HTTP write path's no-lock pre-flight and the live mutation.
 */
export function validateSheetDimBatch(dims: Record<string, number | null>): SheetDimBatch {
  const toDelete: string[] = []
  const toSet: Array<[string, number]> = []
  for (const [key, val] of Object.entries(dims)) {
    if (val == null) {
      if (typeof key === 'string' && DIMS_KEY_RE.test(key)) toDelete.push(key)
      else throw new SheetSnapshotInvalidError(`delete: invalid dims key ${String(key).slice(0, 64)}`)
    } else {
      toSet.push([key, validateSheetDim(key, val)])
    }
  }
  return { toDelete, toSet }
}

/**
 * Pure mutation applied INSIDE a Yjs transaction (live doc or transient). A null
 * value deletes the dims key; otherwise it is set. Validate-all-then-apply
 * (mirrors applySheetCellsToYMap) so a mixed { valid, invalid } batch never
 * half-applies.
 */
export function applySheetDimsToYMap(
  ymap: Y.Map<number>,
  dims: Record<string, number | null>,
): void {
  const { toDelete, toSet } = validateSheetDimBatch(dims)
  for (const key of toDelete) ymap.delete(key)
  for (const [key, px] of toSet) ymap.set(key, px)
}

/** A serialized Univer floating image/drawing. Opaque beyond `drawingId` — it
 * carries transform / cell-anchor / inline base64 `source`; we store it verbatim
 * (like a cell's `s`/`p`) so it round-trips to the web binding. */
export interface StoredDrawing {
  drawingId: string
  [k: string]: unknown
}

export interface SheetDrawingBatch {
  toDelete: string[]
  toSet: Array<[string, StoredDrawing]>
}

/** Canonical drawing-key shape: `${sheetId}!${drawingId}` (drawingId alnum/-/_). */
const DRAWING_KEY_RE = /^[^!]{1,64}![A-Za-z0-9_-]{1,64}$/

/**
 * Validate a single raw drawing key + value. Fail-closed. The value is kept
 * opaque (a Univer ISheetImage — transform / source / anchor) EXCEPT `drawingId`,
 * which must be a non-empty string equal to the key's drawingId segment (so a
 * hostile key can't point at a different id). Returns the object verbatim.
 */
export function validateSheetDrawing(key: unknown, value: unknown): StoredDrawing {
  if (typeof key !== 'string' || !DRAWING_KEY_RE.test(key)) {
    throw new SheetSnapshotInvalidError(
      `drawing key does not match ${'${sheetId}!${drawingId}'}: ${String(key).slice(0, 64)}`,
    )
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SheetSnapshotInvalidError(`drawing ${key}: value is not a plain object`)
  }
  const rec = value as Record<string, unknown>
  const keyDrawingId = key.slice(key.indexOf('!') + 1)
  if (typeof rec.drawingId !== 'string' || rec.drawingId !== keyDrawingId) {
    throw new SheetSnapshotInvalidError(
      `drawing ${key}: drawingId must be the string "${keyDrawingId}" (key segment)`,
    )
  }
  return rec as StoredDrawing
}

/**
 * Validate a whole `{ key: drawing|null }` batch WITHOUT mutating, fail-closed.
 * null = delete (key-shape-checked); else validated via validateSheetDrawing.
 * The drawings counterpart of validateSheetDimBatch.
 */
export function validateSheetDrawingBatch(
  drawings: Record<string, StoredDrawing | null>,
): SheetDrawingBatch {
  const toDelete: string[] = []
  const toSet: Array<[string, StoredDrawing]> = []
  for (const [key, val] of Object.entries(drawings)) {
    if (val == null) {
      if (typeof key === 'string' && DRAWING_KEY_RE.test(key)) toDelete.push(key)
      else throw new SheetSnapshotInvalidError(`delete: invalid drawing key ${String(key).slice(0, 64)}`)
    } else {
      toSet.push([key, validateSheetDrawing(key, val)])
    }
  }
  return { toDelete, toSet }
}

/**
 * Pure mutation applied INSIDE a Yjs transaction. A null value deletes the
 * drawing; otherwise it is set. Validate-all-then-apply (mirrors the cell/dim
 * appliers) so a mixed batch never half-applies.
 */
export function applySheetDrawingsToYMap(
  ymap: Y.Map<StoredDrawing>,
  drawings: Record<string, StoredDrawing | null>,
): void {
  const { toDelete, toSet } = validateSheetDrawingBatch(drawings)
  for (const key of toDelete) ymap.delete(key)
  for (const [key, d] of toSet) ymap.set(key, d)
}

/** A cell hyperlink (Univer ISheetHyperLink). Lives in the sheetHyperLinks map,
 * NOT in cell data; points at a cell by row/column. `payload` is the URL, `display`
 * an optional label. Extra fields are kept verbatim (opaque), like a drawing. */
export interface StoredHyperLink {
  id: string
  row: number
  column: number
  payload: string
  display?: string
  [k: string]: unknown
}

export interface SheetHyperLinkBatch {
  toDelete: string[]
  toSet: Array<[string, StoredHyperLink]>
}

/** Canonical hyperlink-key shape: `${sheetId}!${linkId}` (linkId alnum/-/_). */
const HYPERLINK_KEY_RE = /^[^!]{1,64}![A-Za-z0-9_-]{1,64}$/

/**
 * URL schemes a stored hyperlink payload may use. Mirrors the frontend's
 * sanitizeLinkHref: http/https/mailto, or an internal in-sheet jump (`#…`).
 * Fail-closed rejects javascript:/data: etc. so a stored link can't smuggle a
 * script URL to every client that later renders it.
 */
function isSafeHyperlinkPayload(payload: string): boolean {
  if (payload.startsWith('#')) return true // internal jump, e.g. #gid=sheet1&range=A1
  return /^(https?:|mailto:)/i.test(payload)
}

/**
 * Validate a single raw hyperlink key + value. Fail-closed. `id` must equal the
 * key's linkId segment (a hostile key can't point at a different id); `row`/`column`
 * are non-negative integers (the anchored cell); `payload` is a safe-scheme URL;
 * `display` is optional string. Extra fields round-trip verbatim (opaque), matching
 * the drawing validator, so a forward-compatible field is preserved.
 */
export function validateSheetHyperLink(key: unknown, value: unknown): StoredHyperLink {
  if (typeof key !== 'string' || !HYPERLINK_KEY_RE.test(key)) {
    throw new SheetSnapshotInvalidError(
      `hyperlink key does not match ${'${sheetId}!${linkId}'}: ${String(key).slice(0, 64)}`,
    )
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SheetSnapshotInvalidError(`hyperlink ${key}: value is not a plain object`)
  }
  const rec = value as Record<string, unknown>
  const keyLinkId = key.slice(key.indexOf('!') + 1)
  if (typeof rec.id !== 'string' || rec.id !== keyLinkId) {
    throw new SheetSnapshotInvalidError(
      `hyperlink ${key}: id must be the string "${keyLinkId}" (key segment)`,
    )
  }
  for (const f of ['row', 'column'] as const) {
    const n = rec[f]
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
      throw new SheetSnapshotInvalidError(`hyperlink ${key}: ${f} must be a non-negative integer`)
    }
  }
  if (typeof rec.payload !== 'string' || rec.payload.length === 0) {
    throw new SheetSnapshotInvalidError(`hyperlink ${key}: payload (url) must be a non-empty string`)
  }
  if (!isSafeHyperlinkPayload(rec.payload)) {
    throw new SheetSnapshotInvalidError(
      `hyperlink ${key}: payload must be http/https/mailto or an internal #jump`,
    )
  }
  if ('display' in rec && rec.display !== undefined && typeof rec.display !== 'string') {
    throw new SheetSnapshotInvalidError(`hyperlink ${key}: display must be a string`)
  }
  return rec as StoredHyperLink
}

/**
 * Validate a whole `{ key: hyperlink|null }` batch WITHOUT mutating, fail-closed.
 * null = delete (key-shape-checked); else validated via validateSheetHyperLink.
 * The hyperlinks counterpart of validateSheetDrawingBatch.
 */
export function validateSheetHyperLinkBatch(
  links: Record<string, StoredHyperLink | null>,
): SheetHyperLinkBatch {
  const toDelete: string[] = []
  const toSet: Array<[string, StoredHyperLink]> = []
  for (const [key, val] of Object.entries(links)) {
    if (val == null) {
      if (typeof key === 'string' && HYPERLINK_KEY_RE.test(key)) toDelete.push(key)
      else throw new SheetSnapshotInvalidError(`delete: invalid hyperlink key ${String(key).slice(0, 64)}`)
    } else {
      toSet.push([key, validateSheetHyperLink(key, val)])
    }
  }
  return { toDelete, toSet }
}

/**
 * Pure mutation applied INSIDE a Yjs transaction. A null value deletes the link;
 * otherwise it is set. Validate-all-then-apply (mirrors the other appliers).
 */
export function applySheetHyperLinksToYMap(
  ymap: Y.Map<StoredHyperLink>,
  links: Record<string, StoredHyperLink | null>,
): void {
  const { toDelete, toSet } = validateSheetHyperLinkBatch(links)
  for (const key of toDelete) ymap.delete(key)
  for (const [key, link] of toSet) ymap.set(key, link)
}

/** Read: Y.Doc state -> plain `{ key: hyperlink }` map (part of the GET surface). */
export function yDocStateToSheetHyperLinks(state: Uint8Array): Record<string, StoredHyperLink> {
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, state)
  const ymap = ydoc.getMap<StoredHyperLink>(SHEET_HYPERLINKS_FIELD)
  const out: Record<string, StoredHyperLink> = {}
  for (const [key, link] of ymap.entries()) out[key] = link
  return out
}

/** Validate a whole `{ key: hyperlink }` map (read/restore path). */
export function validateSheetHyperLinks(
  links: Record<string, unknown>,
): Record<string, StoredHyperLink> {
  const out: Record<string, StoredHyperLink> = {}
  for (const [key, val] of Object.entries(links)) out[key] = validateSheetHyperLink(key, val)
  return out
}

/**
 * A merged-cell-range batch split into un-merges (deletions) and merges (upserts).
 * The value is always boolean `true` (a range is merged); un-merge is a key
 * deletion. Mirrors the frontend's `mergeMap.set(key, true)` / `mergeMap.delete(key)`.
 */
export interface SheetMergeBatch {
  toDelete: string[]
  toSet: Array<[string, true]>
}

/** Canonical merge-key shape: `${logicalId}:sr:sc:er:ec` (logicalId + four 0-based
 * ints startRow:startCol:endRow:endCol). logicalId carries no colon. MUST match
 * octo-web binding.ts SHEET_MERGES_FIELD keys. */
const MERGES_KEY_RE = /^[^:]{1,64}:[0-9]{1,7}:[0-9]{1,7}:[0-9]{1,7}:[0-9]{1,7}$/

/**
 * Validate a single raw merge key + value. Fail-closed. Key must be the canonical
 * `${logicalId}:sr:sc:er:ec` shape; value must be boolean `true` — the only value
 * the frontend ever writes (un-merge is a key deletion, handled in the batch).
 */
export function validateSheetMerge(key: unknown, value: unknown): true {
  if (typeof key !== 'string' || !MERGES_KEY_RE.test(key)) {
    throw new SheetSnapshotInvalidError(
      `merge key does not match ${'${logicalId}:sr:sc:er:ec'}: ${String(key).slice(0, 64)}`,
    )
  }
  if (value !== true) {
    throw new SheetSnapshotInvalidError(`merge ${key}: value must be boolean true (un-merge = delete the key)`)
  }
  // logicalId carries no colon (MERGES_KEY_RE), so the last four segments are
  // sr:sc:er:ec. A bot can now write these keys directly (no frontend in the
  // loop), so guard coordinate ordering here — a start-after-end range like
  // `default:10:8:2:1` would otherwise persist as an internally-inconsistent
  // merge. Cheap defense-in-depth; the frontend only ever emits ordered ranges.
  const parts = key.split(':')
  const sr = Number(parts.at(-4))
  const sc = Number(parts.at(-3))
  const er = Number(parts.at(-2))
  const ec = Number(parts.at(-1))
  if (sr > er || sc > ec) {
    throw new SheetSnapshotInvalidError(
      `merge ${key}: inverted range (startRow<=endRow and startCol<=endCol required)`,
    )
  }
  return true
}

/**
 * Validate a whole `{ key: true|null }` merges batch WITHOUT mutating, fail-closed.
 * null = un-merge (delete; key-shape-checked so a malformed key can't be smuggled
 * in); true = merge. The merges counterpart of validateSheetDimBatch.
 */
export function validateSheetMergeBatch(
  merges: Record<string, boolean | null>,
): SheetMergeBatch {
  const toDelete: string[] = []
  const toSet: Array<[string, true]> = []
  for (const [key, val] of Object.entries(merges)) {
    if (val == null) {
      if (typeof key === 'string' && MERGES_KEY_RE.test(key)) toDelete.push(key)
      else throw new SheetSnapshotInvalidError(`delete: invalid merge key ${String(key).slice(0, 64)}`)
    } else {
      toSet.push([key, validateSheetMerge(key, val)])
    }
  }
  return { toDelete, toSet }
}

/**
 * Pure mutation applied INSIDE a Yjs transaction. A null value un-merges (deletes
 * the key); true merges. Validate-all-then-apply (mirrors the other appliers).
 */
export function applySheetMergesToYMap(
  ymap: Y.Map<boolean>,
  merges: Record<string, boolean | null>,
): void {
  const { toDelete, toSet } = validateSheetMergeBatch(merges)
  for (const key of toDelete) ymap.delete(key)
  for (const [key, v] of toSet) ymap.set(key, v)
}

/** Read: Y.Doc state -> plain `{ key: true }` merges map (part of the GET surface). */
export function yDocStateToSheetMerges(state: Uint8Array): Record<string, boolean> {
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, state)
  const ymap = ydoc.getMap<boolean>(SHEET_MERGES_FIELD)
  const out: Record<string, boolean> = Object.create(null)
  for (const [key, val] of ymap.entries()) out[key] = val
  return out
}

/** Validate a whole `{ key: true }` merges map (read/restore path). */
export function validateSheetMerges(merges: Record<string, unknown>): Record<string, true> {
  const out: Record<string, true> = Object.create(null)
  for (const [key, val] of Object.entries(merges)) out[key] = validateSheetMerge(key, val)
  return out
}

/** A sheet-tab registry entry (Univer SheetMeta): the tab's display name + order.
 * Extra fields are kept verbatim (opaque), like a drawing. */
export interface StoredSheetMeta {
  name: string
  order: number
  [k: string]: unknown
}

export interface SheetListBatch {
  toDelete: string[]
  toSet: Array<[string, StoredSheetMeta]>
}

/** Canonical sheetList key: a logicalId carrying no ':' or '!' (so it stays
 * disjoint from cell / dims / merge keys) and no control chars / DEL (it is
 * concatenated into cell keys `${logicalId}!row:col`, so keep it a printable id).
 * The first tab's logicalId is 'default'. */
const LIST_KEY_RE = /^[^\p{Cc}:!]{1,64}$/u

/** logicalIds that collide with `Object.prototype` slots. sheetList is the first
 * sheet keyspace that accepts a bare identifier (cell/dims/merge/hyperlink keys all
 * carry ':' or '!' so they structurally cannot be these), so it is the only surface
 * where a key like `__proto__` could ever poison a plain-object read map. We
 * defend in depth — the decode/validate maps are built with `Object.create(null)`
 * and reconcile uses `Object.hasOwn` — but we ALSO reject these outright so a bot
 * gets a clean 422 instead of a silently-dropped tab. */
const RESERVED_LOGICAL_IDS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Validate a single raw sheetList entry. Fail-closed. Key is a logicalId; value is
 * `{ name: non-empty string, order: finite number }` (extra fields kept verbatim).
 * This is the tab registry — a bot ADDS a tab by setting a new logicalId here, then
 * writes that tab's cells with keys `${logicalId}!row:col`.
 */
export function validateSheetListEntry(key: unknown, value: unknown): StoredSheetMeta {
  if (typeof key !== 'string' || !LIST_KEY_RE.test(key)) {
    throw new SheetSnapshotInvalidError(
      `sheetList key must be a logicalId (no ':', '!' or control chars): ${String(key).slice(0, 64)}`,
    )
  }
  if (RESERVED_LOGICAL_IDS.has(key)) {
    throw new SheetSnapshotInvalidError(
      `sheetList key is a reserved logicalId and not allowed: ${key}`,
    )
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SheetSnapshotInvalidError(`sheetList ${key}: value is not a plain object`)
  }
  const rec = value as Record<string, unknown>
  if (typeof rec.name !== 'string' || rec.name.length === 0) {
    throw new SheetSnapshotInvalidError(`sheetList ${key}: name must be a non-empty string`)
  }
  if (typeof rec.order !== 'number' || !Number.isFinite(rec.order)) {
    throw new SheetSnapshotInvalidError(`sheetList ${key}: order must be a finite number`)
  }
  return rec as StoredSheetMeta
}

/**
 * Validate a whole `{ logicalId: meta|null }` sheetList batch WITHOUT mutating,
 * fail-closed. null = delete a tab (key-shape-checked); else validated via
 * validateSheetListEntry. The sheetList counterpart of validateSheetDrawingBatch.
 */
export function validateSheetListBatch(
  sheets: Record<string, StoredSheetMeta | null>,
): SheetListBatch {
  const toDelete: string[] = []
  const toSet: Array<[string, StoredSheetMeta]> = []
  for (const [key, val] of Object.entries(sheets)) {
    if (val == null) {
      if (typeof key === 'string' && LIST_KEY_RE.test(key) && !RESERVED_LOGICAL_IDS.has(key)) toDelete.push(key)
      else throw new SheetSnapshotInvalidError(`delete: invalid sheetList key ${String(key).slice(0, 64)}`)
    } else {
      toSet.push([key, validateSheetListEntry(key, val)])
    }
  }
  return { toDelete, toSet }
}

/** Pure mutation applied INSIDE a Yjs transaction. Validate-all-then-apply. */
export function applySheetListToYMap(
  ymap: Y.Map<StoredSheetMeta>,
  sheets: Record<string, StoredSheetMeta | null>,
): void {
  const { toDelete, toSet } = validateSheetListBatch(sheets)
  for (const key of toDelete) ymap.delete(key)
  for (const [key, meta] of toSet) ymap.set(key, meta)
}

/** Read: Y.Doc state -> plain `{ logicalId: {name,order} }` map (GET read surface). */
export function yDocStateToSheetList(state: Uint8Array): Record<string, StoredSheetMeta> {
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, state)
  const ymap = ydoc.getMap<StoredSheetMeta>(SHEET_LIST_FIELD)
  const out: Record<string, StoredSheetMeta> = Object.create(null)
  for (const [key, meta] of ymap.entries()) out[key] = meta
  return out
}

/** Validate a whole sheetList map (read/restore path). */
export function validateSheetList(sheets: Record<string, unknown>): Record<string, StoredSheetMeta> {
  const out: Record<string, StoredSheetMeta> = Object.create(null)
  for (const [key, val] of Object.entries(sheets)) out[key] = validateSheetListEntry(key, val)
  return out
}

/**
 * Measure the sheet AFTER applying an edit batch, the two ways its downstream
 * caps are enforced, so the write path can reject an oversized result in its
 * no-lock pre-flight — BEFORE commitLiveSheetEdit applies the cells to the shared
 * live Y.Doc, broadcasts them to peers, and only then fails at persistence.store.
 * The sheet counterpart of docBodyEdit.sizeAfterEdit's 413 gate.
 *
 *   - docBytes: the encoded Y.Doc update length, hydrated from the LIVE
 *     `preEditState` (so it carries the live clientId clocks + tombstones) exactly
 *     as persistence.store caps it at config.maxDocBytes. A from-scratch encode
 *     would be strictly smaller (fresh clientId, no accumulated history) and could
 *     pass this pre-check only to have the live commit broadcast-then-fail on
 *     store — the silent-fork hole this closes.
 *   - payloadBytes: the decoded `{sheetCells, sheetDims}` JSON size, measured the
 *     SAME way GET /:docId/sheet caps it at config.sheetRead.maxCellBytes, so a
 *     batch can never write a sheet that GET then rejects with 413 (a
 *     write-but-not-readable sheet reachable via chained PATCH→PATCH).
 *
 * Pure (no DB, no live infra): the caller compares the returned sizes against the
 * configured caps and maps an overflow to 413.
 */
export function measureSheetAfterEdit(
  preEditState: Uint8Array,
  cells: Record<string, SheetCell | null>,
  dims: Record<string, number | null> = {},
  drawings: Record<string, StoredDrawing | null> = {},
  hyperlinks: Record<string, StoredHyperLink | null> = {},
  merges: Record<string, boolean | null> = {},
  sheets: Record<string, StoredSheetMeta | null> = {},
): { docBytes: number; payloadBytes: number } {
  const scratch = new Y.Doc()
  Y.applyUpdate(scratch, preEditState)
  const ymap = scratch.getMap<SheetCell>(SHEET_YMAP_FIELD)
  const dimsMap = scratch.getMap<number>(SHEET_DIMS_FIELD)
  const drawingMap = scratch.getMap<StoredDrawing>(SHEET_DRAWINGS_FIELD)
  const linkMap = scratch.getMap<StoredHyperLink>(SHEET_HYPERLINKS_FIELD)
  const mergeMap = scratch.getMap<boolean>(SHEET_MERGES_FIELD)
  const listMap = scratch.getMap<StoredSheetMeta>(SHEET_LIST_FIELD)
  // Apply the batch exactly as the live commit will (validate-all-then-apply), so
  // the measured post-edit doc matches what commitLiveSheetEdit would persist.
  scratch.transact(() => {
    applySheetCellsToYMap(ymap, cells)
    applySheetDimsToYMap(dimsMap, dims)
    applySheetDrawingsToYMap(drawingMap, drawings)
    applySheetHyperLinksToYMap(linkMap, hyperlinks)
    applySheetMergesToYMap(mergeMap, merges)
    applySheetListToYMap(listMap, sheets)
  })
  const docBytes = Y.encodeStateAsUpdate(scratch).length
  // Decode + validate the READ maps exactly as GET does (decodeSheetSnapshot /
  // decodeSheetDimsSnapshot / hyperlinks) so payloadBytes is byte-identical to the
  // read body. NOTE: drawings are NOT part of the GET payload (their inline base64
  // would blow the read cap); they only grow docBytes. Hyperlinks ARE small and
  // structured, so they ride the GET surface and count toward payloadBytes.
  const rawCells: Record<string, unknown> = {}
  for (const [key, val] of scratch.getMap(SHEET_YMAP_FIELD).entries()) rawCells[key] = val
  const rawDims: Record<string, unknown> = {}
  for (const [key, val] of scratch.getMap(SHEET_DIMS_FIELD).entries()) rawDims[key] = val
  const rawLinks: Record<string, unknown> = {}
  for (const [key, val] of scratch.getMap(SHEET_HYPERLINKS_FIELD).entries()) rawLinks[key] = val
  const rawMerges: Record<string, unknown> = {}
  for (const [key, val] of scratch.getMap(SHEET_MERGES_FIELD).entries()) rawMerges[key] = val
  const rawSheets: Record<string, unknown> = {}
  for (const [key, val] of scratch.getMap(SHEET_LIST_FIELD).entries()) rawSheets[key] = val
  const sheetCells = validateSheetCells(rawCells)
  const sheetDims = validateSheetDims(rawDims)
  const sheetHyperLinks = validateSheetHyperLinks(rawLinks)
  const sheetMerges = validateSheetMerges(rawMerges)
  const sheetList = validateSheetList(rawSheets)
  const payloadBytes = Buffer.byteLength(JSON.stringify({ sheetCells, sheetDims, sheetHyperLinks, sheetMerges, sheetList }))
  return { docBytes, payloadBytes }
}
