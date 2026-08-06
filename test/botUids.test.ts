import { describe, it, expect } from 'vitest'
import {
  parseRequestBotUids,
  parseStoredBotUids,
  parseOwnedBotUidsStrict,
  BotUidsValidationError,
  MAX_BOT_UIDS,
  MAX_BOT_UID_LEN,
} from '../src/util/botUids.js'

// parseRequestBotUids is the STRICT request-body parser: any illegal input is a
// hard error (=> 400), never a silent drop/truncate. Omitted => [].
describe('parseRequestBotUids (strict request parser)', () => {
  it('omitted/undefined => [] (the zero-bot legacy path)', () => {
    expect(parseRequestBotUids(undefined)).toEqual([])
  })

  it('accepts a clean array and returns it sorted (canonical, order-independent)', () => {
    expect(parseRequestBotUids(['bot_b', 'bot_a', 'bot_c'])).toEqual(['bot_a', 'bot_b', 'bot_c'])
  })

  it('accepts an empty array => []', () => {
    expect(parseRequestBotUids([])).toEqual([])
  })

  it('rejects a non-array (string / object / null)', () => {
    for (const bad of ['bot_a', { 0: 'bot_a' }, null, 42]) {
      expect(() => parseRequestBotUids(bad)).toThrow(BotUidsValidationError)
    }
  })

  it('rejects a non-string element (number, null, object, array, undefined)', () => {
    for (const bad of [1, null, undefined, { uid: 'x' }, ['y']]) {
      expect(() => parseRequestBotUids(['bot_a', bad])).toThrow(BotUidsValidationError)
    }
  })

  it('rejects an empty / whitespace-only / untrimmed element (no silent trim)', () => {
    for (const bad of ['', '   ', ' bot_a', 'bot_a ']) {
      expect(() => parseRequestBotUids([bad])).toThrow(BotUidsValidationError)
    }
  })

  it('rejects an over-long uid (never truncates it into a different uid)', () => {
    const overlong = 'b'.repeat(MAX_BOT_UID_LEN + 1)
    expect(() => parseRequestBotUids([overlong])).toThrow(BotUidsValidationError)
    // Exactly at the bound is accepted.
    const atLimit = 'c'.repeat(MAX_BOT_UID_LEN)
    expect(parseRequestBotUids([atLimit])).toEqual([atLimit])
  })

  it('rejects duplicates (not collapsed)', () => {
    expect(() => parseRequestBotUids(['bot_a', 'bot_a'])).toThrow(BotUidsValidationError)
  })

  it('rejects a list over the count cap; accepts exactly the cap', () => {
    const over = Array.from({ length: MAX_BOT_UIDS + 1 }, (_, i) => `bot_${String(i).padStart(3, '0')}`)
    expect(() => parseRequestBotUids(over)).toThrow(BotUidsValidationError)
    const atCap = Array.from({ length: MAX_BOT_UIDS }, (_, i) => `bot_${String(i).padStart(3, '0')}`)
    expect(parseRequestBotUids(atCap)).toEqual([...atCap].sort())
  })
})

