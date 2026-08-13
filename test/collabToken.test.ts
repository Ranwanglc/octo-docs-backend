import { describe, it, expect, afterEach } from 'vitest'
import jwt from 'jsonwebtoken'
import { signCollabToken, signCollabTokenV2, verifyCollabToken } from '../src/auth/collabToken.js'
import { config } from '../src/config/env.js'

// NOTE: config (incl. COLLAB_TOKEN_SECRET) is captured at module import time,
// so sign and verify always use the same secret here. These tests assert the
// claim contract and signature integrity rather than secret rotation.

describe('collab token sign/verify (§4.4)', () => {
  it('signs a token carrying the exact claim set and verifies it back', () => {
    const { token, role, expiresAt, permission_epoch } = signCollabToken({
      uid: 'u_12345',
      documentName: 'octo:s_001:f_888:d_abc123',
      role: 'writer',
      permission_epoch: 7,
    })
    expect(typeof token).toBe('string')
    expect(role).toBe('writer')
    // The response now surfaces the real epoch alongside the signed claim, so
    // clients no longer have to default to 0 (XIN-210/211).
    expect(permission_epoch).toBe(7)
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now())

    const claims = verifyCollabToken(token)
    expect(claims).toEqual({
      uid: 'u_12345',
      documentName: 'octo:s_001:f_888:d_abc123',
      role: 'writer',
      permission_epoch: 7,
    })
  })

  it('rejects a tampered token (signature mismatch)', () => {
    const { token } = signCollabToken({
      uid: 'u_1',
      documentName: 'octo:s:f:d',
      role: 'reader',
      permission_epoch: 0,
    })
    const tampered = token.slice(0, -2) + (token.endsWith('a') ? 'bb' : 'aa')
    expect(() => verifyCollabToken(tampered)).toThrow()
  })

  it('rejects a structurally invalid token', () => {
    expect(() => verifyCollabToken('not-a-jwt')).toThrow()
  })

  it('rejects PPT relay audience and PPT document names on the legacy verifier', () => {
    const pptAud = jwt.sign(
      {
        uid: 'u_1',
        documentName: 'octo:s:f:ppt:d_ppt',
        role: 'admin',
        permission_epoch: 0,
        kind: 'html_ppt',
      },
      config.collabToken.secret,
      { algorithm: 'HS256', audience: 'ppt-relay' },
    )
    expect(() => verifyCollabToken(pptAud)).toThrow(/audience|ppt/i)

    const noAudPptDoc = jwt.sign(
      {
        uid: 'u_1',
        documentName: 'octo:s:f:ppt:d_ppt',
        role: 'writer',
        permission_epoch: 0,
      },
      config.collabToken.secret,
      { algorithm: 'HS256' },
    )
    expect(() => verifyCollabToken(noAudPptDoc)).toThrow(/ppt/i)
  })

  it('round-trips a commenter claim', () => {
    const result = signCollabToken({
      uid: 'u_commenter', documentName: 'octo:s:f:d', role: 'commenter', permission_epoch: 4,
    })
    expect(result.role).toBe('commenter')
    expect(verifyCollabToken(result.token).role).toBe('commenter')
  })

  it('signs and verifies a name claim (§4.7(b) / XIN-694) round-trip', () => {
    const result = signCollabToken({
      uid: 'u_12345',
      documentName: 'octo:s_001:f_888:wb:d_board1',
      role: 'writer',
      permission_epoch: 2,
      name: '大背头',
    })
    // The display name is also surfaced on the response so the client can seed
    // its own presence without a separate directory round-trip.
    expect(result.name).toBe('大背头')
    const claims = verifyCollabToken(result.token)
    expect(claims).toEqual({
      uid: 'u_12345',
      documentName: 'octo:s_001:f_888:wb:d_board1',
      role: 'writer',
      permission_epoch: 2,
      name: '大背头',
    })
  })

  it('omits the name claim entirely when none is supplied (back-compat with pre-XIN-694 tokens)', () => {
    const result = signCollabToken({
      uid: 'u_1',
      documentName: 'octo:s:f:d',
      role: 'reader',
      permission_epoch: 0,
    })
    expect('name' in result).toBe(false)
    const claims = verifyCollabToken(result.token)
    expect('name' in claims).toBe(false)
    expect(claims).toEqual({
      uid: 'u_1',
      documentName: 'octo:s:f:d',
      role: 'reader',
      permission_epoch: 0,
    })
  })
})

describe('collab token v2 wire contract (remove-sp §7)', () => {
  it('signs camelCase v2 claims and maps them to the internal verifier shape', () => {
    const result = signCollabTokenV2({
      uid: 'u_2',
      docId: 'd_2',
      documentName: 'octo:s_2:f_default:d_2',
      homeSpaceId: 's_2',
      role: 'writer',
      permissionEpoch: 12,
      spaceMember: true,
    })
    const wire = jwt.decode(result.token) as Record<string, unknown>
    expect(wire).toMatchObject({
      ver: 2,
      uid: 'u_2',
      docId: 'd_2',
      documentName: 'octo:s_2:f_default:d_2',
      homeSpaceId: 's_2',
      role: 'writer',
      permissionEpoch: 12,
      spaceMember: true,
    })
    expect(wire).not.toHaveProperty('permission_epoch')
    expect(wire).not.toHaveProperty('home_space_id')
    expect(verifyCollabToken(result.token)).toEqual({
      ver: 2,
      uid: 'u_2',
      docId: 'd_2',
      documentName: 'octo:s_2:f_default:d_2',
      homeSpaceId: 's_2',
      role: 'writer',
      permission_epoch: 12,
      space_member: true,
    })
  })

  it.each([1, 3, '2', 2.5])('rejects an unknown/non-exact version %j', (ver) => {
    const token = jwt.sign(
      {
        ver,
        uid: 'u_2',
        docId: 'd_2',
        documentName: 'octo:s_2:f_default:d_2',
        homeSpaceId: 's_2',
        role: 'writer',
        permissionEpoch: 12,
      },
      config.collabToken.secret,
      { algorithm: 'HS256', expiresIn: 60 },
    )
    expect(() => verifyCollabToken(token)).toThrow(/unsupported collab token version/)
  })
})

describe('collab-token response collabWsUrl contract (§4.4)', () => {
  const original = config.collabToken.publicWsUrl

  afterEach(() => {
    // Restore the shared config singleton so this suite does not leak into others.
    ;(config.collabToken as { publicWsUrl: string }).publicWsUrl = original
  })

  const baseClaims = {
    uid: 'u_1',
    documentName: 'octo:s:f:d',
    role: 'writer' as const,
    permission_epoch: 3,
  }

  it('includes collabWsUrl (absolute URL) when publicWsUrl is configured', () => {
    ;(config.collabToken as { publicWsUrl: string }).publicWsUrl = 'ws://192.168.214.189:1234'
    const result = signCollabToken(baseClaims)
    expect(result.collabWsUrl).toBe('ws://192.168.214.189:1234')
  })

  it('omits collabWsUrl entirely (not an empty string) when publicWsUrl is unset', () => {
    ;(config.collabToken as { publicWsUrl: string }).publicWsUrl = ''
    const result = signCollabToken(baseClaims)
    expect('collabWsUrl' in result).toBe(false)
    expect(result.collabWsUrl).toBeUndefined()
  })
})
