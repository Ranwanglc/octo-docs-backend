// Server-side enforcement of sheet range protection — the half that covers BOTS.
//
// Univer evaluates protected ranges in the browser. `PATCH /:docId/sheet` (bots, CLI, scripts) never
// passes through that, so before assertSheetWriteAllowed a bot could overwrite any protected cell:
// the protection was decoration outside the web UI. These tests are the regression cover for that,
// so they are written mostly as DENY assertions — a false ALLOW here is the hole reopening.

import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import {
  assertSheetWriteAllowed,
  ProtectedRangeError,
  SHEET_PROTECTION_FIELD,
  SHEET_PROTECTION_GRANTS_FIELD,
  sheetCellKey,
  type SheetCell,
} from '../src/agent/sheetConversion.js'

/** A doc carrying one protected RANGE rule over C5:D6 on the `default` sheet. */
function docWithRangeRule(opts: { permissionId?: string; allow?: string[] | null } = {}) {
  const permissionId = opts.permissionId ?? 'perm-1'
  const doc = new Y.Doc()
  doc.getMap(SHEET_PROTECTION_FIELD).set('default!r:r1', {
    kind: 'r',
    id: 'r1',
    permissionId,
    // C5:D6 → rows 4-5, cols 2-3 (0-based, inclusive)
    ranges: [{ startRow: 4, startColumn: 2, endRow: 5, endColumn: 3 }],
  })
  if (opts.allow !== null) {
    doc.getMap(SHEET_PROTECTION_GRANTS_FIELD).set(permissionId, { allow: opts.allow ?? [] })
  }
  return doc
}

/** A doc carrying a WHOLE-SHEET rule on `default`. */
function docWithWorksheetRule(allow: string[] = []) {
  const doc = new Y.Doc()
  doc.getMap(SHEET_PROTECTION_FIELD).set('default!w:', { kind: 'w', permissionId: 'perm-ws' })
  doc.getMap(SHEET_PROTECTION_GRANTS_FIELD).set('perm-ws', { allow })
  return doc
}

const cell = (v: string): SheetCell => ({ v })
/** C5 — inside the protected rectangle. */
const C5 = sheetCellKey('default', 4, 2)
/** A1 — outside it. */
const A1 = sheetCellKey('default', 0, 0)

describe('assertSheetWriteAllowed — a bot must NOT be able to write a protected cell', () => {
  it('THROWS for an ungranted bot writing inside the protected range', () => {
    const doc = docWithRangeRule({ allow: [] })
    expect(() => assertSheetWriteAllowed(doc, { [C5]: cell('x') }, 'bot-1', false)).toThrow(ProtectedRangeError)
  })

  it('names the refused cells on the error (so a bot author can see which blocked)', () => {
    const doc = docWithRangeRule({ allow: [] })
    try {
      assertSheetWriteAllowed(doc, { [C5]: cell('x') }, 'bot-1', false)
      throw new Error('expected ProtectedRangeError')
    } catch (err) {
      expect(err).toBeInstanceOf(ProtectedRangeError)
      expect((err as ProtectedRangeError).keys).toEqual([C5])
      expect((err as ProtectedRangeError).code).toBe('protected_range')
    }
  })

  it('THROWS when the rule exists but its grant has not replicated yet (fail closed)', () => {
    // The rule alone proves the range is protected; an unknown allow-list must deny, not wave through.
    const doc = docWithRangeRule({ allow: null })
    expect(() => assertSheetWriteAllowed(doc, { [C5]: cell('x') }, 'bot-1', false)).toThrow(ProtectedRangeError)
  })

  it('THROWS for a DELETE of a protected cell, not just a set', () => {
    // Erasing a protected cell is as destructive as overwriting it.
    const doc = docWithRangeRule({ allow: [] })
    expect(() => assertSheetWriteAllowed(doc, { [C5]: null }, 'bot-1', false)).toThrow(ProtectedRangeError)
  })

  it('THROWS if ANY cell of a batch is protected — the whole batch is refused', () => {
    const doc = docWithRangeRule({ allow: [] })
    expect(() =>
      assertSheetWriteAllowed(doc, { [A1]: cell('ok'), [C5]: cell('nope') }, 'bot-1', false),
    ).toThrow(ProtectedRangeError)
  })

  it('THROWS for every cell of a whole-sheet (worksheet) rule', () => {
    const doc = docWithWorksheetRule([])
    expect(() => assertSheetWriteAllowed(doc, { [A1]: cell('x') }, 'bot-1', false)).toThrow(ProtectedRangeError)
  })
})