// parseStoredBotUids is the FAIL-CLOSED trusted-data parser: any malformation
// collapses the WHOLE snapshot to [] (never a partial list).
describe('parseStoredBotUids (trusted-data fail-closed parser)', () => {
  it('parses a JSON string column value (sorted, canonical)', () => {
    expect(parseStoredBotUids('["bot_b","bot_a"]')).toEqual(['bot_a', 'bot_b'])
  })

  it('accepts an already-parsed array (driver auto-parses JSON columns)', () => {
    expect(parseStoredBotUids(['bot_a', 'bot_b'])).toEqual(['bot_a', 'bot_b'])
  })

  it('a NULL/legacy row => [] (backward compatible)', () => {
    expect(parseStoredBotUids(null)).toEqual([])
    expect(parseStoredBotUids(undefined)).toEqual([])
  })

  it('malformed JSON string => [] (never throws)', () => {
    expect(parseStoredBotUids('{not valid json')).toEqual([])
    expect(parseStoredBotUids('"just-a-string"')).toEqual([]) // valid JSON, not an array
  })

  it('a JSON object (not array) => [] (fail-closed)', () => {
    expect(parseStoredBotUids('{"bot_a":1}')).toEqual([])
    expect(parseStoredBotUids({ 0: 'bot_a' })).toEqual([])
  })

  it('fail-closes the WHOLE list on ANY illegal element (no partial keep)', () => {
    expect(parseStoredBotUids(['bot_a', 1])).toEqual([])
    expect(parseStoredBotUids(['bot_a', ''])).toEqual([])
    expect(parseStoredBotUids(['bot_a', ' bot_b'])).toEqual([])
    expect(parseStoredBotUids(['bot_a', 'b'.repeat(MAX_BOT_UID_LEN + 1)])).toEqual([])
  })

  it('fail-closes on a duplicate (never collapses to a partial list)', () => {
    expect(parseStoredBotUids(['bot_a', 'bot_a'])).toEqual([])
  })

  it('fail-closes on an over-count list (never truncates)', () => {
    const over = Array.from({ length: MAX_BOT_UIDS + 1 }, (_, i) => `bot_${String(i).padStart(3, '0')}`)
    expect(parseStoredBotUids(over)).toEqual([])
  })
})

// parseOwnedBotUidsStrict is the octo-server owned-set parser: the subset gate's
// trusted membership list. It is FAIL-CLOSED as a WHOLE (any illegal/duplicate
// element => [], never a partial list) but is NOT count-capped, so an authoritative
// list of > MAX_BOT_UIDS valid bots is returned in full.
describe('parseOwnedBotUidsStrict (owned-set whole-list fail-closed parser)', () => {
  it('accepts a clean list, dedups and sorts', () => {
    expect(parseOwnedBotUidsStrict(['bot_b', 'bot_a', 'bot_c'])).toEqual([
      'bot_a',
      'bot_b',
      'bot_c',
    ])
  })

  it('a non-array => [] (fail-closed)', () => {
    for (const bad of [null, undefined, 'bot_a', 42, { 0: 'bot_a' }]) {
      expect(parseOwnedBotUidsStrict(bad)).toEqual([])
    }
  })

  it('fail-closes the WHOLE list on ANY illegal element (mixed legal + illegal => [])', () => {
    // A single non-string / empty / whitespace / untrimmed / over-long element
    // collapses the entire (otherwise-legal) list to [] — never a partial keep.
    expect(parseOwnedBotUidsStrict(['bot_a', 1])).toEqual([])
    expect(parseOwnedBotUidsStrict(['bot_a', null])).toEqual([])
    expect(parseOwnedBotUidsStrict(['bot_a', ''])).toEqual([])
    expect(parseOwnedBotUidsStrict(['bot_a', '   '])).toEqual([])
    expect(parseOwnedBotUidsStrict(['bot_a', ' bot_b'])).toEqual([])
    expect(parseOwnedBotUidsStrict(['bot_a', 'bot_b '])).toEqual([])
    expect(parseOwnedBotUidsStrict(['bot_a', 'b'.repeat(MAX_BOT_UID_LEN + 1)])).toEqual([])
  })

  it('fail-closes on a duplicate (never collapses to a partial list)', () => {
    expect(parseOwnedBotUidsStrict(['bot_a', 'bot_a'])).toEqual([])
  })

  it('is NOT count-capped: a valid list of > MAX_BOT_UIDS bots is returned in FULL', () => {
    // An owner with > 50 bots is authoritative; capping here would wrongly deny
    // a request whose target bot sits past MAX_BOT_UIDS. The full set is kept
    // (and can contain the request target).
    const many = Array.from(
      { length: MAX_BOT_UIDS + 10 },
      (_, i) => `bot_${String(i).padStart(3, '0')}`,
    )
    const out = parseOwnedBotUidsStrict([...many].reverse())
    expect(out).toEqual([...many].sort())
    expect(out.length).toBe(MAX_BOT_UIDS + 10)
    // A target sitting past the cap is still present (not truncated away).
    expect(out).toContain(`bot_${String(MAX_BOT_UIDS + 5).padStart(3, '0')}`)
  })
})
