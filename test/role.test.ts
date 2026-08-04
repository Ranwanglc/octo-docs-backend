import { describe, it, expect } from 'vitest'
import {
  roleRank,
  roleAtLeast,
  roleToNumber,
  roleFromNumber,
  ROLE_COMMENTER,
} from '../src/permission/role.js'

describe('role ordering (commenter between reader and writer)', () => {
  it('ranks commenter above reader and below writer', () => {
    expect(roleRank('commenter')).toBeGreaterThan(roleRank('reader'))
    expect(roleRank('commenter')).toBeLessThan(roleRank('writer'))
    // full monotonic chain: none < reader < commenter < writer < admin
    expect(roleRank('none')).toBeLessThan(roleRank('reader'))
    expect(roleRank('writer')).toBeLessThan(roleRank('admin'))
  })

  it('roleAtLeast is correct across the commenter boundary', () => {
    expect(roleAtLeast('commenter', 'reader')).toBe(true)
    expect(roleAtLeast('commenter', 'commenter')).toBe(true)
    expect(roleAtLeast('commenter', 'writer')).toBe(false)
    expect(roleAtLeast('writer', 'commenter')).toBe(true)
    expect(roleAtLeast('reader', 'commenter')).toBe(false)
    // commenter cannot write the body, writer/admin can
    expect(roleAtLeast('commenter', 'writer')).toBe(false)
    expect(roleAtLeast('admin', 'writer')).toBe(true)
  })

  it('maps commenter to stored value 4 (stored value != rank ordinal)', () => {
    expect(ROLE_COMMENTER).toBe(4)
    expect(roleToNumber('commenter')).toBe(4)
    expect(roleFromNumber(4)).toBe('commenter')
    // existing stored values are unchanged (no renumbering).
    expect(roleToNumber('reader')).toBe(1)
    expect(roleToNumber('writer')).toBe(2)
    expect(roleToNumber('admin')).toBe(3)
    expect(roleFromNumber(1)).toBe('reader')
    expect(roleFromNumber(2)).toBe('writer')
    expect(roleFromNumber(3)).toBe('admin')
  })
})