describe('assertSheetWriteAllowed — what it must still ALLOW', () => {
  it('allows a cell OUTSIDE the protected range', () => {
    const doc = docWithRangeRule({ allow: [] })
    expect(() => assertSheetWriteAllowed(doc, { [A1]: cell('x') }, 'bot-1', false)).not.toThrow()
  })

  it('allows a bot that IS on the allow-list', () => {
    const doc = docWithRangeRule({ allow: ['bot-1'] })
    expect(() => assertSheetWriteAllowed(doc, { [C5]: cell('x') }, 'bot-1', false)).not.toThrow()
  })

  it('allows a doc admin/owner anywhere', () => {
    const doc = docWithRangeRule({ allow: [] })
    expect(() => assertSheetWriteAllowed(doc, { [C5]: cell('x') }, 'u-admin', true)).not.toThrow()
  })

  it('is inert when the doc has no protection rules at all', () => {
    const doc = new Y.Doc()
    expect(() => assertSheetWriteAllowed(doc, { [C5]: cell('x') }, 'bot-1', false)).not.toThrow()
  })

  it('is inert for an empty batch', () => {
    const doc = docWithRangeRule({ allow: [] })
    expect(() => assertSheetWriteAllowed(doc, {}, 'bot-1', false)).not.toThrow()
  })

  it('only protects the sheet the rule names — another sheet is unaffected', () => {
    const doc = docWithRangeRule({ allow: [] })
    const otherSheet = sheetCellKey('sheet2', 4, 2) // same coords, different logical sheet
    expect(() => assertSheetWriteAllowed(doc, { [otherSheet]: cell('x') }, 'bot-1', false)).not.toThrow()
  })

  it('treats range bounds as INCLUSIVE on both ends', () => {
    const doc = docWithRangeRule({ allow: [] })
    // rows 4-5, cols 2-3 → the four corners are all protected...
    for (const [r, c] of [[4, 2], [4, 3], [5, 2], [5, 3]]) {
      expect(() =>
        assertSheetWriteAllowed(doc, { [sheetCellKey('default', r!, c!)]: cell('x') }, 'bot-1', false),
      ).toThrow(ProtectedRangeError)
    }
    // ...and the cells just outside each edge are not.
    for (const [r, c] of [[3, 2], [6, 2], [4, 1], [4, 4]]) {
      expect(() =>
        assertSheetWriteAllowed(doc, { [sheetCellKey('default', r!, c!)]: cell('x') }, 'bot-1', false),
      ).not.toThrow()
    }
  })
})

