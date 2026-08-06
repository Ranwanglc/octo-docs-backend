/**
 * PPT source/bootstrap route: `GET /api/v1/ppt/docs/:docId/source` (R3-B1).
 *
 *   ?mode=published|live|draft      (default: published)
 *   &version=latest|<n>             (published only; default: latest)
 *   &format=bootstrap|bento|html    (default: bootstrap)
 *
 * This is the backend source/bootstrap layer the frontend viewer/editor/present
 * routes (R3-F1) depend on. It finalizes, for `html_ppt` decks:
 *
 *   1. ACCESS POLICY (§4 / §12 / PPT-SOURCE-001..003, PPT-UI-002/003):
 *      reader/commenter may load ONLY `published`; `draft`/`live` require
 *      writer/admin. A reader/commenter asking for draft/live gets `403 FORBIDDEN`
 *      — the negative control this round must prove.
 *   2. CACHE POLICY (§4 / PPT-SOURCE-004, PPT-UI-004):
 *      an immutable published version's bento/html source is served with an
 *      immutable-version cache; draft/live — and ANY bootstrap payload, which
 *      embeds short-lived signed URLs — is `private, no-store`.
 *   3. SIGNED ASSET BOOTSTRAP (§8 / §9 / PPT-SEC-001, PPT-ASSET-001):
 *      the bootstrap payload carries short-lived signed asset GET URLs, never a
 *      long-lived token in the URL.
 *   4. ORIGIN SAFETY (§3.3):
 *      a cross-origin request from a disallowed Origin is refused; the bootstrap
 *      names the exact `targetOrigin` the parent must postMessage into (never `*`).
 *
 * It does NOT issue any Hocuspocus/relay token (R4) and does not read
 * publish/version stores (R5); the content seam ({@link PptSourceProvider})
 * returns what R2 persists today and R4/R5 fill in behind it unchanged.
 */
import { Router, type Request, type Response, type NextFunction, type Router as ExpressRouter } from 'express'
import { roleAtLeast, type ResolvedRole, type Role } from '../../permission/role.js'
import { resolveAllowedOrigin } from '../cors.js'
import { config } from '../../config/env.js'
import {
  defaultPptSourceProvider,
  PPT_SOURCE_FORMATS,
  PPT_SOURCE_MODES,
  type PptSourceContent,
  type PptSourceFormat,
  type PptSourceMode,
  type PptSourceProvider,
} from '../../ppt/source.js'
import { buildPptBootstrap } from '../../ppt/bootstrap.js'
import { PptApiError, sendPptData } from './envelope.js'
import { pptAuthMiddleware, pptSpaceContextMiddleware } from './auth.js'
import { loadPptDocForRead } from './pptDocGuard.js'

/**
 * Minimum role per source mode (§4 / §12 reader-live row). commenter (rank 20)
 * ranks BELOW writer (30), so a commenter — like a reader — fails the writer
 * floor on draft/live and is denied, while both pass the reader floor on
 * published. This one table IS the published-only-for-reader/commenter rule.
 */
const MODE_MIN_ROLE: Record<PptSourceMode, Role> = {
  published: 'reader',
  live: 'writer',
  draft: 'writer',
}

/** Parse & validate `?mode`; default `published`. */
function parseMode(raw: unknown): PptSourceMode {
  if (raw === undefined) return 'published'
  if (typeof raw === 'string' && (PPT_SOURCE_MODES as readonly string[]).includes(raw)) {
    return raw as PptSourceMode
  }
  throw new PptApiError('VALIDATION_ERROR', 'mode must be one of published|live|draft', {
    details: { field: 'mode' },
  })
}

/** Parse & validate `?format`; default `bootstrap`. */
function parseFormat(raw: unknown): PptSourceFormat {
  if (raw === undefined) return 'bootstrap'
  if (typeof raw === 'string' && (PPT_SOURCE_FORMATS as readonly string[]).includes(raw)) {
    return raw as PptSourceFormat
  }
  throw new PptApiError('VALIDATION_ERROR', 'format must be one of bootstrap|bento|html', {
    details: { field: 'format' },
  })
}

