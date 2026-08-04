/**
 * C-style response envelope + fixed error enum, scoped to `/api/v1/ppt/**`.
 *
 * B's legacy surface (`/api/v1/docs/**`) returns BARE JSON — success bodies are
 * raw objects and the central error handler emits a flat `{ error: '<string>' }`
 * (see api/app.ts). PPT deliberately does NOT reuse that shape: per the gate3
 * design (§3.2 / §4) the PPT API mirrors the C service's envelope:
 *
 *   success : { "data": <payload> }
 *   list    : { "data": [...], "pagination": { nextCursor, hasMore } }
 *   failure : { "error": { code, message, details?, hint? } }
 *
 * The error enum is ported verbatim from C's `errorEnum`
 * (octo-docs-html internal/transport/httpx/envelope.go:71-92) with ONE addition:
 * `UNSUPPORTED_DOCUMENT_TYPE` (422), which C does not define — it is PPT-specific
 * for wrong-kind calls (a non-`html_ppt` doc hitting a PPT endpoint, or a PPT doc
 * hitting a Yjs-only endpoint).
 *
 * List pagination is a DELIBERATE divergence from C: C uses offset pagination
 * ({total,page,page_size}); PPT uses cursor pagination ({nextCursor,hasMore}) per
 * the PRD. This module therefore only exposes the cursor shape.
 *
 * This adapter is intentionally isolated to the PPT router so legacy `/docs`
 * responses stay byte-for-byte unchanged; nothing here touches the global
 * bare-JSON error handler.
 */
import { Router, json, type Request, type Response, type NextFunction } from 'express'

/**
 * Fixed HTTP-status-to-code map. The first ten codes are C's enum verbatim; the
 * eleventh (`UNSUPPORTED_DOCUMENT_TYPE`) is the PPT-specific addition. C maps
 * `UPSTREAM_UNAVAILABLE` to 502/503 — B pins the single canonical 502 for the
 * outbound status line while still accepting either upstream.
 */
export const PPT_ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  UNSUPPORTED_DOCUMENT_TYPE: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  UPSTREAM_UNAVAILABLE: 502,
} as const

export type PptErrorCode = keyof typeof PPT_ERROR_STATUS

/**
 * The subset of {@link PptErrorCode} that exists in C's `errorEnum`. Kept as an
 * explicit list so a contract test can assert that PPT adds EXACTLY
 * `UNSUPPORTED_DOCUMENT_TYPE` on top of the ported C codes — no silent drift.
 */
export const C_PORTED_ERROR_CODES: readonly PptErrorCode[] = [
  'VALIDATION_ERROR',
  'AUTH_REQUIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'UPSTREAM_UNAVAILABLE',
]

/** The PPT-only additions on top of the C-ported enum. */
export const PPT_ONLY_ERROR_CODES: readonly PptErrorCode[] = ['UNSUPPORTED_DOCUMENT_TYPE']

/** Shape of the `error` object inside a failure envelope. */
export interface PptErrorBody {
  code: PptErrorCode
  message: string
  details?: unknown
  hint?: string
}

/** Cursor pagination block on a list envelope (PRD §4.1 — NOT C's offset shape). */
export interface PptCursorPagination {
  /** Opaque cursor for the next page, or null when there is no next page. */
  nextCursor: string | null
  /** True when another page exists (i.e. `nextCursor` is non-null). */
  hasMore: boolean
}

export interface PptErrorOptions {
  details?: unknown
  hint?: string
}

/**
 * A typed PPT API failure. Handlers throw this (or call {@link sendPptError}
 * directly); the router-scoped {@link pptErrorHandler} renders it as the failure
 * envelope with the enum's fixed HTTP status. Carrying the code (not the status)
 * keeps the HTTP status a pure function of the enum.
 */
export class PptApiError extends Error {
  readonly code: PptErrorCode
  readonly httpStatus: number
  readonly details?: unknown
  readonly hint?: string