describe('assertSheetWriteAllowed — hostile / malformed input must not open a hole', () => {
  it('DENIES when a rule has NO permissionId — unknown extent, not "unprotected"', () => {
    // Policy reversal (WS-PROT-7). Skipping such a rule meant one unparseable entry silently removed
    // the protection and let the write through: a corrupted or version-skewed rule became an
    // authorization bypass. The rule's PRESENCE is the admin's intent; failing to read it must deny.
    const doc = new Y.Doc()
    doc.getMap(SHEET_PROTECTION_FIELD).set('default!r:r1', {
      kind: 'r',
      id: 'r1',
      ranges: [{ startRow: 4, startColumn: 2, endRow: 5, endColumn: 3 }],
    })
    // Even a cell far OUTSIDE the declared range is refused: extent unknown => whole sheet.
    expect(() => assertSheetWriteAllowed(doc, { [A1]: cell('x') }, 'bot-1', false)).toThrow(ProtectedRangeError)
  })

  it('an ADMIN can still write a sheet holding an unparseable rule (repair stays possible)', () => {
    // Fail-closed must not wedge the sheet permanently — an admin has to be able to fix the rule.
    const doc = new Y.Doc()
    doc.getMap(SHEET_PROTECTION_FIELD).set('default!r:r1', { kind: 'r', id: 'r1' })
    expect(() => assertSheetWriteAllowed(doc, { [A1]: cell('x') }, 'u-admin', true)).not.toThrow()
  })

  it('DENIES a range rule whose bounds are all unparseable — treated as whole-sheet', () => {
    const doc = new Y.Doc()
    doc.getMap(SHEET_PROTECTION_FIELD).set('default!r:r1', {
      kind: 'r', id: 'r1', permissionId: 'p',
      ranges: [{ startRow: 'x', startColumn: null, endRow: 1.5, endColumn: 3 }],
    })
    doc.getMap(SHEET_PROTECTION_GRANTS_FIELD).set('p', { allow: [] })
    expect(() => assertSheetWriteAllowed(doc, { [A1]: cell('x') }, 'bot-1', false)).toThrow(ProtectedRangeError)
  })

  it('DENIES when a rule VALUE is a primitive — the sheet it names is locked, not unprotected', () => {
    // Third instance of the same class as the two above: "the rule is present but this server cannot
    // interpret it". A malformed KEY and malformed BOUNDS both escalate; a malformed VALUE used to
    // `continue`, so `bySheet` stayed empty and the guard early-returned ALLOW on a doc that visibly
    // has protection. A primitive cannot carry a permissionId, so the extent falls to the whole sheet
    // under the sentinel — no grant can match it, so only a doc admin gets in to repair the rule.
    for (const junk of ['junk', 42, true]) {
      const doc = new Y.Doc()
      doc.getMap(SHEET_PROTECTION_FIELD).set('default!r:r1', junk as never)
      expect(() => assertSheetWriteAllowed(doc, { [A1]: cell('x') }, 'bot-1', false)).toThrow(ProtectedRangeError)
    }
  })

  it('a primitive rule value locks ONLY the sheet its key names', () => {
    // Escalation must stop at the sheet boundary — the key IS readable, so we know which sheet was
    // meant and must not lock the rest of the document on a guess.
    const doc = new Y.Doc()
    doc.getMap(SHEET_PROTECTION_FIELD).set('default!r:r1', 'junk' as never)
    expect(() =>
      assertSheetWriteAllowed(doc, { [sheetCellKey('sheet2', 0, 0)]: cell('x') }, 'bot-1', false),
    ).not.toThrow()
  })

  it('WS-PROT-10a: an EMPTY logicalId must not defeat every deny path in the loop', () => {
    // P1-1 (#139 review, head 5eca827e). `bang < 0` closes `indexOf('!') === -1` and leaves
    // `=== 0` wide open: `'!r:r1'` → `key.slice(0, 0) === ''` → the rule lands in bySheet under ''.
    // No write key can ever resolve to '' (every write-key regex demands >=1 char before the
    // separator), so bySheet.size is 1, the `size === 0 && docWide.length === 0` early return does
    // NOT fire, the loop walks every key, matches nothing, and returns ALLOW.
    //
    // This bypasses ALL FOUR deny paths at once — unreadable key, unreadable value, unreadable
    // permissionId, unreadable bounds — plus the ordinary whole-sheet `!w:` path. It is the direct
    // violation of issue #141's first hard requirement: "a known protection object with no
    // resolvable grant must deny, not allow." Reviewer's table, executed row by row.
    const cases: Array<[string, unknown, string]> = [
      ['!r:r1', { kind: 'r', id: 'r1', permissionId: 'p1', ranges: [{ startRow: 0, startColumn: 0, endRow: 3, endColumn: 3 }] }, 'well-formed rect, no grant'],
      ['!w:', { kind: 'w', permissionId: 'p1' }, 'whole-sheet rule'],
      ['!r:r1', { kind: 'r', id: 'r1', ranges: [{ startRow: 0, startColumn: 0, endRow: 3, endColumn: 3 }] }, 'sentinel path (no permissionId)'],
      ['!r:r1', { kind: 'r', id: 'r1', permissionId: 'p1', ranges: 'nope' }, 'malformed bounds path'],
      ['!r:r1', 'junk', 'primitive value path — the branch the last push added'],
    ]
    for (const [key, rule, label] of cases) {
      const doc = new Y.Doc()
      doc.getMap(SHEET_PROTECTION_FIELD).set(key, rule as never)
      expect(
        () => assertSheetWriteAllowed(doc, { [A1]: cell('x') }, 'bot-1', false),
        `empty logicalId must still DENY: ${label}`,
      ).toThrow(ProtectedRangeError)
    }
  })

  it('WS-PROT-10b: a partial parse must not become a partial bypass (empty-logicalId sibling)', () => {
    // Reviewer's row 7 — the shape the previous head was written to close, one character over.
    // A real rect on `default` plus an empty-logicalId junk entry: the junk entry must escalate,
    // not silently widen the allowed area.
    const doc = new Y.Doc()
    doc.getMap(SHEET_PROTECTION_FIELD).set('default!r:r1', {
      kind: 'r', id: 'r1', permissionId: 'p1',
      ranges: [{ startRow: 0, startColumn: 0, endRow: 1, endColumn: 1 }],
    })
    doc.getMap(SHEET_PROTECTION_FIELD).set('!w:', 'junk' as never)
    // (5,5) is OUTSIDE the real rect, so only the junk entry can deny here.
    expect(() =>
      assertSheetWriteAllowed(doc, { [sheetCellKey('default', 5, 5)]: cell('x') }, 'bot-1', false),
    ).toThrow(ProtectedRangeError)
  })

  it('WS-PROT-10c: a readable non-empty logicalId still scopes the lock to its own sheet', () => {
    // Positive control for 10a/10b: fixing the empty case must not make every malformed rule
    // doc-wide, or "one bad entry wedges the entire document" ships as the new bug.
    const doc = new Y.Doc()
    doc.getMap(SHEET_PROTECTION_FIELD).set('default!r:r1', 'junk' as never)
    expect(() =>
      assertSheetWriteAllowed(doc, { [sheetCellKey('sheet2', 0, 0)]: cell('x') }, 'bot-1', false),
    ).not.toThrow()
  })

  it('DENIES doc-wide when BOTH the rule key and its value are unreadable', () => {
    // No sheet prefix AND no readable body: nothing narrows the extent, so the conservative answer is
    // the whole document. A combination neither single-field test can reach on its own.
    const doc = new Y.Doc()
    doc.getMap(SHEET_PROTECTION_FIELD).set('no-bang-key', 'junk' as never)
    expect(() =>
      assertSheetWriteAllowed(doc, { [sheetCellKey('any-sheet', 3, 3)]: cell('x') }, 'bot-1', false),
    ).toThrow(ProtectedRangeError)
  })

  it('an ADMIN can still write a sheet whose rule VALUE is a primitive (repair stays possible)', () => {
    const doc = new Y.Doc()
    doc.getMap(SHEET_PROTECTION_FIELD).set('default!r:r1', 'junk' as never)
    expect(() => assertSheetWriteAllowed(doc, { [A1]: cell('x') }, 'u-admin', true)).not.toThrow()
  })

  it('a primitive rule value blocks dims and merges too, not only cells', () => {
    // The escalation lands in `whole`, which all three key loops consult. Pinned separately because a
    // fix threaded only through the cell loop would pass the test above and still leave row-height and
    // merge writes open on the locked sheet.
    const doc = new Y.Doc()
    doc.getMap(SHEET_PROTECTION_FIELD).set('default!r:r1', 'junk' as never)
    expect(() => assertSheetWriteAllowed(doc, {}, 'bot-1', false, { 'default:r3': 40 })).toThrow(ProtectedRangeError)
    expect(() =>
      assertSheetWriteAllowed(doc, {}, 'bot-1', false, {}, { 'default:1:1:2:2': true }),
    ).toThrow(ProtectedRangeError)
  })

  it('DENIES a rect that no cell can ever be inside — negative bounds are not "zero area"', () => {
    // Reviewer P1 (round 8), probe-confirmed. All four bounds are integers, so readRects accepted
    // `-5..-1` as a real rectangle. Cell coordinates are never negative, so the containment test can
    // never be true: the rule was PRESENT and protected nothing. Same fail-open class as the inverted
    // rect, one field over — the admin performed a protect action and the server enforced no part of it.
    //
    // Scope, stated precisely because my first probe over-reported it: bounds ABOVE the visible grid
    // (e.g. 5000..6000) are NOT this bug. The backend's cell keys allow those coordinates, so a write
    // inside such a rect is correctly refused; only a rect that cannot contain ANY valid cell qualifies.
    for (const ranges of [
      [{ startRow: -5, startColumn: -5, endRow: -1, endColumn: -1 }],
      [{ startRow: -1, startColumn: 0, endRow: -1, endColumn: 3 }],
      [{ startRow: 0, startColumn: -9, endRow: 3, endColumn: -1 }],
    ]) {
      const doc = new Y.Doc()
      doc.getMap(SHEET_PROTECTION_FIELD).set('default!r:r1', { kind: 'r', id: 'r1', permissionId: 'p', ranges })
      doc.getMap(SHEET_PROTECTION_GRANTS_FIELD).set('p', { allow: [] })
      expect(() => assertSheetWriteAllowed(doc, { [A1]: cell('x') }, 'bot-1', false)).toThrow(ProtectedRangeError)
    }
  })

  it('a rect merely ABOVE the visible grid still protects its own cells (not over-escalated)', () => {
    // The other side of the line above: 5000..6000 is a writable coordinate range as far as the cell
    // key format is concerned, so it must behave like any ordinary rect — deny inside, allow outside.
    const doc = new Y.Doc()
    doc.getMap(SHEET_PROTECTION_FIELD).set('default!r:r1', {
      kind: 'r', id: 'r1', permissionId: 'p',
      ranges: [{ startRow: 5000, startColumn: 500, endRow: 6000, endColumn: 600 }],
    })
    doc.getMap(SHEET_PROTECTION_GRANTS_FIELD).set('p', { allow: [] })
    expect(() => assertSheetWriteAllowed(doc, { [sheetCellKey('default', 5500, 550)]: cell('x') }, 'bot-1', false))
      .toThrow(ProtectedRangeError)
    expect(() => assertSheetWriteAllowed(doc, { [A1]: cell('x') }, 'bot-1', false)).not.toThrow()
  })

  it('a GRANTED uid is unaffected by a negative-bound rect (the grant still governs)', () => {
    const doc = new Y.Doc()
    doc.getMap(SHEET_PROTECTION_FIELD).set('default!r:r1', {
      kind: 'r', id: 'r1', permissionId: 'p',
      ranges: [{ startRow: -5, startColumn: -5, endRow: -1, endColumn: -1 }],
    })
    doc.getMap(SHEET_PROTECTION_GRANTS_FIELD).set('p', { allow: ['bot-1'] })
    expect(() => assertSheetWriteAllowed(doc, { [A1]: cell('x') }, 'bot-1', false)).not.toThrow()
  })

  it('a GRANTED uid is still allowed when only the bounds failed to parse', () => {
    // The rule keeps its own permissionId here, so the grant still governs — a bounds-parsing
    // failure must not lock out someone the admin explicitly authorized.
    const doc = new Y.Doc()
    doc.getMap(SHEET_PROTECTION_FIELD).set('default!r:r1', {
      kind: 'r', id: 'r1', permissionId: 'p',
      ranges: [{ startRow: 'x', startColumn: null, endRow: 1.5, endColumn: 3 }],
    })
    doc.getMap(SHEET_PROTECTION_GRANTS_FIELD).set('p', { allow: ['bot-1'] })
    expect(() => assertSheetWriteAllowed(doc, { [A1]: cell('x') }, 'bot-1', false)).not.toThrow()
  })

  it('DENIES an INVERTED rect (startRow > endRow) — normalized, not silently zero-area', () => {
    // Regression for a fail-open found in review. All four bounds are integers, so an inverted rect
    // passed the parse check and landed as a real rectangle; the containment test
    // `row < startRow || row > endRow` is then ALWAYS true (row < 10 || row > 5), so the rule matched
    // ZERO cells and a non-admin write into the range the admin meant to protect was allowed.
    // The write path (validateSheetMerge) already rejects sr>er, so the parse path must agree.
    const doc = new Y.Doc()
    doc.getMap(SHEET_PROTECTION_FIELD).set('default!r:r1', {
      kind: 'r', id: 'r1', permissionId: 'p',
      ranges: [{ startRow: 10, startColumn: 0, endRow: 5, endColumn: 5 }],
    })
    doc.getMap(SHEET_PROTECTION_GRANTS_FIELD).set('p', { allow: [] })
    // C5 == row 4, col 2 -> inside the normalized [5..10]x[0..5]? row 4 is outside; use an in-range cell.
    expect(() => assertSheetWriteAllowed(doc, { 'default!7:2': cell('x') }, 'bot-1', false)).toThrow(ProtectedRangeError)
  })

  it('DENIES an INVERTED column rect (startColumn > endColumn)', () => {
    const doc = new Y.Doc()
    doc.getMap(SHEET_PROTECTION_FIELD).set('default!r:r1', {
      kind: 'r', id: 'r1', permissionId: 'p',
      ranges: [{ startRow: 0, startColumn: 9, endRow: 9, endColumn: 2 }],
    })
    doc.getMap(SHEET_PROTECTION_GRANTS_FIELD).set('p', { allow: [] })
    expect(() => assertSheetWriteAllowed(doc, { 'default!3:5': cell('x') }, 'bot-1', false)).toThrow(ProtectedRangeError)
  })

  it('a GRANTED uid is still allowed inside a normalized inverted rect', () => {
    // Normalization must not turn into a lockout for someone the admin explicitly authorized.
    const doc = new Y.Doc()
    doc.getMap(SHEET_PROTECTION_FIELD).set('default!r:r1', {
      kind: 'r', id: 'r1', permissionId: 'p',
      ranges: [{ startRow: 10, startColumn: 0, endRow: 5, endColumn: 5 }],
    })
    doc.getMap(SHEET_PROTECTION_GRANTS_FIELD).set('p', { allow: ['bot-1'] })
    expect(() => assertSheetWriteAllowed(doc, { 'default!7:2': cell('x') }, 'bot-1', false)).not.toThrow()
  })

  it('DENIES when ranges is a Y.Array rather than a JS array — whole-sheet fallback', () => {
    const doc = new Y.Doc()
    const arr = new Y.Array()
    doc.getMap(SHEET_PROTECTION_FIELD).set('default!r:r1', {
      kind: 'r', id: 'r1', permissionId: 'p', ranges: arr,
    })
    doc.getMap(SHEET_PROTECTION_GRANTS_FIELD).set('p', { allow: [] })
    expect(() => assertSheetWriteAllowed(doc, { [A1]: cell('x') }, 'bot-1', false)).toThrow(ProtectedRangeError)
  })

  it('PARTIALLY parseable bounds FAIL CLOSED — one junk element locks the whole sheet', () => {
    // REVERSED from the first cut, deliberately. Keeping "rectangle precision" here meant the junk
    // element's intended area was left UNPROTECTED: a non-admin could write anywhere outside the one
    // readable rect on a sheet the admin had visibly protected. We do not know what the unreadable
    // element covered, so the only safe extent is the whole sheet. Over-locking is repairable by an
    // admin; under-locking is a silent authorization bypass on the exact path this guard closes.
    const doc = new Y.Doc()
    doc.getMap(SHEET_PROTECTION_FIELD).set('default!r:r1', {
      kind: 'r', id: 'r1', permissionId: 'p',
      ranges: [{ startRow: 'x', startColumn: null, endRow: 1.5, endColumn: 3 }, { startRow: 4, startColumn: 2, endRow: 5, endColumn: 3 }],
    })
    doc.getMap(SHEET_PROTECTION_GRANTS_FIELD).set('p', { allow: [] })
    // inside the readable rect — denied before and after
    expect(() => assertSheetWriteAllowed(doc, { [C5]: cell('x') }, 'bot-1', false)).toThrow(ProtectedRangeError)
    // OUTSIDE it — this is the leak that used to be allowed
    expect(() => assertSheetWriteAllowed(doc, { [A1]: cell('x') }, 'bot-1', false)).toThrow(ProtectedRangeError)
  })

  it('the escalated whole-sheet lock uses the rule OWN permissionId, so a GRANTED uid keeps access', () => {
    // The fail-closed escalation must not become a lockout for someone the admin authorized: it is
    // gated by the rule's permissionId, not by the sentinel no grant can match.
    const doc = new Y.Doc()
    doc.getMap(SHEET_PROTECTION_FIELD).set('default!r:r1', {
      kind: 'r', id: 'r1', permissionId: 'p',
      ranges: [{ startRow: 'x', startColumn: 0, endRow: 1, endColumn: 1 }, { startRow: 4, startColumn: 2, endRow: 5, endColumn: 3 }],
    })
    doc.getMap(SHEET_PROTECTION_GRANTS_FIELD).set('p', { allow: ['bot-1'] })
    expect(() => assertSheetWriteAllowed(doc, { [C5]: cell('x') }, 'bot-1', false)).not.toThrow()
    expect(() => assertSheetWriteAllowed(doc, { [A1]: cell('x') }, 'bot-1', false)).not.toThrow()
    // and an ungranted uid is still denied everywhere on the sheet
    expect(() => assertSheetWriteAllowed(doc, { [A1]: cell('x') }, 'bot-2', false)).toThrow(ProtectedRangeError)
  })

  it('a partially-parseable rule also escalates dims and merges to the whole sheet', () => {
    // Same fail-closed extent must apply to the dim / merge batches, not only to cells — otherwise a
    // junk sibling still leaves resizing and merging open outside the one readable rect.
    const doc = new Y.Doc()
    doc.getMap(SHEET_PROTECTION_FIELD).set('default!r:r1', {
      kind: 'r', id: 'r1', permissionId: 'p',
      ranges: [{ startRow: 'x', startColumn: 0, endRow: 1, endColumn: 1 }, { startRow: 4, startColumn: 2, endRow: 5, endColumn: 3 }],
    })
    doc.getMap(SHEET_PROTECTION_GRANTS_FIELD).set('p', { allow: [] })
    // column 9 crosses NO readable rect (rect covers cols 2-3) — allowed before the fix
    expect(() => assertSheetWriteAllowed(doc, {}, 'bot-1', false, { 'default:c9': 200 }))
      .toThrow(ProtectedRangeError)
    // a merge far from the readable rect — likewise
    expect(() => assertSheetWriteAllowed(doc, {}, 'bot-1', false, {}, { 'default:20:20:21:21': true }))
      .toThrow(ProtectedRangeError)
  })

  it('a MALFORMED rule key (no "!") locks the whole DOCUMENT instead of vanishing', () => {
    // Keys are `${logicalId}!r:${ruleId}`. Skipping an unreadable key meant the rule disappeared: if a
    // client's key shape ever drifts, bySheet stays EMPTY and every non-admin write is waved through on
    // a doc that visibly has protection. We cannot tell which sheet was meant, so the conservative
    // extent is the whole document.
    const doc = new Y.Doc()
    doc.getMap(SHEET_PROTECTION_FIELD).set('default-r-r1', {
      kind: 'r', id: 'r1', permissionId: 'p',
      ranges: [{ startRow: 4, startColumn: 2, endRow: 5, endColumn: 3 }],
    })
    doc.getMap(SHEET_PROTECTION_GRANTS_FIELD).set('p', { allow: [] })
    expect(() => assertSheetWriteAllowed(doc, { [A1]: cell('x') }, 'bot-1', false)).toThrow(ProtectedRangeError)
    // a cell on a DIFFERENT sheet is refused too — we do not know which sheet the key meant
    expect(() => assertSheetWriteAllowed(doc, { 'sheet-2!0:0': cell('x') }, 'bot-1', false)).toThrow(ProtectedRangeError)
    // dims and merges on any sheet as well
    expect(() => assertSheetWriteAllowed(doc, {}, 'bot-1', false, { 'sheet-2:c1': 100 })).toThrow(ProtectedRangeError)
    expect(() => assertSheetWriteAllowed(doc, {}, 'bot-1', false, {}, { 'sheet-2:0:0:1:1': true })).toThrow(ProtectedRangeError)
  })

  it('a malformed rule key still respects its grant allow-list and admin bypass', () => {
    // The doc-wide escalation is gated by the rule's own permissionId, so it cannot wedge the doc.
    const doc = new Y.Doc()
    doc.getMap(SHEET_PROTECTION_FIELD).set('default-r-r1', {
      kind: 'r', id: 'r1', permissionId: 'p',
      ranges: [{ startRow: 4, startColumn: 2, endRow: 5, endColumn: 3 }],
    })
    doc.getMap(SHEET_PROTECTION_GRANTS_FIELD).set('p', { allow: ['bot-1'] })
    expect(() => assertSheetWriteAllowed(doc, { [A1]: cell('x') }, 'bot-1', false)).not.toThrow()
    expect(() => assertSheetWriteAllowed(doc, { [A1]: cell('x') }, 'bot-2', true)).not.toThrow()
  })

  it('an unparseable rule also locks dims and merges on that sheet', () => {
    const doc = new Y.Doc()
    doc.getMap(SHEET_PROTECTION_FIELD).set('default!r:r1', { kind: 'r', id: 'r1' })
    expect(() => assertSheetWriteAllowed(doc, {}, 'bot-1', false, { 'default:c9': 200 }))
      .toThrow(ProtectedRangeError)
    expect(() => assertSheetWriteAllowed(doc, {}, 'bot-1', false, {}, { 'default:0:0:1:1': true }))
      .toThrow(ProtectedRangeError)
  })

  it('ignores a grant whose allow-list is not an array (fail closed, still denies)', () => {
    const doc = docWithRangeRule({ allow: [] })
    doc.getMap(SHEET_PROTECTION_GRANTS_FIELD).set('perm-1', { allow: 'everyone' as unknown as string[] })
    expect(() => assertSheetWriteAllowed(doc, { [C5]: cell('x') }, 'bot-1', false)).toThrow(ProtectedRangeError)
  })

  it('does not match a uid by prefix/substring', () => {
    const doc = docWithRangeRule({ allow: ['bot-10'] })
    expect(() => assertSheetWriteAllowed(doc, { [C5]: cell('x') }, 'bot-1', false)).toThrow(ProtectedRangeError)
  })
})