/**
 * Parse & validate `?version`; default `latest`. A concrete version is a
 * positive integer and is meaningful ONLY for `mode=published`. The `version`
 * param as a whole is published-only: supplying ANY explicit `version` (even
 * `version=latest`) on draft/live is a 400 — the working state has no immutable
 * publish sequence to select. Omitting `version` is fine in every mode and
 * defaults to `latest`.
 */
function parseVersion(raw: unknown, mode: PptSourceMode): 'latest' | number {
  if (raw === undefined) return 'latest'
  // An explicit version param is only meaningful for published sources.
  if (mode !== 'published') {
    throw new PptApiError('VALIDATION_ERROR', 'version is only valid for mode=published', {
      details: { field: 'version' },
    })
  }
  if (raw === 'latest') return 'latest'
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new PptApiError('VALIDATION_ERROR', 'version must be "latest" or a positive integer', {
      details: { field: 'version' },
    })
  }
  const n = Number(raw)
  if (n < 1) {
    throw new PptApiError('VALIDATION_ERROR', 'version must be a positive integer', {
      details: { field: 'version' },
    })
  }
  return n
}

/**
 * Resolve the origin-safe target origin for a bootstrap transfer and refuse a
 * disallowed cross-origin request (§3.3). When the request carries an `Origin`
 * header it MUST be in the CORS allowlist — otherwise the source is refused with
 * `403 FORBIDDEN` (server-side, before any bytes are served, stronger than
 * relying on the browser to drop a no-ACAO response). The returned origin is the
 * exact value the parent must postMessage into; with no `Origin` header (a
 * same-origin GET or a non-browser client) it falls back to the configured web
 * origin. It is NEVER `*`.
 */
function resolveBootstrapOrigin(req: Request): string {
  const raw = req.headers.origin
  const origin = typeof raw === 'string' && raw !== '' ? raw : undefined
  if (origin) {
    const allowed = resolveAllowedOrigin(origin)
    if (!allowed) {
      throw new PptApiError('FORBIDDEN', 'origin not allowed for bootstrap transfer', {
        details: { origin },
      })
    }
    return allowed
  }
  return config.webOrigin
}

/**
 * Apply the mode/format-appropriate cache headers.
 *
 * A CONCRETE published version's (`?version=<n>`) bento/html source is
 * content-addressed by version_seq, so its URL never changes — it is served
 * with a long `private, max-age, immutable` and an ETag (the content hash).
 *
 * A `latest`/omitted published bento/html URL is MUTABLE: once R5 resolves
 * `latest` to the newest published deck, the same URL returns new bytes across
 * publishes. It must therefore NOT be `immutable` — it is served `private,
 * no-cache` with the content-hash ETag so the client always revalidates
 * conditionally and never pins a stale deck under a long max-age.
 *
 * Everything else — draft/live (unpublished working state) AND every bootstrap
 * payload (which embeds short-lived signed asset URLs that would go stale under
 * any cache) — is `private, no-store`. `private` (never `public`) throughout
 * because the bytes are authorized per-reader.
 */
function applyCacheHeaders(
  res: Response,
  mode: PptSourceMode,
  format: PptSourceFormat,
  version: 'latest' | number,
  content: PptSourceContent,
): void {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  const publishedSource = mode === 'published' && format !== 'bootstrap'
  if (publishedSource) {
    // Only a concrete numeric version addresses immutable content; `latest`
    // (or omitted) is mutable and must revalidate.
    if (typeof version === 'number') {
      res.setHeader('Cache-Control', `private, max-age=${config.ppt.publishedMaxAgeSeconds}, immutable`)
    } else {
      res.setHeader('Cache-Control', 'private, no-cache')
    }
    if (content.contentHash) res.setHeader('ETag', `"${content.contentHash}"`)
    return
  }
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Pragma', 'no-cache')
}

async function fetchContent(
  provider: PptSourceProvider,
  docId: string,
  mode: PptSourceMode,
  version: 'latest' | number,
): Promise<PptSourceContent | null> {
  switch (mode) {
    case 'draft':
      return provider.getDraft(docId)
    case 'live':
      return provider.getLive(docId)
    case 'published':
      return provider.getPublished(docId, version)
  }
}

