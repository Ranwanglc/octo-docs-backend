import { describe, it, expect } from 'vitest'
import { decideAcceptBranch, type InviteState } from '../src/api/services/acceptDecision.js'
import {
  INVITE_STATUS_ACTIVE,
  INVITE_STATUS_REVOKED,
  INVITE_STATUS_EXHAUSTED,
} from '../src/db/repos/docInviteRepo.js'

const NOW = 1_000_000

function invite(partial: Partial<InviteState> = {}): InviteState {
  return {
    status: INVITE_STATUS_ACTIVE,
    role: 'writer',
    maxUses: 0,
    usedCount: 0,
    expiresAtMs: null,
    ...partial,
  }
}

describe('invite accept branches (§4.6 step 4)', () => {
  it('branch d: first accept (no role, not redeemed) => first', () => {
    const d = decideAcceptBranch({ invite: invite(), curRole: 'none', redeemed: false, docExists: true, nowMs: NOW })
    expect(d).toEqual({ kind: 'first', role: 'writer' })
  })

  it('branch c: re-accept (no role, previously redeemed) => reaccept (no used_count)', () => {
    const d = decideAcceptBranch({ invite: invite(), curRole: 'none', redeemed: true, docExists: true, nowMs: NOW })
    expect(d).toEqual({ kind: 'reaccept', role: 'writer' })
  })

  it('branch a: existing role >= invite role => no-op returning current role', () => {
    const d = decideAcceptBranch({ invite: invite({ role: 'writer' }), curRole: 'admin', redeemed: false, docExists: true, nowMs: NOW })
    expect(d).toEqual({ kind: 'noop', role: 'admin' })
  })

  it('branch a: owner (admin) accepting own doc invite => no-op (no ghost member)', () => {
    // owner is resolved to admin upstream; admin >= any invite role => no-op.
    const d = decideAcceptBranch({ invite: invite({ role: 'admin' }), curRole: 'admin', redeemed: false, docExists: true, nowMs: NOW })
    expect(d).toEqual({ kind: 'noop', role: 'admin' })
  })

  it('branch b: existing role < invite role => no auto-upgrade, returns current role', () => {
    const d = decideAcceptBranch({ invite: invite({ role: 'admin' }), curRole: 'reader', redeemed: false, docExists: true, nowMs: NOW })
    expect(d).toEqual({ kind: 'noop', role: 'reader' })
  })

  it('equal role (reader == reader) is branch a no-op', () => {
    const d = decideAcceptBranch({ invite: invite({ role: 'reader' }), curRole: 'reader', redeemed: false, docExists: true, nowMs: NOW })
    expect(d).toEqual({ kind: 'noop', role: 'reader' })
  })

  it('commenter invite, no current role => first accept as commenter', () => {
    const d = decideAcceptBranch({ invite: invite({ role: 'commenter' }), curRole: 'none', redeemed: false, docExists: true, nowMs: NOW })
    expect(d).toEqual({ kind: 'first', role: 'commenter' })
  })

  it('writer is NOT downgraded by a commenter invite (branch a: writer >= commenter)', () => {
    const d = decideAcceptBranch({ invite: invite({ role: 'commenter' }), curRole: 'writer', redeemed: false, docExists: true, nowMs: NOW })
    expect(d).toEqual({ kind: 'noop', role: 'writer' })
  })

  it('commenter is NOT auto-upgraded by a writer invite (branch b: commenter < writer, no auto-upgrade)', () => {
    const d = decideAcceptBranch({ invite: invite({ role: 'writer' }), curRole: 'commenter', redeemed: false, docExists: true, nowMs: NOW })
    expect(d).toEqual({ kind: 'noop', role: 'commenter' })
  })
})

describe('invite accept gates (§4.6 step 2)', () => {
  it('revoked invite => gone', () => {
    const d = decideAcceptBranch({ invite: invite({ status: INVITE_STATUS_REVOKED }), curRole: 'none', redeemed: false, docExists: true, nowMs: NOW })
    expect(d).toEqual({ kind: 'gone' })
  })

  it('expired by timestamp => gone', () => {
    const d = decideAcceptBranch({ invite: invite({ expiresAtMs: NOW - 1 }), curRole: 'none', redeemed: false, docExists: true, nowMs: NOW })
    expect(d).toEqual({ kind: 'gone' })
  })

  it('not yet expired => proceeds to first', () => {
    const d = decideAcceptBranch({ invite: invite({ expiresAtMs: NOW + 1 }), curRole: 'none', redeemed: false, docExists: true, nowMs: NOW })
    expect(d).toEqual({ kind: 'first', role: 'writer' })
  })

  it('exhausted (maxUses>0, usedCount>=max) for a new uid => gone', () => {
    const d = decideAcceptBranch({ invite: invite({ maxUses: 2, usedCount: 2 }), curRole: 'none', redeemed: false, docExists: true, nowMs: NOW })
    expect(d).toEqual({ kind: 'gone' })
  })

  it('exhausted but already-redeemed uid re-accepting => allowed (reaccept exception)', () => {
    const d = decideAcceptBranch({ invite: invite({ status: INVITE_STATUS_EXHAUSTED, maxUses: 2, usedCount: 2 }), curRole: 'none', redeemed: true, docExists: true, nowMs: NOW })
    expect(d).toEqual({ kind: 'reaccept', role: 'writer' })
  })

  it('max_uses=0 means unlimited — never exhausts even at high usedCount', () => {
    const d = decideAcceptBranch({ invite: invite({ maxUses: 0, usedCount: 9999 }), curRole: 'none', redeemed: false, docExists: true, nowMs: NOW })
    expect(d).toEqual({ kind: 'first', role: 'writer' })
  })

  it('doc missing => gone', () => {
    const d = decideAcceptBranch({ invite: invite(), curRole: 'none', redeemed: false, docExists: false, nowMs: NOW })
    expect(d).toEqual({ kind: 'gone' })
  })
})
