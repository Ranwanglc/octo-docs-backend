// Env seeding MUST be first so config/env.ts reads it at load time.
import './helpers/pptRelayEnv.js'

import { describe, it, expect, beforeEach } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import express, { Router, json, type Express } from 'express'
import { vi } from 'vitest'

/**
 * R4-B1 integration tests for `POST /api/v1/ppt/docs/collab-token` (§7.1).
 *
 * The real collab-token router + auth/space guards + enveloped error handler
 * run; only the doc/role/state repos and the octo identity are controlled.
 * Drives PPT-TOKEN-001 (issuance + response contents/epoch; legacy Hocuspocus
 * token is NOT issued for html_ppt) and PPT-TOKEN-002 (403/403/404/422).
 */

interface FakeMeta {
  doc_id: string
  document_name: string
  owner_id: string
  space_id: string
  folder_id: string
  doc_type: string
  status: number
  permission_epoch: number
  share_scope: number
  share_role: number
  [k: string]: unknown
}
let currentMeta: FakeMeta | null = null
let currentMemberRole: 'reader' | 'commenter' | 'writer' | 'admin' | undefined

vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  DocOwnershipError: class DocOwnershipError extends Error {},
  docMetaRepo: {
    getByDocId: vi.fn(async (docId: string) => (currentMeta && currentMeta.doc_id === docId ? currentMeta : null)),
    getByDocumentName: vi.fn(async (name: string) =>
      currentMeta && currentMeta.document_name === name ? currentMeta : null,
    ),
  },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: { getRole: vi.fn(async () => currentMemberRole) },
}))
let currentState: { docId: string; snapshotVersion: number } | null = null
vi.mock('../src/db/repos/pptDocStateRepo.js', () => ({
  pptDocStateRepo: {
    getByDocId: vi.fn(async (docId: string) =>
      currentState && currentState.docId === docId
        ? { docId, templateId: 'pitch', draftRevision: 0, snapshotVersion: currentState.snapshotVersion, publishedVersionSeq: null, pptFormatVersion: 1, bentoSyncPv: 2 }
        : null,
    ),
  },
}))
// B8: the issued snapshotVersion is now sourced from the authoritative live
// snapshot (ppt_live_snapshot), not ppt_doc_state.snapshot_version (which nothing
// on the live path advances). Mock it to mirror `currentState`.
vi.mock('../src/db/repos/pptLiveSnapshotRepo.js', () => ({
  pptLiveSnapshotRepo: {
    get: vi.fn(async (docId: string) =>
      currentState && currentState.docId === docId
        ? { snapshotVersion: currentState.snapshotVersion, coveredSeq: 0, doc: {} }
        : null,
    ),
  },
}))
// docViewHistoryRepo is touched by the legacy issueCollabToken fallback ingest.
vi.mock('../src/db/repos/docViewHistoryRepo.js', () => ({
  docViewHistoryRepo: { upsertViewWithPrune: vi.fn(async () => undefined) },
}))

import { createPptCollabTokenRouter } from '../src/api/ppt/collabToken.js'
import { pptErrorHandler, sendPptError } from '../src/api/ppt/envelope.js'
import { setOctoIdentity, type OctoIdentity, type OctoUser } from '../src/auth/octoIdentity.js'
import { verifyPptRelayToken, verifyPptRelayTicket } from '../src/auth/pptCollabToken.js'
import { issueCollabToken } from '../src/auth/issueCollabToken.js'

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

function makeApp(): Express {
  const app = express()
  const r = Router()
  r.use(json({ limit: '1mb' }))
  r.use(createPptCollabTokenRouter())
  r.use((_req, res) => sendPptError(res, 'NOT_FOUND', 'resource not found'))
  r.use(pptErrorHandler)
  app.use('/api/v1/ppt', r)
  return app
}

async function listen(app: Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { base, close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))) }
}

