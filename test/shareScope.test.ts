import { describe, it, expect } from 'vitest'
import {
  effectiveRole,
  shareScopeName,
  shareRoleName,
  parseShareScope,
  parseShareRole,
  SHARE_SCOPE_RESTRICTED,
  SHARE_SCOPE_ANYONE,
  SHARE_ROLE_READ,
  SHARE_ROLE_EDIT,
} from '../src/permission/shareScope.js'
import { roleRank, type ResolvedRole } from '../src/permission/role.js'

/**
 * effectiveRole unit matrix (#64, design §5.1 / §5.2). This is the single new
 * permission rule; every enforcement seam funnels through it, so the matrix and
 * the fail-safe coercion are proven here in isolation (no DB, no network).
 */
describe('effectiveRole — decision matrix (§5.2)', () => {
  const R = SHARE_SCOPE_RESTRICTED
  const A = SHARE_SCOPE_ANYONE
  const READ = SHARE_ROLE_READ
  const EDIT = SHARE_ROLE_EDIT

  describe('§5.2.b restricted docs — behavior identical to today (shareDerived=none)', () => {
    // A restricted doc IGNORES membership entirely: only the direct role counts,
    // so the result must be byte-identical to the pre-feature resolveRole output.
    const cases: Array<[ResolvedRole, boolean]> = [
      ['admin', true],
      ['admin', false],
      ['writer', true],
      ['writer', false],
      ['reader', true],
      ['reader', false],
      ['none', true],
      ['none', false],
    ]
    for (const [direct, member] of cases) {
      it(`restricted keeps direct=${direct} regardless of member=${member}`, () => {
        expect(effectiveRole(direct, member, R, READ)).toBe(direct)
        // share_role is ignored when restricted, even if it says edit.
        expect(effectiveRole(direct, member, R, EDIT)).toBe(direct)
      })
    }
  })

  describe('§5.2.c anyone_in_space docs', () => {
    it('A1: non-member, no doc_member => none (deny), read or edit', () => {
      expect(effectiveRole('none', false, A, READ)).toBe('none')
      expect(effectiveRole('none', false, A, EDIT)).toBe('none')
    })
    it('A3: fail-closed lookup (member=false) => none', () => {
      expect(effectiveRole('none', false, A, EDIT)).toBe('none')
    })
    it('A4: space member, no doc_member, share=read => reader', () => {
      expect(effectiveRole('none', true, A, READ)).toBe('reader')
    })
    it('A5/A6: space member, no doc_member, share=edit => writer', () => {
      expect(effectiveRole('none', true, A, EDIT)).toBe('writer')
    })
    it('A7: doc_member writer on a read-share doc keeps writer (max, base wins)', () => {
      expect(effectiveRole('writer', true, A, READ)).toBe('writer')
    })
    it('A8: owner/admin on any share stays admin', () => {
      expect(effectiveRole('admin', true, A, READ)).toBe('admin')
      expect(effectiveRole('admin', true, A, EDIT)).toBe('admin')
      expect(effectiveRole('admin', false, A, EDIT)).toBe('admin')
    })
    it('reader doc_member on an edit-share doc is RAISED to writer (max, share wins)', () => {
      expect(effectiveRole('reader', true, A, EDIT)).toBe('writer')
    })
  })

  describe('§5.2.e doc_member who is NOT a space member (§5.4 — direct role wins)', () => {
    it('D2: anyone_in_space, has writer doc_member, not a member => writer via max', () => {
      expect(effectiveRole('writer', false, A, EDIT)).toBe('writer')
      expect(effectiveRole('writer', false, A, READ)).toBe('writer')
    })
    it('D1: restricted, has reader doc_member, not a member => reader', () => {
      expect(effectiveRole('reader', false, R, READ)).toBe('reader')
    })
  })

  describe('§5.1/§2 fail-safe coercion of unexpected stored values', () => {
    it('any share_scope !== 1 is treated as restricted (shareDerived=none)', () => {
      for (const scope of [2, 9, -1, 99]) {
        expect(effectiveRole('none', true, scope, EDIT)).toBe('none')
      }
    })
    it('any share_role !== 2 collapses to reader when anyone_in_space', () => {
      for (const role of [0, 3, 9, -1]) {
        expect(effectiveRole('none', true, A, role)).toBe('reader')
      }
    })
    it('never lowers a direct role (result is always max)', () => {
      // even a bogus scope/role can only ever return >= the direct role.
      expect(effectiveRole('admin', true, 7, 7)).toBe('admin')
      expect(effectiveRole('writer', true, A, 0)).toBe('writer')
    })
  })
})

describe('share enum mappers — fail-safe names + strict wire parsing', () => {
  it('shareScopeName: only 1 is anyone_in_space; everything else restricted', () => {
    expect(shareScopeName(SHARE_SCOPE_ANYONE)).toBe('anyone_in_space')
    expect(shareScopeName(SHARE_SCOPE_RESTRICTED)).toBe('restricted')
    expect(shareScopeName(9)).toBe('restricted')
  })
  it('shareRoleName: only 2 is edit; everything else read', () => {
    expect(shareRoleName(SHARE_ROLE_EDIT)).toBe('edit')
    expect(shareRoleName(SHARE_ROLE_READ)).toBe('read')
    expect(shareRoleName(0)).toBe('read')
    expect(shareRoleName(9)).toBe('read')
  })
  it('parseShareScope accepts only the two enum strings', () => {
    expect(parseShareScope('restricted')).toBe(SHARE_SCOPE_RESTRICTED)
    expect(parseShareScope('anyone_in_space')).toBe(SHARE_SCOPE_ANYONE)
    expect(parseShareScope('public')).toBeNull()
    expect(parseShareScope(1)).toBeNull()
    expect(parseShareScope(undefined)).toBeNull()
  })
  it('parseShareRole accepts only read|edit', () => {
    expect(parseShareRole('read')).toBe(SHARE_ROLE_READ)
    expect(parseShareRole('edit')).toBe(SHARE_ROLE_EDIT)
    expect(parseShareRole('admin')).toBeNull()
    expect(parseShareRole(2)).toBeNull()
    expect(parseShareRole(undefined)).toBeNull()
  })
})

// The share_role enum (1=read/2=edit) is INDEPENDENT of the four-level doc-role
// recode: EDIT still DERIVES the string 'writer', which now ranks 3 in the
// ordered encoding. A commenter direct role sits between reader and the derived
// writer, so an edit share RAISES a commenter to writer, while a read share does
// not lower a commenter.
describe('share edit derives writer under the four-level encoding', () => {
  it('edit share derives writer, and writer ranks 3', () => {
    expect(effectiveRole('none', true, SHARE_SCOPE_ANYONE, SHARE_ROLE_EDIT)).toBe('writer')
    expect(roleRank('writer')).toBe(3)
    expect(roleRank('commenter')).toBe(2)
  })
  it('commenter direct + edit share => RAISED to writer (share wins by rank)', () => {
    expect(effectiveRole('commenter', true, SHARE_SCOPE_ANYONE, SHARE_ROLE_EDIT)).toBe('writer')
  })
  it('commenter direct + read share => stays commenter (base wins, never lowered)', () => {
    expect(effectiveRole('commenter', true, SHARE_SCOPE_ANYONE, SHARE_ROLE_READ)).toBe('commenter')
  })
})