// ---------------------------------------------------------------------------
// dims + merges coverage (WS-PROT-4).
//
// The first cut gated `cells` ONLY, so a bot could not change a protected cell's VALUE but could
// still merge across the protected rectangle, or resize a row/column crossing it. Merging is the
// destructive one: cells disappear into the merge anchor, restructuring the protected range.
// ---------------------------------------------------------------------------

/** Rule over C5:D6 → rows 4-5, cols 2-3 (0-based, inclusive), nobody granted. */
function docRangeRule(allow: string[] = []) {
  const doc = new Y.Doc()
  doc.getMap(SHEET_PROTECTION_FIELD).set('default!r:r1', {
    kind: 'r', id: 'r1', permissionId: 'perm-1',
    ranges: [{ startRow: 4, startColumn: 2, endRow: 5, endColumn: 3 }],
  })
  doc.getMap(SHEET_PROTECTION_GRANTS_FIELD).set('perm-1', { allow })
  return doc
}

const noCells: Record<string, SheetCell | null> = {}

describe('assertSheetWriteAllowed — merges must not restructure a protected range', () => {
  it('THROWS when a merge overlaps the protected rectangle', () => {
    // default:4:2:5:3 == exactly C5:D6
    const doc = docRangeRule()
    expect(() => assertSheetWriteAllowed(doc, noCells, 'bot-1', false, {}, { 'default:4:2:5:3': true }))
      .toThrow(ProtectedRangeError)
  })

  it('THROWS on PARTIAL overlap (intersection, not containment)', () => {
    // B4:C5 → rows 3-4, cols 1-2. Only its bottom-right corner touches the rect.
    const doc = docRangeRule()
    expect(() => assertSheetWriteAllowed(doc, noCells, 'bot-1', false, {}, { 'default:3:1:4:2': true }))
      .toThrow(ProtectedRangeError)
  })

  it('THROWS on UN-merge (key deletion) over the protected rectangle too', () => {
    const doc = docRangeRule()
    expect(() => assertSheetWriteAllowed(doc, noCells, 'bot-1', false, {}, { 'default:4:2:5:3': null }))
      .toThrow(ProtectedRangeError)
  })

  it('ALLOWS a merge that is fully disjoint from the rectangle', () => {
    const doc = docRangeRule()
    // A1:B2 → rows 0-1, cols 0-1
    expect(() => assertSheetWriteAllowed(doc, noCells, 'bot-1', false, {}, { 'default:0:0:1:1': true }))
      .not.toThrow()
  })

  it('ALLOWS a granted uid to merge across it', () => {
    const doc = docRangeRule(['bot-1'])
    expect(() => assertSheetWriteAllowed(doc, noCells, 'bot-1', false, {}, { 'default:4:2:5:3': true }))
      .not.toThrow()
  })

  it('ALLOWS an admin', () => {
    const doc = docRangeRule()
    expect(() => assertSheetWriteAllowed(doc, noCells, 'u-admin', true, {}, { 'default:4:2:5:3': true }))
      .not.toThrow()
  })

  it('ignores a merge key on another sheet', () => {
    const doc = docRangeRule()
    expect(() => assertSheetWriteAllowed(doc, noCells, 'bot-1', false, {}, { 'sheet2:4:2:5:3': true }))
      .not.toThrow()
  })
})

