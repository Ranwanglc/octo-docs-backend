/**
 * Express REST app (§8.4). All endpoints mounted under /api/v1/docs/*.
 *
 * Mount order:
 *   1. public routes (collab-token, invite accept) — verify octo identity
 *      themselves and return their own 401, so they are mounted BEFORE
 *      authMiddleware.
 *   2. authMiddleware (octo identity -> req.uid) for the metadata operations.
 *   3. spaceContextMiddleware (X-Space-Id header -> req.spaceId) for the
 *      metadata operations; a missing header is a hard 400.
 *   4. metadata routers (docs / members / invites-admin / attachments).
 *
 * A second, bot-facing mount (§ v4.3) re-mounts the same metadata routers under
 * /v1/bot/docs behind verifyBot (bot token -> req.uid + server-resolved
 * req.spaceId) instead of authMiddleware + spaceContextMiddleware. The human
 * mount below is unchanged.
 */
import express, { type Express, Router, type Request, type Response, type NextFunction } from 'express'
import { config } from '../config/env.js'
import { corsMiddleware } from './cors.js'
import { attachmentBlobGateway, localBlobGatewayEnabled, isSignedBlobRequest } from './routes/attachmentBlob.js'
import { authMiddleware } from './middleware/auth.js'
import { spaceContextMiddleware } from './middleware/spaceContext.js'
import { verifyBotMiddleware } from './middleware/verifyBot.js'
import { createRateLimiter, type RateLimiterOptions } from './middleware/rateLimit.js'
import { collabTokenRouter } from './routes/collabToken.js'
import { docsRouter } from './routes/docs.js'
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
import { createPptRouter } from './ppt/envelope.js'
import { sanitizeUrlForLog } from './accessLog.js'

export function createApp(opts: { rateLimit?: RateLimiterOptions; trustProxy?: boolean | number | string } = {}): Express {
  const app = express()

  // Trust the reverse proxy (nginx) in front of us so req.ip — and therefore the
  // per-IP rate limiter below — reflects the real client from X-Forwarded-For
  // rather than the proxy address. Configurable per deployment (config.trustProxy).
  app.set('trust proxy', opts.trustProxy ?? config.trustProxy)

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
  if (localBlobGatewayEnabled()) {
    const blobLimiter = createRateLimiter(opts.rateLimit)
    app.use((req: Request, res: Response, next: NextFunction) => {
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
  const cardActionLimiter = createRateLimiter(opts.rateLimit)
  app.post(
    CARD_ACTION_DECIDE_PATH,
    cardActionLimiter,
    express.raw({ type: 'application/json', limit: '64kb' }),
    cardActionDecideHandler,
  )

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
    if (req.path === '/api/v1/ppt' || req.path.startsWith('/api/v1/ppt/')) return next()
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

  // 3. require a space context (X-Space-Id header) for the metadata operations
  api.use(spaceContextMiddleware)

  // 4. metadata operations
  api.use(docsRouter) // / , /:docId
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

  app.use('/api/v1/docs', api)

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
  app.use('/v1/bot/docs', botApi)

  // PPT contract surface (§3 / §4). Mounted as its OWN router so `/api/v1/ppt/**`
  // uses the C-style `{data}`/`{error}` envelope and error enum, while the legacy
  // `/api/v1/docs/**` surface below keeps its bare-JSON shape via the global
  // handler. R1 wires only the envelope + a terminal enveloped NOT_FOUND; the
  // concrete endpoints (and their auth guards) land inside createPptRouter in R2+.
  app.use('/api/v1/ppt', createPptRouter())

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
