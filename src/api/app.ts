/**
 * Express REST app (§8.4). All endpoints mounted under /api/v1/docs/*.
 *
 * Human mount order (remove-sp §6 physical router split):
 *   1. public routes (collab-token, invite accept) — verify octo identity
 *      themselves and return their own 401, so they are mounted BEFORE
 *      authMiddleware.
 *   2. authMiddleware (octo identity -> req.uid) for the metadata operations.
 *   3. humanDocSpaceScopeMiddleware -> req.docSpaceScope = { mode: 'human' }
 *      (locate single docs by path docId; X-Space-Id never scopes selection).
 *   4a. SpaceCollectionRouter — create/list/search/recent, EACH behind its own
 *       spaceContextMiddleware (X-Space-Id still required for collection ops).
 *   4b. DocumentResourceRouter — open-context, docId-first collab-token, and the
 *       single-doc get/view/rename/delete/share/octo-doc ops, WITHOUT any Space
 *       context middleware.
 *   4c. the remaining single-doc routers (members / invites-admin / attachments /
 *       comments / versions / content / sheet / scene / export / import).
 *
 * A second, bot-facing mount (§ v4.3) re-mounts the SAME metadata routers under
 * /v1/bot/docs behind verifyBot (bot token -> req.uid + server-resolved
 * req.spaceId + req.docSpaceScope = { mode: 'bot', spaceId }) instead of
 * authMiddleware. The bot keeps the shared `docsRouter` (collection + single-doc)
 * and its current same-space isolation unchanged — it never uses the human-only
 * DocumentResourceRouter (open-context / docId-first collab-token).
 *
 * SURFACE SPLIT (`opts.surface`, one service / two ports)
 * -------------------------------------------------------
 * A deployment can serve the mounts above on two DIFFERENT listeners from this
 * one process (see config.internalHttpPort and src/index.ts):
 *
 *   'internal' — routes whose ONLY caller is another service inside our own
 *                network, authenticated by the shared internal token:
 *                  /internal/html/**   (the html service registering published
 *                                       docs with docs-backend)
 *   'public'   — EVERYTHING else, i.e. every route that has a caller outside the
 *                container network today:
 *                  /api/v1/docs/**   (human session token, browser via nginx)
 *                  /api/v1/ppt/**    (human session token + X-Space-Id)
 *                  signed attachment blob gateway (browser PUT/GETs the binary
 *                                                  directly at this origin)
 *                  /v1/bot/docs/**   (bot token — published through the public
 *                                     gateway today; bot clients are not all
 *                                     in-network, so moving it would 404 them)
 *                  /api/v1/card-actions/decide (HMAC callback from octo-server,
 *                                     which is not necessarily on our network)
 *
 * The membership rule is deliberately conservative: a route only moves to the
 * internal surface when EVERY caller is provably in-network. `/v1/bot/docs` and
 * the card-action callback fail that test (bot-token clients and octo-server can
 * live off-network), so they stay on the public surface and their own token/HMAC
 * verify remains the authenticator — which it already is today. Reachability is
 * only narrowed where it costs no reachable caller.
 *
 * `/healthz` is mounted on BOTH so each listener is independently probeable.
 * 'all' (the default) mounts everything on one listener — the historical
 * behaviour, and what every deployment that does not set INTERNAL_HTTP_PORT
 * keeps getting.
 *
 * Each surface builds its OWN middleware instances (access log, CORS, rate
 * limiters), so the two listeners never share a rate-limit budget. Handler code
 * is untouched: this is purely which routers get mounted where.
 *
 * The split reduces attack surface; it is NOT an authentication boundary. The
 * internal route keeps its own verify step (the internal token), because a
 * compromised sibling container inside the same network can still reach the
 * internal port.
 */
