/**
 * Link-card OG fetch endpoint (§3.5 ⑰).
 *   POST /api/v1/docs/{docId}/link-card   (needs reader)   body { url }
 *
 * The backend fetches the target page on the caller's behalf and returns the
 * normalized OG card. Requiring the `reader` role on the doc keeps this from
 * being abused as an open proxy: only someone who can already see the doc can
 * make the backend fetch a URL through it. The fetch itself is SSRF-guarded in
 * ogFetch/ssrfGuard. Results are cached in Redis (success 24h, failure short) so
 * the same link pasted across docs/users does not re-fetch.
 */
import { Router, type Router as ExpressRouter, type Request, type Response } from 'express'
import { createHash } from 'node:crypto'
import { requireDocRole } from '../guard.js'
import { config } from '../../config/env.js'
import { getRedis, rkey } from '../../db/redis.js'
import { fetchOgCard, type OgCard } from '../../util/ogFetch.js'
import { LinkCardError, type LinkCardErrorCode } from '../../util/ssrfGuard.js'

export const linkCardRouter: ExpressRouter = Router()

/** Wire code -> HTTP status (§3.5 ⑰ error table). */
const STATUS: Record<LinkCardErrorCode, number> = {
  url_required: 400,
  url_invalid: 400,
  scheme_not_allowed: 400,
  ssrf_blocked: 403,
  fetch_failed: 502,
  unsupported_content_type: 415,
  response_too_large: 413,
}

/** Normalize a URL for cache keying (drop fragment; fall back to trimmed raw). */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    return u.toString()
  } catch {
    return url.trim()
  }
}

function cacheKey(url: string): string {
  return rkey('og:v1', createHash('sha256').update(normalizeUrl(url)).digest('hex'))
}

linkCardRouter.post('/:docId/link-card', linkCardHandler)

export async function linkCardHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(req, res, req.params.docId!, 'reader')
  if (!guard) return

  const { url } = (req.body ?? {}) as { url?: unknown }
  if (typeof url !== 'string' || url.trim() === '') {
    res.status(400).json({ error: 'url_required' })
    return
  }

  const key = cacheKey(url)

  // Cache read — a miss or any Redis error just falls through to a live fetch.
  try {
    const cached = await getRedis().get(key)
    if (cached) {
      const obj = JSON.parse(cached) as OgCard | { error: LinkCardErrorCode; status: number }
      if ('error' in obj) res.status(obj.status).json({ error: obj.error })
      else res.status(200).json(obj)
      return
    }
  } catch {
    // ignore cache failures
  }

  try {
    const card = await fetchOgCard(url)
    await cacheSet(key, JSON.stringify(card), config.og.cacheSuccessTtlSeconds)
    res.status(200).json(card)
  } catch (err) {
    const code: LinkCardErrorCode = err instanceof LinkCardError ? err.code : 'fetch_failed'
    const status = STATUS[code] ?? 502
    // Short-TTL negative cache to blunt repeated probing / thundering herd.
    await cacheSet(key, JSON.stringify({ error: code, status }), config.og.cacheFailureTtlSeconds)
    res.status(status).json({ error: code })
  }
}

/** Best-effort Redis write; never throws into the request path. */
async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  try {
    await getRedis().set(key, value, 'EX', ttlSeconds)
  } catch {
    // ignore cache failures
  }
}
