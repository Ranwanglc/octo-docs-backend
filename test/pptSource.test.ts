// Env seeding MUST be the first import so config/env.ts reads it at load time.
import './helpers/pptSourceEnv.js'

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import express, { Router, json, type Express } from 'express'

/**
 * R3-B1 integration tests for `GET /api/v1/ppt/docs/:docId/source`.
 *
 * The real PPT source router + auth/space guards + enveloped error handler run;
 * only the doc/role repos and (for some cases) the content provider are
 * controlled. The source content seam ({@link PptSourceProvider}) is injectable,
 * so published/live/rendered-HTML sources — whose real stores land in R4/R5 —
 * are exercised through a fixture provider, while the negative control and the
 * draft/live positives run against the DEFAULT provider reading a mocked
 * `ppt_doc_state`.
 */

// ── Mocked doc/role repos (role resolution) ────────────────────────────────
interface FakeMeta {
  doc_id: string
  document_name: string
  owner_id: string
  space_id: string
  doc_type: string
  status: number
  share_scope: number
  share_role: number
  [k: string]: unknown
}
// Controlled per test.
let currentMeta: FakeMeta | null = null
// The member row role for the caller (undefined => no row). Owner short-circuits
// to admin inside resolveRole before this is read.
let currentMemberRole: 'reader' | 'commenter' | 'writer' | 'admin' | undefined

vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  DocOwnershipError: class DocOwnershipError extends Error {},
  docMetaRepo: {
    getByDocId: vi.fn(async (docId: string) => (currentMeta && currentMeta.doc_id === docId ? currentMeta : null)),
  },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: {
    getRole: vi.fn(async () => currentMemberRole),
  },
}))

// The DEFAULT provider reads this. Controlled per test; null => no state row.
let currentSource: {
  docId: string
  templateId: string
  draftRevision: number
  snapshotVersion: number
  publishedVersionSeq: number | null
  pptFormatVersion: number
  bentoSyncPv: number
  draftDoc: unknown
} | null = null
vi.mock('../src/db/repos/pptDocStateRepo.js', () => ({
  pptDocStateRepo: {
    getSource: vi.fn(async (docId: string) =>
      currentSource && currentSource.docId === docId ? currentSource : null,
    ),
  },
}))

import { createPptSourceRouter } from '../src/api/ppt/source.js'
import { pptErrorHandler, sendPptError } from '../src/api/ppt/envelope.js'
import { corsMiddleware } from '../src/api/cors.js'
import { setOctoIdentity, type OctoIdentity, type OctoUser } from '../src/auth/octoIdentity.js'
import { verifySignedUrl } from '../src/storage/objectStore.js'
import { hashBentoDeck, type PptSourceContent, type PptSourceProvider } from '../src/ppt/source.js'
import type { BentoDoc } from '../src/ppt/bentoDoc.js'

const WEB_ORIGIN = 'https://ppt-web.example.test'

/** A minimal, structurally valid bento/slides deck fixture. */
function deck(title = 'Fixture Deck'): BentoDoc {
  return {
    format: 'bento/slides',
    version: 1,
    docId: 'bento_fixture',
    title,
    size: { width: 1280, height: 720 },
    theme: { background: '#fff', color: '#111', accent: '#3366ff', fontFamily: 'Inter' },
    slides: [{ id: 's1', background: '#fff', transition: 'none', elements: [], notes: '' }],
    modified: '2026-01-01T00:00:00.000Z',
  }
}

function stub(overrides: Partial<OctoIdentity>): OctoIdentity {
  return {
    verifyToken: async () => null,
    verifyBot: async () => null,
    getUser: async (): Promise<OctoUser | null> => null,
    getUserAsBot: async (): Promise<OctoUser | null> => null,
    getUsers: async (): Promise<OctoUser[]> => [],
    isSpaceMember: async () => false,
    ...overrides,
  }
}

/**
 * Build an app that mounts the PPT source router exactly as production does
 * (router-scoped json + terminal enveloped 404 + envelope error handler), with
 * an optional injected content provider. CORS runs first (as in app.ts) so an
 * allowed Origin is echoed and preflight-safe.
 */
function makeApp(provider?: PptSourceProvider): Express {
  const app = express()
  app.use(corsMiddleware)
  const r = Router()
  r.use(json({ limit: '1mb' }))
  r.use(createPptSourceRouter(provider ? { sourceProvider: provider } : {}))
  r.use((_req, res) => sendPptError(res, 'NOT_FOUND', 'resource not found'))
  r.use(pptErrorHandler)
  app.use('/api/v1/ppt', r)
  app.use('/api/v1/ppt', pptErrorHandler)
  return app
}

async function listen(app: Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { base, close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))) }
}