/** GET /docs/:docId/source — the R3-B1 source/bootstrap handler. */
export function makePptSourceHandler(provider: PptSourceProvider) {
  return async function getPptSourceHandler(req: Request, res: Response): Promise<void> {
    const uid = req.uid!
    const spaceId = req.spaceId!
    const docId = req.params.docId ?? ''
    if (docId === '') {
      throw new PptApiError('VALIDATION_ERROR', 'docId is required', { details: { field: 'docId' } })
    }

    const mode = parseMode(req.query.mode)
    const format = parseFormat(req.query.format)
    const version = parseVersion(req.query.version, mode)

    // Load doc + resolve effective role (throws enveloped NOT_FOUND / CONFLICT /
    // UNSUPPORTED_DOCUMENT_TYPE). Role may be 'none'; the mode floor below rejects it.
    const { meta, role } = await loadPptDocForRead(uid, spaceId, docId, { token: req.octoToken })

    // ACCESS POLICY — the headline guarantee. reader/commenter fail the writer
    // floor on draft/live => 403; everyone with read access passes on published.
    if (!roleAtLeast(role, MODE_MIN_ROLE[mode])) {
      throw new PptApiError('FORBIDDEN', `insufficient role to read ${mode} source`)
    }

    // Origin safety: refuse a disallowed cross-origin request and resolve the
    // exact bootstrap target origin. Enforced for every format so no source is
    // served to a disallowed origin; the resolved value is only surfaced in the
    // bootstrap payload.
    const targetOrigin = resolveBootstrapOrigin(req)

    const content = await fetchContent(provider, docId, mode, version)
    if (!content) {
      // No such source yet (e.g. no published version) — the reader/commenter
      // empty state (PPT-UI-003), NOT a leak and NOT a 403.
      throw new PptApiError('NOT_FOUND', `no ${mode} source available for this document`)
    }

    if (format === 'html') {
      // Self-contained rendered HTML (§4 format=html). The rendered artifact is
      // produced at publish time (R5); until then a source with no rendered HTML
      // is a clean NOT_FOUND. The response is text/html — never the JSON envelope
      // — with the same cache policy as the other formats for this mode.
      if (!content.html) {
        throw new PptApiError('NOT_FOUND', 'no rendered HTML available for this source')
      }
      applyCacheHeaders(res, mode, format, version, content)
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.status(200).send(content.html)
      return
    }

    applyCacheHeaders(res, mode, format, version, content)

    if (format === 'bento') {
      // Raw bento/slides deck as the enveloped `data`.
      sendPptData(res, content.deck)
      return
    }

    // format === 'bootstrap'
    const editable = isUnpublishedEditable(mode, role)
    const payload = buildPptBootstrap({
      docId,
      documentName: meta.document_name,
      mode,
      role: role as Role, // role >= reader here (passed the floor), so never 'none'
      editable,
      content,
      targetOrigin,
    })
    sendPptData(res, payload)
  }
}

/**
 * Editable = the caller may mutate this source: writer/admin loading the
 * unpublished working state (draft/live). Published sources are read-only, and a
 * reader/commenter is read-only everywhere. Drives the client's edit affordances.
 */
function isUnpublishedEditable(mode: PptSourceMode, role: ResolvedRole): boolean {
  return (mode === 'draft' || mode === 'live') && roleAtLeast(role, 'writer')
}

/** Adapt an async handler so a thrown error reaches the router-scoped envelope handler. */
function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next)
  }
}

export interface PptSourceRouterDeps {
  /** Override the content source (tests inject published/live/html fixtures). */
  sourceProvider?: PptSourceProvider
}

/**
 * Build the PPT source sub-router (`GET /api/v1/ppt/docs/:docId/source`). Auth +
 * space guards run before the handler, exactly like the create route, so
 * `req.uid` / `req.spaceId` / `req.octoToken` are populated. The parent PPT
 * router supplies the router-scoped body parser + envelope error handler.
 */
export function createPptSourceRouter(deps: PptSourceRouterDeps = {}): ExpressRouter {
  const provider = deps.sourceProvider ?? defaultPptSourceProvider
  const router = Router()
  router.get(
    '/docs/:docId/source',
    pptAuthMiddleware,
    pptSpaceContextMiddleware,
    asyncHandler(makePptSourceHandler(provider)),
  )
  return router
}
