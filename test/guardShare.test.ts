import { describe, it, expect, vi, beforeEach } from 'vitest'

// Integration-ish unit test for the REST enforcement seam (#64, design §5.2):
// requireDocRole is exercised for real against a mocked doc_meta row + a mocked
// doc_member role, with a stubbable isSpaceMember injected through the octo
// identity seam. Covers the cross-space 404 ordering, restricted no-change rows,
// the anyone_in_space rows (incl. fail-closed lookup), the bot req.spaceId shortcut,
// and the doc_member-not-space-member ALLOW (§5.4).
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { getByDocId: vi.fn() },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: { getRole: vi.fn() },
}))

import { requireDocRole } from '../src/api/guard.js'
import type { DocSpaceScope } from '../src/api/middleware/docSpaceScope.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { setOctoIdentity } from '../src/auth/octoIdentity.js'
import type { Role, ResolvedRole } from '../src/permission/role.js'

interface MockRes {
  statusCode: number
  body: unknown
  status(c: number): MockRes
  json(b: unknown): MockRes
}
function mockRes(): MockRes {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c
      return this
    },
    json(b: unknown) {
      this.body = b
      return this
    },
  }
}

const DOC = 'd_1'
const SPACE = 's1'

const meta = (over: Record<string, unknown> = {}) => ({
  doc_id: DOC,
  document_name: 'octo:s1:f_default:d_1',
  owner_id: 'u_owner',
  space_id: SPACE,
  folder_id: 'f_default',
  doc_type: 'doc',
  status: 1,
  permission_epoch: 1,
  share_scope: 0,
  share_role: 1,
  ...over,
})

/** Inject an identity whose isSpaceMember returns the given value (or throws). */
function memberFn(fn: (uid: string, spaceId: string) => Promise<boolean>) {
  setOctoIdentity({ isSpaceMember: fn } as never)
}

/** Track how many times isSpaceMember is actually hit (to prove the lazy path). */
let calls: number
function memberReturns(v: boolean) {
  calls = 0
  memberFn(async () => {
    calls += 1
    return v
  })
}

async function run(opts: {
  uid: string
  minRole: Role
  metaOver?: Record<string, unknown>
  directRole?: ResolvedRole
  // Per-mount policy (remove-sp §6). Defaults to the Human open-context mount
  // (locate by docId, no cross-space gate); Bot tests pass an explicit bot scope.
  scope?: DocSpaceScope
  octoToken?: string
}) {
  vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta(opts.metaOver) as never)
  const dr = opts.directRole ?? 'none'
  vi.mocked(docMemberRepo.getRole).mockResolvedValue((dr === 'none' ? null : dr) as never)
  const res = mockRes()
  const req = {
    uid: opts.uid,
    octoToken: opts.octoToken,
    docSpaceScope: opts.scope ?? { mode: 'human' as const },
  }
  const guard = await requireDocRole(req as never, res as never, DOC, opts.minRole)
  return { res, guard }
}

beforeEach(() => {
  vi.mocked(docMetaRepo.getByDocId).mockReset()
  vi.mocked(docMemberRepo.getRole).mockReset()
  memberReturns(false)
})