describe('assertSheetWriteAllowed — dims crossing a protected range', () => {
  it('THROWS for a COLUMN that crosses the rectangle', () => {
    const doc = docRangeRule()
    // c2 == column C, inside cols 2-3
    expect(() => assertSheetWriteAllowed(doc, noCells, 'bot-1', false, { 'default:c2': 200 }))
      .toThrow(ProtectedRangeError)
  })

  it('THROWS for a ROW that crosses the rectangle', () => {
    const doc = docRangeRule()
    expect(() => assertSheetWriteAllowed(doc, noCells, 'bot-1', false, { 'default:r4': 40 }))
      .toThrow(ProtectedRangeError)
  })

  it('ALLOWS a column/row outside the rectangle', () => {
    const doc = docRangeRule()
    expect(() => assertSheetWriteAllowed(doc, noCells, 'bot-1', false, { 'default:c9': 200 })).not.toThrow()
    expect(() => assertSheetWriteAllowed(doc, noCells, 'bot-1', false, { 'default:r99': 40 })).not.toThrow()
  })

  it('THROWS for an UNPREFIXED dims key — the legacy single-sheet shape (regression)', () => {
    // DIMS_KEY_RE makes the sheet prefix OPTIONAL: `c2` is a legal key addressing the legacy
    // 'default' sheet. Missing this branch would silently wave every unprefixed resize through.
    const doc = docRangeRule()
    expect(() => assertSheetWriteAllowed(doc, noCells, 'bot-1', false, { c2: 200 }))
      .toThrow(ProtectedRangeError)
  })

  it('ALLOWS an unprefixed dims key outside the rectangle', () => {
    const doc = docRangeRule()
    expect(() => assertSheetWriteAllowed(doc, noCells, 'bot-1', false, { c9: 200 })).not.toThrow()
  })

  it('THROWS for a dim deletion (null) crossing the rectangle', () => {
    const doc = docRangeRule()
    expect(() => assertSheetWriteAllowed(doc, noCells, 'bot-1', false, { 'default:c2': null }))
      .toThrow(ProtectedRangeError)
  })
})

