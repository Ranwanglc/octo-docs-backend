import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { Request, Response, NextFunction } from 'express'
import {
  PPT_ERROR_STATUS,
  C_PORTED_ERROR_CODES,
  PPT_ONLY_ERROR_CODES,
  PptApiError,
  sendPptData,
  sendPptList,
  sendPptError,
  pptErrorHandler,
  type PptErrorCode,
} from '../src/api/ppt/envelope.js'
import { createApp } from '../src/api/app.js'

// Minimal Response stub that records status + json payloads, enough to assert the
// envelope shape without a live HTTP server (used by the pure send/handler tests).
function fakeRes() {
  const rec = { status: 0, body: undefined as unknown, headersSent: false }
  const res = {
    get headersSent() {
      return rec.headersSent
    },
    status(code: number) {
      rec.status = code
      return this
    },
    json(payload: unknown) {
      rec.body = payload
      rec.headersSent = true
      return this
    },
  } as unknown as Response
  return { res, rec }
}

describe('PPT error enum — ported from C + one PPT-specific addition', () => {
  it('maps every code to its fixed HTTP status', () => {
    expect(PPT_ERROR_STATUS).toEqual({
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
    })
  })

  it('adds EXACTLY UNSUPPORTED_DOCUMENT_TYPE(422) on top of the C-ported codes', () => {
    expect(PPT_ONLY_ERROR_CODES).toEqual(['UNSUPPORTED_DOCUMENT_TYPE'])
    expect(PPT_ERROR_STATUS.UNSUPPORTED_DOCUMENT_TYPE).toBe(422)
    // C's enum does not include a document-type code — assert it is NOT in the
    // ported set, so a future edit cannot quietly reclassify it as "from C".
    expect(C_PORTED_ERROR_CODES).not.toContain('UNSUPPORTED_DOCUMENT_TYPE')
    // The ported set + PPT-only set must together cover every code exactly once.
    const all = [...C_PORTED_ERROR_CODES, ...PPT_ONLY_ERROR_CODES].sort()
    expect(all).toEqual((Object.keys(PPT_ERROR_STATUS) as PptErrorCode[]).sort())
  })
})

describe('envelope writers', () => {
  it('sendPptData wraps the payload in { data } at 200 by default', () => {
    const { res, rec } = fakeRes()
    sendPptData(res, { id: 'x' })
    expect(rec.status).toBe(200)
    expect(rec.body).toEqual({ data: { id: 'x' } })
  })

  it('sendPptData honors a custom status (e.g. 201 create)', () => {
    const { res, rec } = fakeRes()
    sendPptData(res, { id: 'x' }, 201)
    expect(rec.status).toBe(201)
    expect(rec.body).toEqual({ data: { id: 'x' } })
  })

  it('sendPptList emits { data, pagination } with the cursor shape (NOT C offset)', () => {
    const { res, rec } = fakeRes()
    sendPptList(res, [{ v: 1 }], { nextCursor: 'c2', hasMore: true })
    expect(rec.status).toBe(200)
    expect(rec.body).toEqual({ data: [{ v: 1 }], pagination: { nextCursor: 'c2', hasMore: true } })
  })

  it('sendPptError emits { error: { code, message } } at the enum status', () => {
    const { res, rec } = fakeRes()
    sendPptError(res, 'FORBIDDEN', 'nope')
    expect(rec.status).toBe(403)
    expect(rec.body).toEqual({ error: { code: 'FORBIDDEN', message: 'nope' } })
  })

  it('sendPptError includes optional details/hint only when provided', () => {
    const { res, rec } = fakeRes()
    sendPptError(res, 'CONFLICT', 'dup', { details: { key: 'k' }, hint: 'retry' })
    expect(rec.body).toEqual({ error: { code: 'CONFLICT', message: 'dup', details: { key: 'k' }, hint: 'retry' } })
  })
})

describe('PptApiError', () => {
  it('derives httpStatus from the code', () => {
    const e = new PptApiError('NOT_FOUND', 'gone')
    expect(e.code).toBe('NOT_FOUND')
    expect(e.httpStatus).toBe(404)
  })

  it('exposes the unsupportedDocumentType factory (422)', () => {
    const e = PptApiError.unsupportedDocumentType()
    expect(e.code).toBe('UNSUPPORTED_DOCUMENT_TYPE')
    expect(e.httpStatus).toBe(422)
  })
})

