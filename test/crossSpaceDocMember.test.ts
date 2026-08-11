import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// Cross-space doc_member regression (the P1 that split spaceContextMiddleware).
//
// A doc_member grant is INDEPENDENT of space membership by design: members.ts and
// forwardGrant.ts verify only that the grantee is a real octo user (anti
// ghost-member); neither consults isSpaceMember, and the invite-accept path never
// mentions a space. docShareLink.ts then mints /d/<docId>?sp=<the doc's OWN space>
// precisely so such a grantee's GET /docs/{docId} preflight addresses the doc's
// home space. And the contract pins this (docs/contract/backend-design.md:1514):
// space is a SUPPLEMENTAL permission source that "不改变直接的 owner/doc_member
// 授权, effectiveRole=max(直接角色, 分享派生角色) 只加不减".
//
// A mount-wide membership gate SUBTRACTS: it 404s that legitimate grantee on every
// /:docId route. It also does so asymmetrically — collabTokenRouter and
// acceptInviteRouter are mounted ahead of authMiddleware (app.ts) and bypass the
// chain — so the same user could open the collab editor over websocket while every
// REST call returned 404, and invite acceptance would succeed onto a doc that then
// "does not exist".
//
// So this file locks BOTH directions at route level, through the real createApp():
//   - a cross-space doc_member reading an existing doc            -> 200
//   - the same non-member LISTING (row predicate is the authority) -> 200,
//     with isSpaceMember=false still pushed down so nothing widens
//   - the same non-member CREATING into that space                 -> 404
// The two together are the whole point of the split: the gate belongs where the
// space is the only selector, and nowhere else.
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  DocOwnershipError: class DocOwnershipError extends Error {},
  docMetaRepo: {
    getByDocId: vi.fn(),
    create: vi.fn(async () => undefined),
    listForUser: vi.fn(async () => ({ total: 0, items: [] })),
  },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: {
    getRole: vi.fn(),
    upsertDirect: vi.fn(async () => undefined),
  },
}))
vi.mock('../src/permission/epoch.js', () => ({
  bumpEpoch: vi.fn(async () => 1),
  refreshAndPublish: vi.fn(async () => undefined),
}))
vi.mock('../src/db/repos/docAccessRequestRepo.js', () => ({
  docAccessRequestRepo: {
    submit: vi.fn(async () => ({ requestId: 'r_1', created: true })),
  },
}))
vi.mock('../src/api/services/docsNotify.js', () => ({
  notifyDocAccessRequested: vi.fn(async () => undefined),
  notifyDocMentioned: vi.fn(async () => undefined),
}))

import { createApp } from '../src/api/app.js'
import { setOctoIdentity, type OctoIdentity, type OctoUser } from '../src/auth/octoIdentity.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { docAccessRequestRepo } from '../src/db/repos/docAccessRequestRepo.js'

const getByDocId = vi.mocked(docMetaRepo.getByDocId)
const getRole = vi.mocked(docMemberRepo.getRole)

/** d_1 lives in s_home and is NOT space-shared (share_scope = restricted). */
const DOC_IN_S_HOME = {
  doc_id: 'd_1',
  document_name: 'octo:s_home:f_default:doc:d_1',
  title: 'Shared With An Outsider',
  owner_id: 'u_owner',
  space_id: 's_home',
  folder_id: 'f_default',
  doc_type: 'doc',
  octo_doc_slug: null,
  status: 1,
  share_scope: 0,
  share_role: 1,
  permission_epoch: 0,
  created_at: new Date(0),
  updated_at: new Date(0),
  created_by: 'u_owner',
  updated_by: 'u_owner',
}

/**
 * u_ext: a real octo user holding doc_member reader on d_1, who is a member of NO
 * space — in particular not s_home. isSpaceMember is hard false for every space,
 * so any membership-derived widening is off and the only authority in play is the
 * direct doc_member grant.
 */
function outsiderIdentity(): OctoIdentity {
  return {
    verifyToken: async () => ({ uid: 'u_ext' }) as never,
    verifyBot: async () => null,
    getUser: async (): Promise<OctoUser | null> => null,
    getUserAsBot: async (): Promise<OctoUser | null> => null,
    getUsers: async (): Promise<OctoUser[]> => [],
    isSpaceMember: async () => false,
  }
}

let server: Server
let base: string

beforeAll(async () => {
  const app = createApp()
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
})

beforeEach(() => {
  vi.clearAllMocks()
  getByDocId.mockResolvedValue(DOC_IN_S_HOME as never)
  getRole.mockResolvedValue('reader' as never)
  setOctoIdentity(outsiderIdentity())
})