import express, { type Express, Router, type Request, type Response, type NextFunction } from 'express'
import { config } from '../config/env.js'
import { corsMiddleware } from './cors.js'
import { attachmentBlobGateway, localBlobGatewayEnabled, isSignedBlobRequest } from './routes/attachmentBlob.js'
import { authMiddleware } from './middleware/auth.js'
import { verifyBotMiddleware } from './middleware/verifyBot.js'
import { humanDocSpaceScopeMiddleware } from './middleware/docSpaceScope.js'
import { createRateLimiter, type RateLimiterOptions } from './middleware/rateLimit.js'
import { collabTokenRouter } from './routes/collabToken.js'
import { docsRouter, documentResourceRouter, spaceCollectionRouter } from './routes/docs.js'
import { internalHtmlRegistrationRouter } from './routes/internalHtmlRegistration.js'
import { membersRouter } from './routes/members.js'
import { forwardGrantRouter } from './routes/forwardGrant.js'
import { accessRequestsRouter } from './routes/accessRequests.js'
import { cardActionDecideHandler, CARD_ACTION_DECIDE_PATH } from './routes/cardActionDecide.js'
import { invitesRouter, acceptInviteRouter, botAcceptInviteRouter } from './routes/invites.js'
import { attachmentsRouter } from './routes/attachments.js'
import { linkCardRouter } from './routes/linkCard.js'
import { commentsRouter } from './routes/comments.js'
import { versionsRouter } from './routes/versions.js'
import { docContentRouter } from './routes/docContent.js'
import { docSheetRouter } from './routes/docSheet.js'
import { docSceneRouter } from './routes/docScene.js'
import { exportRouter } from './routes/export.js'
import { boardExportRouter } from './routes/boardExport.js'
import { importRouter } from './routes/import.js'
import { createPptRouter, pptErrorHandler } from './ppt/envelope.js'
import { sanitizeUrlForLog } from './accessLog.js'

/** Which audience's routes a given listener serves. See the module comment. */
export type AppSurface = 'public' | 'internal' | 'all'