describe('assertSheetWriteAllowed — a WHOLE-SHEET rule covers dims and merges too', () => {
  function docWorksheetRule() {
    const doc = new Y.Doc()
    doc.getMap(SHEET_PROTECTION_FIELD).set('default!w:', { kind: 'w', permissionId: 'perm-ws' })
    doc.getMap(SHEET_PROTECTION_GRANTS_FIELD).set('perm-ws', { allow: [] })
    return doc
  }

  it('THROWS for any merge on the sheet', () => {
    expect(() => assertSheetWriteAllowed(docWorksheetRule(), noCells, 'bot-1', false, {}, { 'default:0:0:1:1': true }))
      .toThrow(ProtectedRangeError)
  })

  it('THROWS for any dim on the sheet, prefixed or not', () => {
    expect(() => assertSheetWriteAllowed(docWorksheetRule(), noCells, 'bot-1', false, { 'default:c9': 200 }))
      .toThrow(ProtectedRangeError)
    expect(() => assertSheetWriteAllowed(docWorksheetRule(), noCells, 'bot-1', false, { r99: 40 }))
      .toThrow(ProtectedRangeError)
  })
})

describe('assertSheetWriteAllowed — mixed batch is refused as a whole', () => {
  it('THROWS when only the merge half is protected', () => {
    const doc = docRangeRule()
    expect(() =>
      assertSheetWriteAllowed(
        doc,
        { [A1]: cell('ok') },              // outside the rect
        'bot-1', false,
        {},
        { 'default:4:2:5:3': true },       // overlaps it
      ),
    ).toThrow(ProtectedRangeError)
  })

  it('is still inert when the doc has no rules at all', () => {
    const doc = new Y.Doc()
    expect(() =>
      assertSheetWriteAllowed(doc, noCells, 'bot-1', false, { 'default:c2': 200 }, { 'default:4:2:5:3': true }),
    ).not.toThrow()
  })
})

