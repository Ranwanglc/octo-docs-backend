/**
 * Shared card timestamp formatting.
 *
 * Card copy is user-visible and zh-CN, so the rendered time must not depend on
 * the container's local zone: the image sets no `TZ` and the deployment compose
 * defaults it to UTC, which would render a decision time 8 hours off for a
 * zh-CN reader. Formatting through an explicit IANA zone makes the output
 * deployment-independent and lets tests assert a fixed literal.
 *
 * The zone is configurable (`CARD_DISPLAY_TIME_ZONE`) and defaults to
 * `Asia/Shanghai`, matching the product copy's locale.
 */
import { config } from '../config/env.js'

/** Format a Date as `YYYY-MM-DD HH:mm` in the configured card display zone. */
export function formatCardTimestamp(d: Date): string {
  if (Number.isNaN(d.getTime())) return ''
  // en-CA gives YYYY-MM-DD; hour12:false + 2-digit keeps HH:mm zero-padded.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.cardDisplayTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? ''
  const hour = get('hour') === '24' ? '00' : get('hour') // some ICU builds emit 24 for midnight
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}`
}

/**
 * Format a unix-SECONDS timestamp for card display. The unit is explicit — the
 * card-action callback's `acted_at` is stamped server-side by octo-server as
 * `time.Now().Unix()` (10-digit seconds, per its published consumer contract),
 * so there is no ambiguity to guess at. Returns '' for a missing / non-positive
 * value.
 */
export function formatCardTimestampFromSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  return formatCardTimestamp(new Date(seconds * 1000))
}
