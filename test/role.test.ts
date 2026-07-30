import { describe, it, expect } from 'vitest'
import {
  ROLE_READER,
  ROLE_COMMENTER,
  ROLE_WRITER,
  ROLE_ADMIN,
  roleFromNumber,
  roleToNumber,
  roleRank,
  roleAtLeast,
  isMemberRole,
  isForwardGrantRole,
  isAccessRequestRole,
  type Role,
} from '../src/permission/role.js'

// The ordered four-level encoding is load-bearing: every max-merge / roleAtLeast
// path relies on reader<commenter<writer<admin being 1<2<3<4 numerically.
describe('role model — ordered four-level encoding', () => {
  it('pins the ordered numeric codes', () => {
    expect(ROLE_READER).toBe(1)
    expect(ROLE_COMMENTER).toBe(2)
    expect(ROLE_WRITER).toBe(3)
    expect(ROLE_ADMIN).toBe(4)
  })

  it('round-trips every role number <-> string', () => {
    const pairs: Array<[number, Role]> = [
      [1, 'reader'],
      [2, 'commenter'],
      [3, 'writer'],
      [4, 'admin'],
    ]
    for (const [n, role] of pairs) {
      expect(roleFromNumber(n)).toBe(role)
      expect(roleToNumber(role)).toBe(n)
    }
  })

  it('returns undefined for an out-of-enum number (fail closed at the boundary)', () => {
    for (const n of [0, 5, -1, 99, 2.5]) {
      expect(roleFromNumber(n)).toBeUndefined()
    }
  })

  it('roleRank gives a total order with none=0 at the bottom', () => {
    expect(roleRank('none')).toBe(0)
    expect(roleRank('reader')).toBe(1)
    expect(roleRank('commenter')).toBe(2)
    expect(roleRank('writer')).toBe(3)
    expect(roleRank('admin')).toBe(4)
    // strictly increasing
    const ranks = ['none', 'reader', 'commenter', 'writer', 'admin'].map((r) =>
      roleRank(r as never),
    )
    for (let i = 1; i < ranks.length; i++) expect(ranks[i]!).toBeGreaterThan(ranks[i - 1]!)
  })

  it('roleAtLeast compares by rank across all pairs', () => {
    expect(roleAtLeast('commenter', 'reader')).toBe(true)
    expect(roleAtLeast('reader', 'commenter')).toBe(false)
    expect(roleAtLeast('writer', 'commenter')).toBe(true)
    expect(roleAtLeast('commenter', 'writer')).toBe(false)
    expect(roleAtLeast('admin', 'writer')).toBe(true)
    expect(roleAtLeast('commenter', 'commenter')).toBe(true) // reflexive
    expect(roleAtLeast('reader', 'none')).toBe(true)
    expect(roleAtLeast('none', 'reader')).toBe(false)
  })
})

describe('role grant-eligibility predicates', () => {
  it('isMemberRole accepts all four roles, rejects everything else', () => {
    for (const r of ['reader', 'commenter', 'writer', 'admin']) expect(isMemberRole(r)).toBe(true)
    for (const r of ['none', 'owner', '', 'READER', 2, null, undefined]) {
      expect(isMemberRole(r)).toBe(false)
    }
  })

  it('isForwardGrantRole allows reader/commenter/writer but never admin', () => {
    expect(isForwardGrantRole('reader')).toBe(true)
    expect(isForwardGrantRole('commenter')).toBe(true)
    expect(isForwardGrantRole('writer')).toBe(true)
    expect(isForwardGrantRole('admin')).toBe(false)
    expect(isForwardGrantRole('none')).toBe(false)
  })

  it('isAccessRequestRole allows reader/commenter/writer but never admin', () => {
    expect(isAccessRequestRole('reader')).toBe(true)
    expect(isAccessRequestRole('commenter')).toBe(true)
    expect(isAccessRequestRole('writer')).toBe(true)
    expect(isAccessRequestRole('admin')).toBe(false)
  })
})
