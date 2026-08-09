// Env seeding MUST be first so config/env.ts reads it at load time.
import './helpers/pptRelayEnv.js'

import { describe, it, expect } from 'vitest'
import {
  issuePptCollabToken,
  verifyPptRelayToken,
  verifyPptRelayTicket,
  InMemoryTicketStore,
  PPT_RELAY_AUD,
  PPT_RELAY_TICKET_AUD,
} from '../src/auth/pptCollabToken.js'
import jwt from 'jsonwebtoken'
import { config } from '../src/config/env.js'

/**
 * R4-B1 unit coverage for the PPT relay token + one-time WS ticket (§7.1),
 * underpinning PPT-TOKEN-001 (issuance contents) and the single-use ticket half
 * of PPT-WS-001. Pure sign/verify — no network, no DB.
 */
describe('PPT collab token + one-time ticket (§7.1)', () => {
  const base = {
    uid: 'u_1',
    docId: 'd_ppt1',
    documentName: 'octo:s_1:f_default:ppt:d_ppt1',
    role: 'writer' as const,
    permission_epoch: 3,
    snapshotVersion: 7,
    name: 'Ada',
  }

  it('issues a relay token + ticket carrying the required fields (PPT-TOKEN-001)', () => {
    const r = issuePptCollabToken(base)
    expect(r.token).toBeTruthy()
    expect(r.ticket).toBeTruthy()
    expect(r.role).toBe('writer')
    expect(r.epoch).toBe(3)
    expect(r.docId).toBe('d_ppt1')
    expect(r.documentName).toBe(base.documentName)
    expect(r.snapshotVersion).toBe(7)
    expect(r.name).toBe('Ada')
    expect(r.pptWsUrl).toBe('ws://ppt-relay.example.test')
    expect(typeof r.expiresAt).toBe('string')
    expect(typeof r.ticketExpiresAt).toBe('string')
    // token and ticket are distinct credentials with distinct audiences.
    expect(r.token).not.toBe(r.ticket)
  })

  it('delivers the pre-connect actor + nextS hint only when an actor is bound (XIN-1807 P0-1)', () => {
    // No actor bound: no per-actor gate, so no actor/nextS in the response.
    const legacy = issuePptCollabToken(base)
    expect(legacy.actor).toBeUndefined()
    expect(legacy.nextS).toBeUndefined()
    // Actor bound: both the actor (P0-1 delivery) and the pre-connect nextS lower-bound
    // hint are delivered so a fresh client can pre-seed its replica before the socket
    // opens. The authoritative value is `ready.nextS`; this is a hint (default 1).
    const bound = issuePptCollabToken({ ...base, actor: 'aabbccdd', nextS: 1 })
    expect(bound.actor).toBe('aabbccdd')
    expect(bound.nextS).toBe(1)
    // nextS is suppressed for a legacy (actor-less) token even if a caller passes one.
    const noActorButNextS = issuePptCollabToken({ ...base, nextS: 5 })
    expect(noActorButNextS.nextS).toBeUndefined()
  })

  it('the relay token has aud=ppt-relay; the ticket has aud=ppt-relay-ticket + a jti', () => {
    const r = issuePptCollabToken(base)
    const tok = verifyPptRelayToken(r.token)
    expect(tok.uid).toBe('u_1')
    expect(tok.role).toBe('writer')
    expect(tok.permission_epoch).toBe(3)

    const tik = verifyPptRelayTicket(r.ticket)
    expect(tik.docId).toBe('d_ppt1')
    expect(typeof tik.jti).toBe('string')
    expect(tik.jti.length).toBeGreaterThan(0)

    // raw payload audiences are exactly as specified.
    expect((jwt.decode(r.token) as { aud?: string }).aud).toBe(PPT_RELAY_AUD)
    expect((jwt.decode(r.ticket) as { aud?: string }).aud).toBe(PPT_RELAY_TICKET_AUD)
  })

  it('cross-audience replay is rejected: a relay token is not a valid ticket (and vice versa)', () => {
    const r = issuePptCollabToken(base)
    expect(() => verifyPptRelayTicket(r.token)).toThrow()
    expect(() => verifyPptRelayToken(r.ticket)).toThrow()
  })

  it('a tampered/forged credential fails verification', () => {
    const forged = jwt.sign({ uid: 'u_x', docId: 'd', documentName: 'n', role: 'admin', permission_epoch: 0 }, 'wrong-secret', {
      algorithm: 'HS256',
      audience: PPT_RELAY_AUD,
      expiresIn: 60,
    })
    expect(() => verifyPptRelayToken(forged)).toThrow()
  })

  it('omits name / pptWsUrl when not supplied / unconfigured is handled by config', () => {
    const r = issuePptCollabToken({ ...base, name: undefined })
    expect(r.name).toBeUndefined()
    // pptWsUrl is present because the test env sets PPT_RELAY_PUBLIC_WS_URL.
    expect(r.pptWsUrl).toBe(config.ppt.relay.publicWsUrl)
  })

  describe('InMemoryTicketStore single-use (PPT-WS-001 ticket half)', () => {
    it('consumes a jti exactly once', async () => {
      const store = new InMemoryTicketStore()
      expect(await store.consume('jti-1')).toBe(true)
      expect(await store.consume('jti-1')).toBe(false)
      expect(await store.consume('jti-2')).toBe(true)
    })
  })
})