function post(base: string, body: unknown, opts: { token?: string; space?: string } = {}) {
  return fetch(`${base}/api/v1/ppt/docs/collab-token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      token: opts.token ?? 'user-tok',
      'X-Space-Id': opts.space ?? 's_1',
    },
    body: JSON.stringify(body),
  })
}

function seedDoc(over: Partial<FakeMeta> = {}): void {
  currentMeta = {
    doc_id: 'd_ppt1',
    document_name: 'octo:s_1:f_default:ppt:d_ppt1',
    owner_id: 'u_owner',
    space_id: 's_1',
    folder_id: 'f_default',
    doc_type: 'html_ppt',
    status: 1,
    permission_epoch: 5,
    share_scope: 0,
    share_role: 1,
    ...over,
  }
  currentState = { docId: 'd_ppt1', snapshotVersion: 7 }
}

beforeEach(() => {
  currentMeta = null
  currentMemberRole = undefined
  currentState = null
  // Default identity: the writer 'u_writer' with a resolvable display name.
  setOctoIdentity(
    stub({
      verifyToken: async (t: string) => (t ? { uid: 'u_writer' } : null),
      getUser: async (uid: string) => ({ uid, name: 'Ada Writer', avatar: '' }),
      isSpaceMember: async () => false,
    }),
  )
})

describe('POST /api/v1/ppt/docs/collab-token (§7.1)', () => {
  it('PPT-TOKEN-001: issues token/ticket with role/epoch/pptWsUrl/documentName/snapshotVersion/name', async () => {
    seedDoc()
    currentMemberRole = 'writer'
    const { base, close } = await listen(makeApp())
    try {
      const res = await post(base, { docId: 'd_ppt1' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: Record<string, unknown> }
      const d = body.data
      expect(typeof d.token).toBe('string')
      expect(typeof d.ticket).toBe('string')
      expect(typeof d.expiresAt).toBe('string')
      expect(d.role).toBe('writer')
      expect(d.epoch).toBe(5)
      expect(d.pptWsUrl).toBe('ws://ppt-relay.example.test')
      expect(d.documentName).toBe('octo:s_1:f_default:ppt:d_ppt1')
      expect(d.snapshotVersion).toBe(7)
      expect(d.name).toBe('Ada Writer')

      // The minted credentials are verifiable and carry the resolved authority.
      const tok = verifyPptRelayToken(d.token as string)
      expect(tok.uid).toBe('u_writer')
      expect(tok.role).toBe('writer')
      expect(tok.permission_epoch).toBe(5)
      const tik = verifyPptRelayTicket(d.ticket as string)
      expect(tik.docId).toBe('d_ppt1')
      expect(tik.jti.length).toBeGreaterThan(0)

      // Half A issues no server-minted actor and no per-actor `s` hint (that op-metadata
      // trust boundary moved to Half B): the response carries neither field.
      expect(d.actor).toBeUndefined()
      expect(d.nextS).toBeUndefined()
    } finally {
      await close()
    }
  })

  it('PPT-TOKEN-001: an owner gets admin authority', async () => {
    seedDoc({ owner_id: 'u_writer' })
    const { base, close } = await listen(makeApp())
    try {
      const res = await post(base, { docId: 'd_ppt1' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: { role: string } }
      expect(body.data.role).toBe('admin')
    } finally {
      await close()
    }
  })

  it('PPT-TOKEN-001: legacy Hocuspocus collab-token is NOT issued for html_ppt (422)', async () => {
    seedDoc()
    const r = await issueCollabToken('user-tok', 'octo:s_1:f_default:ppt:d_ppt1', 's_1')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(422)
      expect(r.error).toBe('unsupported_document_type')
    }
  })

  describe('PPT-TOKEN-002: rejection statuses', () => {
    it('no-role user → 403 FORBIDDEN', async () => {
      seedDoc() // caller u_writer is neither owner nor member
      currentMemberRole = undefined
      const { base, close } = await listen(makeApp())
      try {
        const res = await post(base, { docId: 'd_ppt1' })
        expect(res.status).toBe(403)
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN')
      } finally {
        await close()
      }
    })

    it('deleted doc → 404 NOT_FOUND', async () => {
      seedDoc({ status: 0 })
      currentMemberRole = 'writer'
      const { base, close } = await listen(makeApp())
      try {
        const res = await post(base, { docId: 'd_ppt1' })
        expect(res.status).toBe(404)
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND')
      } finally {
        await close()
      }
    })

    it('cross-space doc → 404 NOT_FOUND (existence never leaks)', async () => {
      seedDoc({ space_id: 's_other' })
      currentMemberRole = 'writer'
      const { base, close } = await listen(makeApp())
      try {
        const res = await post(base, { docId: 'd_ppt1' }, { space: 's_1' })
        expect(res.status).toBe(404)
      } finally {
        await close()
      }
    })

    it('non-html_ppt doc → 422 UNSUPPORTED_DOCUMENT_TYPE', async () => {
      seedDoc({ doc_type: 'doc', document_name: 'octo:s_1:f_default:d_ppt1' })
      currentMemberRole = 'writer'
      const { base, close } = await listen(makeApp())
      try {
        const res = await post(base, { docId: 'd_ppt1' })
        expect(res.status).toBe(422)
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNSUPPORTED_DOCUMENT_TYPE')
      } finally {
        await close()
      }
    })

    it('malformed stored document_name → 403 FORBIDDEN', async () => {
      seedDoc({ document_name: 'totally-not-a-valid-name' })
      currentMemberRole = 'writer'
      const { base, close } = await listen(makeApp())
      try {
        const res = await post(base, { docId: 'd_ppt1' })
        expect(res.status).toBe(403)
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN')
      } finally {
        await close()
      }
    })

    it('access floor precedes stored-name validation: no-role caller on a malformed-name deck → 403 "no access to this document"', async () => {
      // The stored document_name is ALSO malformed, but the caller has no role
      // (neither owner nor member). The access-floor check must win, so the
      // response must be the access message — never the stored-name defect.
      seedDoc({ document_name: 'totally-not-a-valid-name' })
      currentMemberRole = undefined
      const { base, close } = await listen(makeApp())
      try {
        const res = await post(base, { docId: 'd_ppt1' })
        expect(res.status).toBe(403)
        const err = ((await res.json()) as { error: { code: string; message: string } }).error
        expect(err.code).toBe('FORBIDDEN')
        expect(err.message).toBe('no access to this document')
      } finally {
        await close()
      }
    })

    it('missing docId → 400 VALIDATION_ERROR', async () => {
      const { base, close } = await listen(makeApp())
      try {
        const res = await post(base, {})
        expect(res.status).toBe(400)
      } finally {
        await close()
      }
    })

    it('unauthenticated → 401 AUTH_REQUIRED', async () => {
      setOctoIdentity(stub({ verifyToken: async () => null }))
      seedDoc()
      const { base, close } = await listen(makeApp())
      try {
        const res = await post(base, { docId: 'd_ppt1' }, { token: '' })
        expect(res.status).toBe(401)
      } finally {
        await close()
      }
    })
  })
})