  constructor(code: PptErrorCode, message: string, opts: PptErrorOptions = {}) {
    super(message)
    this.name = 'PptApiError'
    this.code = code
    this.httpStatus = PPT_ERROR_STATUS[code]
    if (opts.details !== undefined) this.details = opts.details
    if (opts.hint !== undefined) this.hint = opts.hint
  }

  /** Convenience factory for the PPT-specific wrong-kind failure (422). */
  static unsupportedDocumentType(message = 'document type does not support this operation', opts: PptErrorOptions = {}): PptApiError {
    return new PptApiError('UNSUPPORTED_DOCUMENT_TYPE', message, opts)
  }
}

/** Write a success envelope: `{ data }` at `status` (default 200). */
export function sendPptData<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ data })
}

/** Write a list envelope: `{ data: items, pagination }` at `status` (default 200). */
export function sendPptList<T>(res: Response, items: T[], pagination: PptCursorPagination, status = 200): void {
  res.status(status).json({ data: items, pagination })
}

/** Write a failure envelope: `{ error: { code, message, details?, hint? } }`. */
export function sendPptError(res: Response, code: PptErrorCode, message: string, opts: PptErrorOptions = {}): void {
  const error: PptErrorBody = { code, message }
  if (opts.details !== undefined) error.details = opts.details
  if (opts.hint !== undefined) error.hint = opts.hint
  res.status(PPT_ERROR_STATUS[code]).json({ error })
}

/**
 * Router-scoped error handler for `/api/v1/ppt/**`. Renders every failure as the
 * C-style envelope so a thrown error never leaks the global bare-JSON
 * `{ error: 'internal_error' }` shape into the PPT contract.
 *
 * Mapping:
 *  - PptApiError                     -> its own code + status
 *  - express.json `entity.parse.failed` -> 400 VALIDATION_ERROR
 *  - express.json `entity.too.large`    -> 413 PAYLOAD_TOO_LARGE
 *  - anything else                   -> 500 INTERNAL_ERROR (logged, message not leaked)
 */
export function pptErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err)
    return
  }
  if (err instanceof PptApiError) {
    sendPptError(res, err.code, err.message, { details: err.details, hint: err.hint })
    return
  }
  const type = (err as { type?: unknown } | null)?.type
  if (type === 'entity.parse.failed') {
    sendPptError(res, 'VALIDATION_ERROR', 'malformed JSON body')
    return
  }
  if (type === 'entity.too.large') {
    sendPptError(res, 'PAYLOAD_TOO_LARGE', 'request body too large')
    return
  }
  // eslint-disable-next-line no-console
  console.error('PPT API error:', err)
  sendPptError(res, 'INTERNAL_ERROR', 'internal error')
}

/**
 * Build the `/api/v1/ppt` router (R1 contract spine).
 *
 * R1 wires the envelope machinery only: the concrete endpoints (create, register,
 * source, draft, versions, collab-token, comments) land in R2+ and will be added
 * to THIS router BEFORE the terminal handlers below, behind their own auth guards.
 * Until then every PPT path resolves to an enveloped `NOT_FOUND` (not the global
 * bare-JSON 404), so the C-style contract is already observable and the legacy
 * `/api/v1/docs/**` surface stays untouched.
 */
export function createPptRouter(): Router {
  const router = Router()

  // Body parsing is scoped to THIS router (the global express.json in
  // api/app.ts deliberately skips `/api/v1/ppt/**`). Parsing here means a
  // malformed-JSON body raises `entity.parse.failed` INSIDE the router, so the
  // router-scoped pptErrorHandler below renders it as the C-style
  // VALIDATION_ERROR envelope instead of the global bare-JSON `invalid_body`.
  router.use(json({ limit: '1mb' }))

  // R2+ endpoint routers mount here.

  // Terminal 404: any PPT path without a matching route returns the enveloped
  // NOT_FOUND rather than falling through to the app's bare-JSON handler.
  router.use((_req: Request, res: Response) => {
    sendPptError(res, 'NOT_FOUND', 'resource not found')
  })

  // Router-scoped error envelope (must be registered last).
  router.use(pptErrorHandler)

  return router
}