describe('pptErrorHandler', () => {
  const noop: NextFunction = () => {}
  const req = {} as Request

  it('renders a PptApiError as its envelope', () => {
    const { res, rec } = fakeRes()
    pptErrorHandler(PptApiError.unsupportedDocumentType('wrong kind'), req, res, noop)
    expect(rec.status).toBe(422)
    expect(rec.body).toEqual({ error: { code: 'UNSUPPORTED_DOCUMENT_TYPE', message: 'wrong kind' } })
  })

  it('maps a body-parser parse failure to 400 VALIDATION_ERROR', () => {
    const { res, rec } = fakeRes()
    pptErrorHandler({ type: 'entity.parse.failed' }, req, res, noop)
    expect(rec.status).toBe(400)
    expect((rec.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
  })

  it('maps an oversized body to 413 PAYLOAD_TOO_LARGE', () => {
    const { res, rec } = fakeRes()
    pptErrorHandler({ type: 'entity.too.large' }, req, res, noop)
    expect(rec.status).toBe(413)
    expect((rec.body as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('maps an unexpected error to 500 INTERNAL_ERROR without leaking the message', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { res, rec } = fakeRes()
    pptErrorHandler(new Error('secret internal detail'), req, res, noop)
    expect(rec.status).toBe(500)
    expect(rec.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'internal error' } })
    warn.mockRestore()
  })

  it('delegates to next when the response was already sent', () => {
    const sent = fakeRes()
    sent.rec.headersSent = true
    let forwarded: unknown = null
    pptErrorHandler(new Error('late'), req, sent.res, (e) => {
      forwarded = e
    })
    expect(forwarded).toBeInstanceOf(Error)
  })
})

// Integration: the envelope is scoped to /api/v1/ppt/**. An unimplemented PPT path
// returns an ENVELOPED NOT_FOUND, while the legacy surface stays bare JSON.
describe('PPT envelope is scoped to /api/v1/ppt (integration)', () => {
  let server: Server
  let base: string

  beforeAll(async () => {
    const app = createApp()
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve)
    })
    const { port } = server.address() as AddressInfo
    base = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  })

  it('an unimplemented /api/v1/ppt path returns an enveloped NOT_FOUND', async () => {
    const res = await fetch(`${base}/api/v1/ppt/docs/whatever`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'resource not found' } })
  })

  it('a malformed JSON body on /api/v1/ppt returns the C-style VALIDATION_ERROR envelope, not the global invalid_body', async () => {
    // Regression for the envelope-order bug: the global express.json parser
    // (mounted before the PPT router) used to catch the parse error first and
    // emit the legacy bare-JSON `{ error: 'invalid_body' }`. The PPT router now
    // parses its own body, so `entity.parse.failed` is caught by the
    // router-scoped pptErrorHandler and rendered as the C-style envelope.
    const res = await fetch(`${base}/api/v1/ppt/docs/x`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad-json',
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(typeof body.error.message).toBe('string')
    // It must NOT leak the legacy bare-JSON shape.
    expect(body).not.toHaveProperty('error.0')
    expect((body as { error: unknown }).error).not.toBe('invalid_body')
  })

  it('an oversized JSON body on /api/v1/ppt returns the C-style PAYLOAD_TOO_LARGE envelope, not the global doc_too_large', async () => {
    // The router-scoped json parser enforces the 1mb limit; entity.too.large is
    // caught by pptErrorHandler and enveloped, rather than bubbling to the global
    // handler that emits the legacy bare-JSON `doc_too_large`.
    const huge = JSON.stringify({ a: 'x'.repeat(1024 * 1024 + 16) })
    const res = await fetch(`${base}/api/v1/ppt/docs/x`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: huge,
    })
    expect(res.status).toBe(413)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE')
    expect((body as { error: unknown }).error).not.toBe('doc_too_large')
  })

  it('a malformed JSON body on a CASE-VARIANT /api/v1/PPT path also returns the C-style envelope', async () => {
    // Express mount matching is case-insensitive, so /api/v1/PPT is served by the
    // PPT router; the global-parser skip is case-insensitive to match, so the
    // envelope holds on case variants too (no casing-selected leak).
    for (const variant of ['/api/v1/PPT/docs/x', '/api/v1/Ppt/docs/x']) {
      const res = await fetch(`${base}${variant}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{bad-json',
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe('VALIDATION_ERROR')
      expect((body as { error: unknown }).error).not.toBe('invalid_body')
    }
  })

  it('legacy /v1/bot/docs errors stay BARE JSON (not envelope-wrapped)', async () => {
    // A malformed body on a legacy route is rejected by the global bare-JSON
    // handler as { error: 'invalid_body' } — proving the envelope did not leak
    // into the legacy surface.
    const res = await fetch(`${base}/v1/bot/docs/d_1/content`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
      body: '{bad-json',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_body' })
  })
})

// The PPT surface sits behind the same per-IP rate limiter as the other API
// chains (P1-B): a burst past the window limit is throttled with 429, not served
// unthrottled as a fixed cheap 404.
describe('PPT surface is rate-limited (integration, P1-B)', () => {
  let server: Server
  let base: string

  beforeAll(async () => {
    const app = createApp({ rateLimit: { max: 3, windowMs: 60_000 } })
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve)
    })
    const { port } = server.address() as AddressInfo
    base = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  })

  it('throttles /api/v1/ppt after the per-IP limit', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${base}/api/v1/ppt/anything`, { headers: { 'x-forwarded-for': '203.0.113.7' } })
      statuses.push(res.status)
    }
    // First few resolve to the enveloped 404; once the window limit is hit the
    // limiter takes over with 429.
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0)
    expect(statuses.slice(0, 3).every((s) => s === 404)).toBe(true)
  })
})
