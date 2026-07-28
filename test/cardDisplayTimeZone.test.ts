import { describe, it, expect } from 'vitest'
import { resolveCardDisplayTimeZone } from '../src/config/env.js'

// Review P1: an invalid CARD_DISPLAY_TIME_ZONE would make Intl.DateTimeFormat
// throw RangeError on the access-decision callback path — AFTER the grant has
// committed and before the receipt is finalized — so the callback would 503 in a
// permanent, non-self-healing retry loop, and the same typo would silently kill
// the notify paths that swallow their errors. A cosmetic field must not be able
// to wedge a functional path, so the zone is validated at config load instead.
describe('resolveCardDisplayTimeZone', () => {
  it('accepts valid IANA zones and fixed-offset forms', () => {
    for (const zone of ['Asia/Shanghai', 'UTC', 'America/New_York', 'Etc/GMT-8']) {
      expect(resolveCardDisplayTimeZone(zone)).toBe(zone)
    }
  })

  it('trims surrounding whitespace rather than rejecting it', () => {
    expect(resolveCardDisplayTimeZone(' Asia/Shanghai ')).toBe('Asia/Shanghai')
  })

  it('throws a clear error on a typo instead of deferring a RangeError to the decision path', () => {
    expect(() => resolveCardDisplayTimeZone('Asia/Shangai')).toThrow(/CARD_DISPLAY_TIME_ZONE/)
    expect(() => resolveCardDisplayTimeZone('UTC+8')).toThrow(/valid IANA time zone/)
    expect(() => resolveCardDisplayTimeZone('GMT+8')).toThrow(/CARD_DISPLAY_TIME_ZONE/)
  })

  it('the accepted value is actually usable by Intl.DateTimeFormat', () => {
    const zone = resolveCardDisplayTimeZone('Asia/Shanghai')
    expect(() => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(0))).not.toThrow()
  })
})