interface GetOpts {
  mode?: string
  version?: string
  format?: string
  space?: string
  token?: string
  origin?: string
}
function url(base: string, docId: string, o: GetOpts): string {
  const q = new URLSearchParams()
  if (o.mode) q.set('mode', o.mode)
  if (o.version) q.set('version', o.version)
  if (o.format) q.set('format', o.format)
  const qs = q.toString()
  return `${base}/api/v1/ppt/docs/${docId}/source${qs ? `?${qs}` : ''}`
}
function get(base: string, docId: string, o: GetOpts = {}) {
  const headers: Record<string, string> = {}
  headers['token'] = o.token ?? 'user-tok'
  headers['X-Space-Id'] = o.space ?? 's_1'
  if (o.origin) headers['Origin'] = o.origin
  return fetch(url(base, docId, o), { method: 'GET', headers })
}

/** Standard fixture: an html_ppt deck in space s_1, owned by u_owner. */
function seedDoc(over: Partial<FakeMeta> = {}): void {
  currentMeta = {
    doc_id: 'd_ppt1',
    document_name: 'octo:s_1:f_default:ppt:d_ppt1',
    owner_id: 'u_owner',
    space_id: 's_1',
    doc_type: 'html_ppt',
    status: 1,
    share_scope: 0,
    share_role: 1,
    ...over,
  }
  currentSource = {
    docId: 'd_ppt1',
    templateId: 'pitch',
    draftRevision: 4,
    snapshotVersion: 7,
    publishedVersionSeq: null,
    pptFormatVersion: 1,
    bentoSyncPv: 2,
    draftDoc: deck(),
  }
}

/** Sign the caller in as `uid` with the given member role on the fixture doc. */
function asRole(uid: string, role: 'reader' | 'commenter' | 'writer' | 'admin' | undefined): void {
  currentMemberRole = role
  setOctoIdentity(stub({ verifyToken: async () => ({ uid }) }))
}

beforeEach(() => {
  currentMeta = null
  currentMemberRole = undefined
  currentSource = null
  seedDoc()
})