// ── sheets (sheetList) ────────────────────────────────────────────────────────────────────────
// The fourth batch the REST path applies, and the one that was left outside the guard entirely.
// `commitLiveSheetEdit` called assertSheetWriteAllowed with cells/dims/merges only, then applied
// `sheetList` deletes/sets in the SAME transaction — so a non-admin could send a sheets-only PATCH
// (`{ sheets: { default: null } }`) and remove a protected tab from the user-visible workbook.
// Deleting a tab destroys every protected cell on it, so it is strictly more destructive than the
// cell write this guard already refuses; renames/reorders are gated for the same reason a dim
// resize is — they change how the protected cells present to everyone.
describe('assertSheetWriteAllowed — sheets (tab delete / rename / reorder)', () => {
  const meta = (name: string, order = 0) => ({ name, order })

  it('THROWS when an ungranted bot DELETES a whole-sheet-protected tab', () => {
    const doc = docWithWorksheetRule([])
    expect(() =>
      assertSheetWriteAllowed(doc, noCells, 'bot-1', false, {}, {}, { default: null }),
    ).toThrow(ProtectedRangeError)
  })

  it('THROWS when an ungranted bot RENAMES a whole-sheet-protected tab', () => {
    const doc = docWithWorksheetRule([])
    expect(() =>
      assertSheetWriteAllowed(doc, noCells, 'bot-1', false, {}, {}, { default: meta('pwned') }),
    ).toThrow(ProtectedRangeError)
  })

  it('THROWS when an ungranted bot deletes a tab carrying a protected RANGE', () => {
    // Deleting the tab destroys C5:D6 along with it — a range rule must block the delete too,
    // otherwise the cell-level guard is trivially bypassed by removing the whole sheet.
    const doc = docWithRangeRule({ allow: [] })
    expect(() =>
      assertSheetWriteAllowed(doc, noCells, 'bot-1', false, {}, {}, { default: null }),
    ).toThrow(ProtectedRangeError)
  })

  it('ALLOWS a granted collaborator to delete the protected tab', () => {
    const doc = docWithWorksheetRule(['bot-1'])
    expect(() =>
      assertSheetWriteAllowed(doc, noCells, 'bot-1', false, {}, {}, { default: null }),
    ).not.toThrow()
  })

  it('ALLOWS an admin to delete the protected tab', () => {
    const doc = docWithWorksheetRule([])
    expect(() =>
      assertSheetWriteAllowed(doc, noCells, 'admin', true, {}, {}, { default: null }),
    ).not.toThrow()
  })

  it('ALLOWS deleting an UNprotected tab while another tab is protected', () => {
    const doc = docWithWorksheetRule([])
    expect(() =>
      assertSheetWriteAllowed(doc, noCells, 'bot-1', false, {}, {}, { other: null }),
    ).not.toThrow()
  })

  it('names the refused sheet key on the error', () => {
    const doc = docWithWorksheetRule([])
    try {
      assertSheetWriteAllowed(doc, noCells, 'bot-1', false, {}, {}, { default: null })
      throw new Error('expected ProtectedRangeError')
    } catch (e) {
      expect(e).toBeInstanceOf(ProtectedRangeError)
      expect((e as ProtectedRangeError).message).toContain('default')
    }
  })

  it('is inert when the doc has no rules at all', () => {
    const doc = new Y.Doc()
    expect(() =>
      assertSheetWriteAllowed(doc, noCells, 'bot-1', false, {}, {}, { default: null }),
    ).not.toThrow()
  })
})