describe('a cross-space doc_member keeps their grant (only-adds contract)', () => {
  it('GET /api/v1/docs/:docId returns 200 for a doc_member who is not a space member', async () => {
    const res = await fetch(`${base}/api/v1/docs/d_1`, {
      // The space the backend's own share link tells the client to send:
      // /d/d_1?sp=s_home — the doc's home space, not the caller's.
      headers: { authorization: 'Bearer tok_u_ext', 'X-Space-Id': 's_home' },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { docId: string; role: string; spaceId: string }
    expect(body).toMatchObject({ docId: 'd_1', spaceId: 's_home', role: 'reader' })
  })

  it('ignores a forged Space header: docId and the direct grant remain authoritative', async () => {
    // remove-sp makes X-Space-Id optional viewer context on single-document
    // routes, never a selector or authorization input. A forged value therefore
    // cannot widen or narrow the real doc_member grant resolved from uid + docId.
    const res = await fetch(`${base}/api/v1/docs/d_1`, {
      headers: { authorization: 'Bearer tok_u_ext', 'X-Space-Id': 's_not_the_docs_space' },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ docId: 'd_1', spaceId: 's_home', role: 'reader' })
  })

  it('403 (not 404) when the same caller holds no grant at all — doc-level denial survives', async () => {
    getRole.mockResolvedValue(null as never)

    const res = await fetch(`${base}/api/v1/docs/d_1`, {
      headers: { authorization: 'Bearer tok_u_ext', 'X-Space-Id': 's_home' },
    })

    // The doc exists in the addressed space, so existence-hiding does not apply;
    // the refusal must come from the role check, not from a space-level gate.
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden' })
  })
})

describe('the gate survives only on create, where no doc exists to authorize against', () => {
  it('POST /api/v1/docs 404s a non-member — no doc exists yet, so this is the only check', async () => {
    const res = await fetch(`${base}/api/v1/docs`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer tok_u_ext',
        'content-type': 'application/json',
        'X-Space-Id': 's_home',
      },
      body: JSON.stringify({ title: 'Planted' }),
    })

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
    // The row must never be minted — refusing after the write would leave the
    // planted doc behind.
    expect(vi.mocked(docMetaRepo.create)).not.toHaveBeenCalled()
  })

  it('GET /api/v1/docs (list) does NOT 404 the non-member — the row predicate is the authority', async () => {
    // The gate was taken OFF the four collection reads in review: they are not
    // authorized by space membership at all. listForUser pushes down
    // `owner OR doc_member` and only ADDS the anyone_in_space branch when
    // isSpaceMember is true, so a non-member naming s_home already sees nothing
    // of s_home. Gating the route would instead 404 this very user out of listing
    // the doc they legitimately hold a grant on — a subtraction.
    const listForUser = vi.mocked(docMetaRepo.listForUser)
    listForUser.mockResolvedValue({
      total: 1,
      items: [{ ...DOC_IN_S_HOME, role: 1 }],
    } as never)

    const res = await fetch(`${base}/api/v1/docs`, {
      headers: { authorization: 'Bearer tok_u_ext', 'X-Space-Id': 's_home' },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ total: 1, items: [{ docId: 'd_1', role: 'reader' }] })
    // ...and taking the gate off must not widen anything: the caller is still a
    // non-member, so the space-share branch stays OFF in the pushed-down predicate.
    expect(listForUser).toHaveBeenCalledWith(
      expect.objectContaining({ uid: 'u_ext', spaceId: 's_home', isSpaceMember: false }),
    )
  })

})

describe('access-request submit stays open to outsiders (#511 screen 4c)', () => {
  it('POST /api/v1/docs/:docId/access-requests stays OPEN to a non-member — #511 screen 4c', async () => {
    // The persona this route exists for is an OUTSIDER holding no grant at all,
    // not the doc_member above: octo-web's forbidden landing
    // (StandaloneDocPage.tsx, `phase.kind === 'forbidden'`) renders
    // RequestAccessButton with spaceId = standaloneLinkSpace(), i.e. the `?sp=`
    // value from the doc's own space. So this asserts the WHOLE two-step flow the
    // user actually performs, in order — an earlier version of this test used a
    // doc_member fixture, a persona who never sees the button, and so asserted a
    // 404 that looked correct while the real flow was dead.
    getRole.mockResolvedValue(null as never)

    const preflight = await fetch(`${base}/api/v1/docs/d_1`, {
      headers: { authorization: 'Bearer tok_u_ext', 'X-Space-Id': 's_home' },
    })
    // Step 1: 403 is what makes the "Request access" button render at all.
    expect(preflight.status).toBe(403)

    const submit = await fetch(`${base}/api/v1/docs/d_1/access-requests`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer tok_u_ext',
        'content-type': 'application/json',
        'X-Space-Id': 's_home',
      },
      body: JSON.stringify({ requestedRole: 'reader' }),
    })

    // Step 2: clicking it must reach the handler. A membership gate here would
    // 404 — button shown, button broken.
    expect(submit.status).toBe(201)
    expect(await submit.json()).toEqual({ requestId: 'r_1', status: 'pending' })
  })

  it('ignores a forged Space header and pins the request to the path docId', async () => {
    getRole.mockResolvedValue(null as never)

    const res = await fetch(`${base}/api/v1/docs/d_1/access-requests`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer tok_u_ext',
        'content-type': 'application/json',
        'X-Space-Id': 's_not_the_docs_space',
      },
      body: JSON.stringify({ requestedRole: 'reader' }),
    })

    // The client header cannot redirect the write: submit receives only d_1 from
    // the path, while the backend independently resolves d_1's home Space.
    expect(res.status).toBe(201)
    expect(vi.mocked(docAccessRequestRepo.submit)).toHaveBeenCalledWith(
      expect.objectContaining({ docId: 'd_1', uid: 'u_ext' }),
    )
  })
})