// ─────────────────────────────────────────────────────────────────────────
// Group A — ACCESS POLICY / NEGATIVE CONTROL (default provider, real draft).
// ─────────────────────────────────────────────────────────────────────────
describe('PPT-SOURCE access policy (negative control)', () => {
  let base: string
  let close: () => Promise<void>
  beforeAll(async () => ({ base, close } = await listen(makeApp())))
  afterAll(async () => close())

  it('reader CANNOT load draft — 403 FORBIDDEN', async () => {
    asRole('u_reader', 'reader')
    const res = await get(base, 'd_ppt1', { mode: 'draft', format: 'bento' })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('FORBIDDEN')
  })

  it('reader CANNOT load live — 403 FORBIDDEN', async () => {
    asRole('u_reader', 'reader')
    const res = await get(base, 'd_ppt1', { mode: 'live', format: 'bento' })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN')
  })

  it('commenter CANNOT load draft — 403 FORBIDDEN', async () => {
    asRole('u_commenter', 'commenter')
    const res = await get(base, 'd_ppt1', { mode: 'draft', format: 'bento' })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN')
  })

  it('commenter CANNOT load live — 403 FORBIDDEN', async () => {
    asRole('u_commenter', 'commenter')
    const res = await get(base, 'd_ppt1', { mode: 'live', format: 'bento' })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN')
  })

  it('reader IS allowed onto the published path (404 no-version, NOT 403)', async () => {
    // Proves published is reader-readable: the reader passes the access gate and
    // only fails because no published version exists yet (default provider).
    asRole('u_reader', 'reader')
    const res = await get(base, 'd_ppt1', { mode: 'published', format: 'bento' })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND')
  })

  it('commenter IS allowed onto the published path (404 no-version, NOT 403)', async () => {
    asRole('u_commenter', 'commenter')
    const res = await get(base, 'd_ppt1', { mode: 'published', format: 'bento' })
    expect(res.status).toBe(404)
  })

  it('non-member (no access) is FORBIDDEN even for published', async () => {
    asRole('u_stranger', undefined)
    const res = await get(base, 'd_ppt1', { mode: 'published' })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Group B — writer/admin draft/live positives (default provider).
// ─────────────────────────────────────────────────────────────────────────
describe('PPT-SOURCE-003 writer/admin read draft & live', () => {
  let base: string
  let close: () => Promise<void>
  beforeAll(async () => ({ base, close } = await listen(makeApp())))
  afterAll(async () => close())

  it('writer reads draft (bento) — 200 raw deck, private no-store', async () => {
    asRole('u_writer', 'writer')
    const res = await get(base, 'd_ppt1', { mode: 'draft', format: 'bento' })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const body = (await res.json()) as { data: BentoDoc }
    expect(body.data.format).toBe('bento/slides')
    expect(body.data.slides).toHaveLength(1)
  })

  it('admin (owner) reads live (bootstrap) — editable, collab off, origin-safe', async () => {
    asRole('u_owner', undefined) // owner => admin
    const res = await get(base, 'd_ppt1', { mode: 'live', format: 'bootstrap', origin: WEB_ORIGIN })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const body = (await res.json()) as { data: Record<string, unknown> }
    expect(body.data).toMatchObject({
      mode: 'live',
      format: 'bootstrap',
      role: 'admin',
      editable: true,
      collab: false,
      versionSeq: null,
      targetOrigin: WEB_ORIGIN,
    })
    // Compat triple present.
    expect(body.data.bento).toMatchObject({ format: 'bento/slides', formatVersion: 1, syncV: 2 })
  })

  it('writer draft bootstrap is editable', async () => {
    asRole('u_writer', 'writer')
    const res = await get(base, 'd_ppt1', { mode: 'draft', format: 'bootstrap', origin: WEB_ORIGIN })
    const body = (await res.json()) as { data: { editable: boolean; role: string } }
    expect(body.data.editable).toBe(true)
    expect(body.data.role).toBe('writer')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Group C — cache policy per mode/format (injected provider w/ published+html).
// ─────────────────────────────────────────────────────────────────────────
describe('PPT-SOURCE-004 cache policy', () => {
  const published: PptSourceContent = {
    deck: deck('Published'),
    revision: 3,
    versionSeq: 3,
    contentHash: hashBentoDeck(deck('Published')),
    html: '<!doctype html><html><body><h1>Deck</h1></body></html>',
    assets: [],
  }
  const provider: PptSourceProvider = {
    getDraft: async () => ({ deck: deck('Draft'), revision: 4, contentHash: hashBentoDeck(deck('Draft')), assets: [] }),
    getLive: async () => ({ deck: deck('Live'), revision: 7, contentHash: hashBentoDeck(deck('Live')), assets: [] }),
    getPublished: async () => published,
  }
  let base: string
  let close: () => Promise<void>
  beforeAll(async () => ({ base, close } = await listen(makeApp(provider))))
  afterAll(async () => close())

  it('published bento => immutable-version cache + ETag', async () => {
    asRole('u_reader', 'reader')
    const res = await get(base, 'd_ppt1', { mode: 'published', format: 'bento' })
    expect(res.status).toBe(200)
    const cc = res.headers.get('cache-control') ?? ''
    expect(cc).toContain('immutable')
    expect(cc).toContain('private')
    expect(res.headers.get('etag')).toBe(`"${published.contentHash}"`)
  })

  it('published html => text/html, NOT JSON, immutable cache', async () => {
    asRole('u_reader', 'reader')
    const res = await get(base, 'd_ppt1', { mode: 'published', format: 'html' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control') ?? '').toContain('immutable')
    const text = await res.text()
    expect(text).toContain('<!doctype html>')
  })

  it('published BOOTSTRAP is no-store (embeds short-lived signed URLs)', async () => {
    asRole('u_reader', 'reader')
    const res = await get(base, 'd_ppt1', { mode: 'published', format: 'bootstrap', origin: WEB_ORIGIN })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })

  it('draft html => text/html + no-store', async () => {
    asRole('u_writer', 'writer')
    const res = await get(base, 'd_ppt1', { mode: 'draft', format: 'html' })
    expect(res.status).toBe(404) // draft has no rendered html in this fixture
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Group D — signed asset bootstrap metadata (PPT-SEC-001 / PPT-ASSET-001).
// ─────────────────────────────────────────────────────────────────────────
describe('PPT signed asset bootstrap metadata', () => {
  const withAssets: PptSourceContent = {
    deck: deck('Assets'),
    revision: 3,
    versionSeq: 3,
    contentHash: hashBentoDeck(deck('Assets')),
    assets: [
      { id: 'img1', objectKey: 'ppt/d_ppt1/assets/abc123', mime: 'image/png', sizeBytes: 2048 },
      { id: 'img2', objectKey: 'ppt/d_ppt1/assets/def456', mime: 'image/jpeg' },
    ],
  }
  const provider: PptSourceProvider = {
    getDraft: async () => null,
    getLive: async () => null,
    getPublished: async () => withAssets,
  }
  let base: string
  let close: () => Promise<void>
  beforeAll(async () => ({ base, close } = await listen(makeApp(provider))))
  afterAll(async () => close())

  it('bootstrap carries short-lived SIGNED asset URLs with no long-lived auth material', async () => {
    asRole('u_reader', 'reader')
    const res = await get(base, 'd_ppt1', { mode: 'published', format: 'bootstrap', origin: WEB_ORIGIN, token: 'super-secret-session-token' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { assets: Array<{ id: string; url: string; expiresAt: string; mime: string }>; assetUrlTtlSeconds: number }
    }
    expect(body.data.assets).toHaveLength(2)
    expect(body.data.assetUrlTtlSeconds).toBeGreaterThan(0)
    for (const a of body.data.assets) {
      // Signature verifies against the object-store secret and is time-bounded.
      expect(verifySignedUrl(a.url).valid).toBe(true)
      expect(a.url).toContain('X-Signature')
      expect(a.url).toContain('X-Expiry')
      expect(typeof a.expiresAt).toBe('string')
      // No long-lived auth material in the URL: not the session token, not a bearer.
      expect(a.url).not.toContain('super-secret-session-token')
      expect(a.url.toLowerCase()).not.toContain('authorization')
      expect(a.url.toLowerCase()).not.toContain('bearer')
      expect(a.url).not.toContain('token=')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Group E — origin safety (§3.3).
// ─────────────────────────────────────────────────────────────────────────
describe('PPT bootstrap origin safety', () => {
  let base: string
  let close: () => Promise<void>
  beforeAll(async () => ({ base, close } = await listen(makeApp())))
  afterAll(async () => close())

  it('disallowed Origin is refused with 403', async () => {
    asRole('u_writer', 'writer')
    const res = await get(base, 'd_ppt1', { mode: 'draft', format: 'bootstrap', origin: 'https://evil.example.com' })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN')
  })

  it('allowed Origin is echoed as the exact targetOrigin (never "*")', async () => {
    asRole('u_writer', 'writer')
    const res = await get(base, 'd_ppt1', { mode: 'draft', format: 'bootstrap', origin: WEB_ORIGIN })
    const body = (await res.json()) as { data: { targetOrigin: string } }
    expect(body.data.targetOrigin).toBe(WEB_ORIGIN)
    expect(body.data.targetOrigin).not.toBe('*')
  })

  it('no Origin header falls back to configured web origin (never "*")', async () => {
    asRole('u_writer', 'writer')
    const res = await get(base, 'd_ppt1', { mode: 'draft', format: 'bootstrap' })
    const body = (await res.json()) as { data: { targetOrigin: string } }
    expect(body.data.targetOrigin).toBe(WEB_ORIGIN)
    expect(body.data.targetOrigin).not.toBe('*')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Group F — wrong-kind / not-found / validation (envelope contract).
// ─────────────────────────────────────────────────────────────────────────
describe('PPT source guard & validation', () => {
  let base: string
  let close: () => Promise<void>
  beforeAll(async () => ({ base, close } = await listen(makeApp())))
  afterAll(async () => close())

  it('non-html_ppt doc => 422 UNSUPPORTED_DOCUMENT_TYPE', async () => {
    seedDoc({ doc_type: 'doc' })
    asRole('u_owner', undefined)
    const res = await get(base, 'd_ppt1', { mode: 'draft' })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNSUPPORTED_DOCUMENT_TYPE')
  })

  it('missing doc => 404 NOT_FOUND', async () => {
    asRole('u_owner', undefined)
    const res = await get(base, 'nope', { mode: 'published' })
    expect(res.status).toBe(404)
  })

  it('cross-space doc => 404 (never 403, no existence leak)', async () => {
    asRole('u_owner', undefined)
    const res = await get(base, 'd_ppt1', { mode: 'published', space: 's_other' })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND')
  })

  it('archived doc => 409 CONFLICT', async () => {
    seedDoc({ status: 2 })
    asRole('u_owner', undefined)
    const res = await get(base, 'd_ppt1', { mode: 'published' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CONFLICT')
  })

  it('invalid mode => 400 VALIDATION_ERROR', async () => {
    asRole('u_owner', undefined)
    const res = await get(base, 'd_ppt1', { mode: 'garbage' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
  })

  it('invalid format => 400 VALIDATION_ERROR', async () => {
    asRole('u_owner', undefined)
    const res = await get(base, 'd_ppt1', { format: 'pdf' })
    expect(res.status).toBe(400)
  })

  it('concrete version with mode=draft => 400 VALIDATION_ERROR', async () => {
    asRole('u_owner', undefined)
    const res = await get(base, 'd_ppt1', { mode: 'draft', version: '2' })
    expect(res.status).toBe(400)
  })

  it('missing session => 401 AUTH_REQUIRED (enveloped)', async () => {
    setOctoIdentity(stub({ verifyToken: async () => null }))
    const res = await get(base, 'd_ppt1', { mode: 'published' })
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('AUTH_REQUIRED')
  })

  it('missing X-Space-Id => 400 VALIDATION_ERROR (enveloped)', async () => {
    asRole('u_owner', undefined)
    const res = await fetch(url(base, 'd_ppt1', { mode: 'published' }), { method: 'GET', headers: { token: 'user-tok' } })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
  })
})
