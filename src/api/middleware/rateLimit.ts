/**
 * Rate-limit middleware (§8.4).
 *
 * A per-IP fixed-window throttle mounted at the head of each REST route chain so
 * the authenticated/authorizing metadata endpoints on both the human
 * (/api/v1/docs) and bot (/v1/bot/docs) mounts are protected against request
 * flooding. Backed by express-rate-limit's default in-process memory store,
 * which is sufficient per node; the window is short so restarts do not matter.
 *
 * Defaults come from config.rateLimit (env-tunable). Callers may pass overrides
 * — used by tests to exercise the limit with a tiny budget.
 *
 * The /healthz probe is mounted ahead of the limiter in createApp and therefore
 * stays unthrottled.
 */
import { rateLimit, type RateLimitRequestHandler } from 'express-rate-limit'
import { config } from '../../config/env.js'

export interface RateLimiterOptions {
  windowMs?: number
  max?: number
  /**
   * Body sent on a 429. Defaults to the legacy bare `{ error: 'rate_limited' }`
   * shape used by the /api/v1/docs and /v1/bot/docs chains. The PPT chain passes
   * its C-style envelope here so a throttled PPT request stays on-contract
   * (`{ error: { code: 'RATE_LIMITED', … } }`) instead of leaking the bare shape.
   */
  message?: unknown
}

/** Build a per-IP rate limiter; unspecified options fall back to config.rateLimit. */
export function createRateLimiter(opts: RateLimiterOptions = {}): RateLimitRequestHandler {
  return rateLimit({
    windowMs: opts.windowMs ?? config.rateLimit.windowMs,
    limit: opts.max ?? config.rateLimit.max,
    standardHeaders: 'draft-7', // RateLimit-* response headers
    legacyHeaders: false, // drop the deprecated X-RateLimit-* headers
    message: opts.message ?? { error: 'rate_limited' },
  })
}
