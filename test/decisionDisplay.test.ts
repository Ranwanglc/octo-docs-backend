import { describe, it, expect, vi, beforeEach } from 'vitest'

// Pin the card display zone so the expected strings are fixed literals and the
// assertions hold in any process/CI timezone — the zone bug this guards against
// is invisible when the expectation is built from the same local zone as input.
vi.mock('../src/config/env.js', () => ({
  config: { cardDisplayTimeZone: 'Asia/Shanghai' },
}))
// Mock the identity module so the operator lookup is deterministic and importing
// this module does not pull in the real config/repos.
const getUser = vi.fn()
vi.mock('../src/auth/octoIdentity.js', () => ({
  getOctoIdentity: () => ({ getUser }),
}))

const { buildDecisionDisplay, buildDecisionDisplayAt } = await import(
  '../src/api/services/decisionDisplay.js'
)
const { formatCardTimestamp, formatCardTimestampFromSeconds } = await import(
  '../src/util/cardTime.js'
)

// 2026-07-24 15:35 Asia/Shanghai == 07:35 UTC.
const AT_UTC = '2026-07-24T07:35:00.000Z'
const AT_SECONDS = Math.floor(new Date(AT_UTC).getTime() / 1000)
const AT_DISPLAY = '2026-07-24 15:35'

describe('formatCardTimestamp (explicit zone)', () => {
  it('renders a fixed literal in the configured zone, independent of process TZ', () => {
    expect(formatCardTimestamp(new Date(AT_UTC))).toBe(AT_DISPLAY)
  })

  it('formats unix SECONDS (the callback acted_at unit)', () => {
    expect(formatCardTimestampFromSeconds(AT_SECONDS)).toBe(AT_DISPLAY)
  })

  it('renders midnight as 00:mm rather than 24:mm', () => {
    // 2026-07-24 00:05 Asia/Shanghai == 2026-07-23 16:05 UTC
    expect(formatCardTimestamp(new Date('2026-07-23T16:05:00.000Z'))).toBe('2026-07-24 00:05')
  })

  it('returns empty for missing / non-positive / non-finite / invalid input', () => {
    expect(formatCardTimestampFromSeconds(0)).toBe('')
    expect(formatCardTimestampFromSeconds(-1)).toBe('')
    expect(formatCardTimestampFromSeconds(Number.NaN)).toBe('')
    expect(formatCardTimestamp(new Date('nope'))).toBe('')
  })
})

describe('buildDecisionDisplay (seconds source)', () => {
  beforeEach(() => getUser.mockReset())

  it('includes the resolved operator_name and the formatted decided_at', async () => {
    getUser.mockResolvedValueOnce({ uid: 'op-1', name: '张三' })
    const { display } = await buildDecisionDisplay('季度目标', 'op-1', AT_SECONDS)
    expect(display).toEqual({ title: '季度目标', operator_name: '张三', decided_at: AT_DISPLAY })
  })

  it('omits operator_name on a lookup miss (octo-server renders its generic label)', async () => {
    getUser.mockResolvedValueOnce(null)
    const { display } = await buildDecisionDisplay('季度目标', 'op-1', 0)
    expect(display).toEqual({ title: '季度目标' })
  })

  it('never throws when the lookup rejects; still returns title + decided_at', async () => {
    getUser.mockRejectedValueOnce(new Error('identity unreachable'))
    const { display } = await buildDecisionDisplay('', 'op-1', AT_SECONDS)
    expect(display).toEqual({ title: '文档访问申请', decided_at: AT_DISPLAY })
  })

  it('never puts a request on the wire for an empty uid', async () => {
    const { display } = await buildDecisionDisplay('季度目标', '', AT_SECONDS)
    expect(getUser).not.toHaveBeenCalled()
    expect(display).toEqual({ title: '季度目标', decided_at: AT_DISPLAY })
  })
})

describe('buildDecisionDisplayAt (persisted Date source)', () => {
  beforeEach(() => getUser.mockReset())

  it('formats a persisted decision Date in the configured zone', async () => {
    getUser.mockResolvedValueOnce({ uid: 'admin-A', name: 'Alice' })
    const { display } = await buildDecisionDisplayAt('季度目标', 'admin-A', new Date(AT_UTC))
    expect(display).toEqual({ title: '季度目标', operator_name: 'Alice', decided_at: AT_DISPLAY })
  })

  it('omits decided_at when the persisted time is missing', async () => {
    getUser.mockResolvedValueOnce({ uid: 'admin-A', name: 'Alice' })
    const { display } = await buildDecisionDisplayAt('季度目标', 'admin-A', null)
    expect(display).toEqual({ title: '季度目标', operator_name: 'Alice' })
  })
})