export function createApp(
  opts: { rateLimit?: RateLimiterOptions; trustProxy?: boolean | number | string; surface?: AppSurface } = {},
): Express {
  const app = express()
  const surface: AppSurface = opts.surface ?? 'all'
  const servePublic = surface !== 'internal'
  const serveInternal = surface !== 'public'

  // Trust the reverse proxy (nginx) in front of us so req.ip — and therefore the
  // per-IP rate limiter below — reflects the real client from X-Forwarded-For
  // rather than the proxy address. Configurable per deployment (config.trustProxy).
  //
  // The internal listener is deliberately NOT proxied by nginx (that is the point
  // of the split), so it defaults to NOT trusting X-Forwarded-For: honouring that
  // header there would let any in-network caller spoof its source IP and evade the
  // per-IP rate limiter. An explicit opts.trustProxy still wins for deployments
  // that do front the internal port with a mesh sidecar.
  app.set('trust proxy', opts.trustProxy ?? (surface === 'internal' ? false : config.trustProxy))

  // Route access log. Mounted FIRST so it covers EVERY request — including the
  // HMAC card-action callback and CORS preflight — and logs one line per request
  // on response finish: method, sanitized path, status, latency. This is a route
  // log (not a business log): it always fires regardless of handler outcome, so a
  // decide callback that 401s (bad signature) / 503s (grant failed) / 200s is
  // visible in the access log even when business-level console logs are dropped
  // by the log pipeline.
  //
  // Secrets are stripped before logging. `req.originalUrl` carries the full query
  // string, which for the blob gateway includes short-lived HMAC `X-Signature`
  // (and AWS-style `X-Amz-*`) params; invite tokens ride in the path. We redact
  // both so signed URLs / invite links can never be replayed from log access.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const startedAt = Date.now()
    res.on('finish', () => {
      const ms = Date.now() - startedAt
      // eslint-disable-next-line no-console
      console.log(`[octo-docs] ${req.method} ${sanitizeUrlForLog(req.originalUrl)} ${res.statusCode} ${ms}ms`)
    })
    next()
  })

  // CORS + preflight (XIN-717). Mounted FIRST — ahead of the body parser, rate
  // limiter and auth — so a cross-origin OPTIONS preflight from the front-end is
  // answered 2xx with the CORS headers without being throttled, body-parsed or
  // rejected by the auth chain, and every response carries Access-Control-Allow-
  // Origin for the configured origin(s). Covers both the metadata API and the
  // local-hmac attachment blob gateway below.
  app.use(corsMiddleware)

  // Self-hosted attachment blob gateway (XIN-717). Only relevant for the
  // local-hmac driver, where the browser PUTs/GETs the binary directly at this
  // origin. Mounted before express.json so it can read the raw upload stream;
  // it claims ONLY signed requests (carrying X-Method + X-Signature) and passes
  // everything else through, so it never shadows the routes below.
  //
  // A per-IP rate limiter runs IN FRONT of the gateway so the blob PUT/GET
  // surface cannot be flooded to bypass throttling (XIN-728). The limiter is
  // applied only to requests the gateway actually claims — non-blob requests
  // (healthz, the metadata/bot mounts, CORS preflight) skip it entirely and keep
  // their own independent limiter budgets downstream.
  if (servePublic && localBlobGatewayEnabled()) {
    const blobLimiter = createRateLimiter(opts.rateLimit)
    app.use((req: Request, res: Response, next: NextFunction) => {
      // Never let the query-param HMAC gateway claim a PPT path: it terminates
      // the response itself with a bare `{ error: 'invalid_signature' }`, which
      // would leak the legacy shape into the PPT contract. PPT keeps its own
      // enveloped surface for every request, signed-looking or not.
      if (/^\/api\/v1\/ppt(\/|$)/i.test(req.path)) {
        next()
        return
      }
      if (!isSignedBlobRequest(req)) {
        next()
        return
      }
      blobLimiter(req, res, (err?: unknown) => {
        if (err) {
          next(err)
          return
        }
        attachmentBlobGateway(req, res, next)
      })
    })
  }

  // Signed card-action callback (docs approve/deny). HMAC-authenticated, so it
  // sits OUTSIDE the auth/space chain; it reads the RAW body for signature
  // verification, so it MUST be mounted before the global express.json below.
  //
  // A per-IP rate limiter runs IN FRONT of the HMAC verify so an attacker
  // cannot flood the signature-check path (each request forces a sha256 + HMAC
  // compute) or brute-force signatures unthrottled. It gets its own limiter
  // instance so its budget is independent of the blob gateway's above.
  //
  // PUBLIC surface (deliberate — do not "move it inside"): the caller is
  // octo-server, which is NOT necessarily deployed on our container network. If
  // this route were internal-only, enabling the split would 404 every 同意/拒绝
  // tap in any cross-network topology. The authenticator here is the HMAC over
  // the raw body + timestamp freshness + an idempotency receipt — not network
  // position — and the route is already publicly reachable today, so keeping it
  // public is not a posture regression. The signed canonical covers the PATH
  // only (see cardActionDecide.ts), so repointing host/port never invalidates a
  // signature either way.
  if (servePublic) {
    const cardActionLimiter = createRateLimiter(opts.rateLimit)
    app.post(
      CARD_ACTION_DECIDE_PATH,
      cardActionLimiter,
      express.raw({ type: 'application/json', limit: '64kb' }),
      cardActionDecideHandler,
    )
  }

  const jsonBodyParser = express.json({ limit: '1mb' })
  app.use((req, res, next) => {
    // The Excalidraw importer needs the exact application/json bytes so it can
    // reject malformed UTF-8/JSON and enforce its own byte boundary before
    // walking the untrusted scene. Leave only that route for express.raw.
    if (req.path.endsWith('/import/excalidraw')) return next()
    // The PPT surface parses its own body INSIDE createPptRouter so that a
    // malformed-JSON body error is caught by the router-scoped pptErrorHandler
    // and rendered as the C-style VALIDATION_ERROR envelope. If the global
    // parser ran here it would throw before the PPT mount and the central
    // bare-JSON handler would emit `{ error: 'invalid_body' }`, leaking the
    // legacy shape into the PPT contract.
    //
    // Match Express's OWN mount semantics: `app.use('/api/v1/ppt', …)` is
    // case-insensitive by default, so the skip MUST be too — otherwise a
    // case-variant path (`/api/v1/PPT/…`) is served by the PPT router but its
    // body is parsed by the global parser here, and the leak persists on exactly
    // the routes the router serves.
    if (/^\/api\/v1\/ppt(\/|$)/i.test(req.path)) return next()
    return jsonBodyParser(req, res, next)
  })

  // health check (no auth, and deliberately mounted BEFORE any rate limiter so
  // liveness/readiness probes are never throttled)
  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true })
  })

  const api = Router()

  // 0. per-IP rate limit for the whole human chain (§8.4). Mounted first so it
  //    also covers the public collab-token / invite-accept routes below and the
  //    authorizing metadata routers.
  api.use(createRateLimiter(opts.rateLimit))

  // 1. public (identity verified inside the handler/service)
  api.use(collabTokenRouter) // POST /collab-token
  api.use(acceptInviteRouter) // POST /invites/:inviteToken/accept

  // 2. require octo identity for everything below
  api.use(authMiddleware)

  // 3. Human doc space-scoping policy (remove-sp §6). Declares `req.docSpaceScope
  //    = { mode: 'human' }` so the shared doc guards locate single documents by
  //    path `docId` ALONE (X-Space-Id never scopes selection/authz), and parses
  //    the OPTIONAL viewer Space for the verified-or-skip recent-view write. The
  //    hard-400 X-Space-Id parser and the membership gate now live per-route in
  //    SpaceCollectionRouter, so `/d/:docId` opens never depend on that header.
  api.use(humanDocSpaceScopeMiddleware)

  // 4a. SpaceCollectionRouter (remove-sp §6): the Space-scoped collection ops
  //     (create / list / search / recent). Each route carries its OWN
  //     spaceContextMiddleware (X-Space-Id required). Mounted BEFORE the
  //     DocumentResourceRouter so the fixed paths (`/`, `/search`, `/recent`,
  //     `/recent/creators`) are never shadowed by the router's `/:docId`.
  api.use(spaceCollectionRouter)

  // 4b. DocumentResourceRouter (remove-sp §6): every single-document operation,
  //     located by path docId with NO spaceContextMiddleware — open-context, the
  //     docId-first collab-token, view, share, get/rename/delete, octo-doc slug.
  api.use(documentResourceRouter)

  // 4c. the remaining single-document routers. All locate by path `/:docId/...`
  //     via the shared requireDocRole guard (which reads req.docSpaceScope), so
  //     none require an X-Space-Id header on the human chain any longer.
  api.use(membersRouter) // /:docId/members ...
  api.use(forwardGrantRouter) // /:docId/forward-grant (forward-to-chat authorization, max-merge)
  api.use(accessRequestsRouter) // /:docId/access-requests ... (screen 4c request/approve/deny)
  api.use(invitesRouter) // /:docId/invites ... (admin)
  api.use(attachmentsRouter) // /:docId/attachments/presign , /:docId/attachments/:attachId
  api.use(linkCardRouter) // /:docId/link-card (OG fetch, §3.5 ⑰)
  api.use(commentsRouter) // /:docId/comments , /:docId/comments/:id
  api.use(versionsRouter) // /:docId/versions ... (snapshot + restore, §4 #4)
  api.use(docContentRouter) // /:docId/content (bot incremental body edit + live read)
  api.use(docSheetRouter) // /:docId/sheet (live spreadsheet content read, R-A)
  api.use(docSceneRouter) // /:docId/scene (live board/Excalidraw scene read + edit)
  api.use(exportRouter) // /:docId/export/pdf (server-side Typst render)
  api.use(boardExportRouter) // /:docId/export (server-side whiteboard PNG/SVG, W3)
  api.use(importRouter) // /:docId/import/docx (server-side .docx -> ProseMirror JSON)

  // Mounted only on the public surface: this is the browser-facing human API.
  if (servePublic) app.use('/api/v1/docs', api)

  // Internal surface: the html service registers published docs here with the
  // shared internal token — no browser ever calls it.
  if (serveInternal) app.use('/internal/html', createRateLimiter(opts.rateLimit), internalHtmlRegistrationRouter)

  // Bot-facing entry (§ v4.3): the SAME nine metadata routers, re-mounted behind
  // a bot identity middleware at a physically distinct prefix so nginx can route
  // /v1/bot/docs -> docs-backend while other /v1/bot/* -> octo-server. No handler
  // code is copied or forked — each router only reads req.uid / req.spaceId, both
  // of which verifyBot injects (uid from the bot token, spaceId from octo-server's
  // server-side reverse lookup). The bot invite-accept route (docs #61) is the one
  // public route re-exposed here: it reuses the human accept transaction via
  // acceptInviteForUid, reading the bot uid verifyBot injected on req.uid (not a
  // user session token). The collab-token route stays human-only. This mount does
  // NOT add spaceContextMiddleware — the bot space is server-resolved, never
  // header-driven.
  const botApi = Router()
  // Same per-IP rate limit for the bot chain (independent budget from the human
  // mount), mounted ahead of verifyBot so the authorizing bot routes are covered.
  botApi.use(createRateLimiter(opts.rateLimit))
  botApi.use(verifyBotMiddleware)
  botApi.use(botAcceptInviteRouter) // POST /v1/bot/docs/invites/:inviteToken/accept (docs #61)
  botApi.use(docsRouter)
  botApi.use(membersRouter)
  botApi.use(forwardGrantRouter)
  botApi.use(accessRequestsRouter)
  botApi.use(invitesRouter)
  botApi.use(attachmentsRouter)
  botApi.use(linkCardRouter)
  botApi.use(commentsRouter)
  botApi.use(versionsRouter)
  botApi.use(docContentRouter)
  botApi.use(docSheetRouter)
  botApi.use(docSceneRouter)
  botApi.use(exportRouter) // /v1/bot/docs/:docId/export/file?format=... and legacy PDF
  botApi.use(boardExportRouter) // /v1/bot/docs/:docId/export (whiteboard PNG/SVG, W3)
  botApi.use(importRouter) // /v1/bot/docs/:docId/import/{docx|markdown|xlsx}
  // PUBLIC surface (deliberate): this prefix is published through the public
  // gateway today — that is its entire reason for existing (see the comment
  // above: nginx routes /v1/bot/docs -> docs-backend). Its clients are bot-token
  // holders that are not all in-network (octo-server, bot integrations, and the
  // user-visible /v1/bot/docs/:docId/export/file links), and an off-network one
  // cannot be repointed at all. Moving it behind the internal port would hard-404
  // every such caller the moment the split is enabled, so it stays public and
  // verifyBot remains the authenticator — exactly as it is today.
  if (servePublic) app.use('/v1/bot/docs', botApi)

  // PPT contract surface (§3 / §4). Mounted as its OWN router so `/api/v1/ppt/**`
  // uses the C-style `{data}`/`{error}` envelope and error enum, while the legacy
  // `/api/v1/docs/**` surface below keeps its bare-JSON shape via the global
  // handler. R1 wires only the envelope + a terminal enveloped NOT_FOUND; the
  // concrete endpoints land inside createPptRouter in R2+.
  //
  // Fronted by the SAME per-IP rate limiter as the human/bot chains above so the
  // surface is not un-throttled (every other API mount starts its chain with a
  // limiter — see §8.4). AUTH POSTURE (deliberate, read before adding R2
  // handlers): this chain does NOT run authMiddleware / spaceContextMiddleware,
  // so `req.uid` / `req.spaceId` are NOT pre-populated here. R2 PPT endpoints
  // must apply their own auth guards and must NOT assume `req.uid` is set — a
  // handler copied from the legacy routers (which read `req.uid!`) would run
  // unauthenticated. PPT auth lands per-endpoint inside createPptRouter in R2+.
  if (servePublic) {
    const pptApi = Router()
    // The 429 body MUST be the C-style envelope, not the legacy bare
    // `{ error: 'rate_limited' }` — a throttle is ordinary production behavior and
    // the canonical path, so a PPT client reading `body.error.code` must not break
    // on it. RATE_LIMITED (429) exists in the enum for exactly this.
    pptApi.use(createRateLimiter({ ...opts.rateLimit, message: { error: { code: 'RATE_LIMITED', message: 'rate limited' } } }))
    pptApi.use(createPptRouter())
    app.use('/api/v1/ppt', pptApi)
    // Belt-and-braces: register the envelope error handler at app level too, scoped
    // to the same prefix. A mounted Router has arity 3, so an error raised by any
    // app-level middleware BEFORE the mount would otherwise skip the router-scoped
    // handler and fall through to the global bare-JSON handler. This app-level
    // registration uses Express's own case-insensitive mount matching (no path
    // string of our own to keep in sync) and renders ANY pre-mount error for a PPT
    // path as the C-style envelope, not just the body-parser types.
    app.use('/api/v1/ppt', pptErrorHandler)
  }

  // central error handler — unexpected errors => 500 (§8.4 error table).
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return
    // Body-parser (express.json) failures arrive here as typed errors. Map them
    // to their contract codes instead of letting them bubble to a 500 (defect ③):
    //   - malformed JSON body  -> 400 invalid_body
    //   - body over the size limit -> 413 doc_too_large (sheet_too_large on /sheet)
    const type = (err as { type?: unknown }).type
    if (type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_body' })
      return
    }
    if (type === 'entity.too.large') {
      // The oversized-body 413 rejection is raised by express.json BEFORE any
      // route handler runs, so the sheet write path never reaches its own
      // sheet-specific bounds. Align the error code with the endpoint the client
      // hit: the sheet content surface (GET/PATCH /:docId/sheet) reports
      // sheet_too_large — matching its in-handler read guard and issue #69's 1MB
      // sheet contract — while every other route keeps doc_too_large.
      const code = req.path.endsWith('/sheet') ? 'sheet_too_large' : 'doc_too_large'
      res.status(413).json({ error: code })
      return
    }
    // eslint-disable-next-line no-console
    console.error('REST error:', err)
    res.status(500).json({ error: 'internal_error' })
  })

  return app
}