describe('requireDocRole — cross-space (§5.2.a, BOT mount only, before any share logic)', () => {
  it('C2: Bot mount + anyone_in_space + cross-space => 404, never reaches membership', async () => {
    // remove-sp §6: the cross-space 404 gate now applies ONLY to the Bot mount
    // (server-resolved Space). A verified bot in s_other hitting a doc in s1 must
    // still 404 BEFORE any role/membership logic. (The Human mount deliberately
    // has NO such gate — see the Human describe below.)
    const { res, guard } = await run({
      uid: 'u_x',
      minRole: 'reader',
      metaOver: { share_scope: 1, share_role: 2 },
      scope: { mode: 'bot', spaceId: 's_other' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
    expect(guard).toBeNull()
    expect(calls).toBe(0)
  })

  it('C2b: Human mount + cross-space direct member resolves (NO 404 gate)', async () => {
    // The whole point of remove-sp: a Human locates by docId alone, so a doc in
    // ANOTHER space than any (now absent/wrong) header resolves on the caller's
    // real role — here a direct writer — without a cross-space 404.
    const { res, guard } = await run({
      uid: 'u_w',
      minRole: 'reader',
      metaOver: { space_id: 's_other' },
      directRole: 'writer',
    })
    expect(res.statusCode).toBe(0)
    expect(guard?.role).toBe('writer')
    expect(guard?.meta.space_id).toBe('s_other')
  })
})

describe('requireDocRole — restricted docs (§5.2.b, no behavior change)', () => {
  it('R3: in-space, no doc_member => 403 and membership NEVER consulted', async () => {
    const { res, guard } = await run({ uid: 'u_x', minRole: 'reader', directRole: 'none' })
    expect(res.statusCode).toBe(403)
    expect(guard).toBeNull()
    expect(calls).toBe(0) // restricted short-circuits the share path entirely
  })
  it('R2: doc_member reader can read but not write', async () => {
    const ok = await run({ uid: 'u_r', minRole: 'reader', directRole: 'reader' })
    expect(ok.guard?.role).toBe('reader')
    const deny = await run({ uid: 'u_r', minRole: 'writer', directRole: 'reader' })
    expect(deny.res.statusCode).toBe(403)
    expect(calls).toBe(0)
  })
})

describe('requireDocRole — anyone_in_space (§5.2.c)', () => {
  const A = { share_scope: 1, share_role: 2 } // anyone / edit

  it('A5/A6: in-space member, no doc_member, edit-share => writer allowed', async () => {
    memberReturns(true)
    const { res, guard } = await run({ uid: 'u_m', minRole: 'writer', metaOver: A, directRole: 'none' })
    expect(res.statusCode).toBe(0)
    expect(guard?.role).toBe('writer')
    expect(calls).toBe(1) // lazily consulted exactly once
  })

  it('A4: read-share member gets reader, not writer', async () => {
    memberReturns(true)
    const read = await run({ uid: 'u_m', minRole: 'reader', metaOver: { share_scope: 1, share_role: 1 } })
    expect(read.guard?.role).toBe('reader')
    const write = await run({ uid: 'u_m', minRole: 'writer', metaOver: { share_scope: 1, share_role: 1 } })
    expect(write.res.statusCode).toBe(403)
  })

  it('A1: non-member (human) => 403', async () => {
    memberReturns(false)
    const { res } = await run({ uid: 'u_x', minRole: 'reader', metaOver: A })
    expect(res.statusCode).toBe(403)
  })

  it('A3: membership lookup THROWS => fail-closed 403 (isSpaceMember swallows to false in prod; guard must not open)', async () => {
    // The Http impl fails closed to false; here we assert the guard denies when
    // the identity reports non-member (the lookup-failure surface).
    memberReturns(false)
    const { res, guard } = await run({ uid: 'u_x', minRole: 'reader', metaOver: A })
    expect(res.statusCode).toBe(403)
    expect(guard).toBeNull()
  })

  it('A8: owner is admin without any membership call (direct role already suffices)', async () => {
    memberReturns(true)
    const { guard } = await run({ uid: 'u_owner', minRole: 'reader', metaOver: A })
    expect(guard?.role).toBe('admin')
    expect(calls).toBe(0) // lazy: direct role already >= minRole
  })
})

describe('requireDocRole — bot shortcut (§4.3) & §5.4 doc_member-not-member', () => {
  it('bot in the doc space gets share-derived writer WITHOUT an octo-server call', async () => {
    // isSpaceMember would throw if called — proves the bot path never calls it.
    memberFn(async () => {
      throw new Error('isSpaceMember must not be called for a verified bot')
    })
    const { res, guard } = await run({
      uid: 'bot_1',
      minRole: 'writer',
      metaOver: { share_scope: 1, share_role: 2 },
      directRole: 'none',
      scope: { mode: 'bot', spaceId: SPACE },
    })
    expect(res.statusCode).toBe(0)
    expect(guard?.role).toBe('writer')
  })

  it('D2: writer doc_member who is NOT a space member still edits (max keeps direct role)', async () => {
    memberReturns(false)
    const { guard } = await run({
      uid: 'u_w',
      minRole: 'writer',
      metaOver: { share_scope: 1, share_role: 1 },
      directRole: 'writer',
    })
    expect(guard?.role).toBe('writer')
    // direct role already satisfied minRole => membership not even consulted.
    expect(calls).toBe(0)
  })
})
