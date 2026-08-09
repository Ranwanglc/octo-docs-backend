// Env seeding MUST be first so config/env.ts reads it at load time.
import './helpers/pptRelayEnv.js'

import { describe, it, expect, afterEach, vi } from 'vitest'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { WebSocket } from 'ws'
import { config } from '../src/config/env.js'
import { PptRelay, type RelayLimits } from '../src/ppt/relay/pptRelay.js'
import { InMemoryPptRelayStore, type PptRelayStore, RetryableStorageError, canonicalPayloadHash } from '../src/ppt/relay/store.js'
import { isRetryable, STORAGE_RETRY_BACKOFF_MS } from '../src/ppt/relay/frames.js'
import { issuePptCollabToken, PPT_RELAY_TICKET_AUD } from '../src/auth/pptCollabToken.js'
import type { ResolvedRole, Role } from '../src/permission/role.js'
import type { BentoDoc } from '../src/ppt/bentoDoc.js'

/**
 * R4-B1 integration tests for the Bento-frame WS relay (§7.2 / §7.3 / §7.4),
 * driven against a real `ws` server + client over an ephemeral loopback port.
 *
 * Covers PPT-WS-001..006 (connect/ticket/replay/ack/broadcast/limits),
 * PPT-COLLAB-001..004 (five op kinds, ordering, durability-before-ack, refusal
 * classification, snapshot/GC, offline replay), and PPT-EPOCH-001..003
 * (permission epoch enforcement / downgrade / upgrade-needs-fresh-authority).
 */

const DOC = 'd_ppt1'
const DOCNAME = 'octo:s_1:f_default:ppt:d_ppt1'

function deck(title = 'Deck'): BentoDoc {
  return {
    format: 'bento/slides',
    version: 1,
    docId: 'bento_x',
    title,
    size: { width: 1280, height: 720 },
    theme: { background: '#fff', color: '#111', accent: '#3366ff', fontFamily: 'Inter' },
    slides: [{ id: 's1', background: '#fff', transition: 'none', elements: [], notes: '' }],
    modified: '2026-01-01T00:00:00.000Z',
  }
}

/** Minimal async-queue WS client with a close-code promise. */
class WsClient {
  private q: Record<string, unknown>[] = []
  private resolvers: ((m: Record<string, unknown>) => void)[] = []
  readonly closed: Promise<{ code: number }>
  constructor(readonly ws: WebSocket) {
    ws.on('message', (data: Buffer) => {
      const m = JSON.parse(data.toString()) as Record<string, unknown>
      const r = this.resolvers.shift()
      if (r) r(m)
      else this.q.push(m)
    })
    this.closed = new Promise((res) => ws.on('close', (code: number) => res({ code })))
  }
  send(o: unknown): void {
    this.ws.send(JSON.stringify(o))
  }
  recv(timeoutMs = 1500): Promise<Record<string, unknown>> {
    const next = this.q.shift()
    if (next) return Promise.resolve(next)
    return new Promise((res, rej) => {
      const resolver = (m: Record<string, unknown>): void => {
        clearTimeout(t)
        res(m)
      }
      const t = setTimeout(() => {
        const idx = this.resolvers.indexOf(resolver)
        if (idx >= 0) this.resolvers.splice(idx, 1)
        rej(new Error('recv timeout'))
      }, timeoutMs)
      this.resolvers.push(resolver)
    })
  }
  /** Receive until `pred` matches; returns every message up to and incl. it. */
  async recvUntil(pred: (m: Record<string, unknown>) => boolean, timeoutMs = 2500): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = []
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const m = await this.recv(Math.max(50, deadline - Date.now()))
      out.push(m)
      if (pred(m)) return out
    }
    throw new Error('recvUntil: no match')
  }
  close(): void {
    this.ws.close()
  }
}

interface Harness {
  relay: PptRelay
  store: PptRelayStore
  connect: (opts: { uid: string; role: Role; name?: string; ticket?: string; path?: string; actor?: string }) => Promise<WsClient>
  ticketFor: (opts: { uid: string; role: Role; name?: string; epoch?: number; actor?: string }) => string
  setEpoch: (e: number) => void
  setRole: (uid: string, r: ResolvedRole) => void
  setDocStatus: (s: 'live' | 'deleted') => void
  close: () => Promise<void>
}

const harnesses: Harness[] = []

async function setup(
  opts: {
    store?: PptRelayStore
    limits?: Partial<RelayLimits>
    roleProvider?: (ctx: { uid: string; docId: string; documentName: string; spaceMember: boolean }) => Promise<ResolvedRole>
    epochProvider?: (documentName: string) => Promise<number>
    docStatusProvider?: (docId: string) => Promise<'live' | 'deleted'>
    baseDocProvider?: (docId: string) => Promise<import('../src/ppt/bentoDoc.js').BentoDoc | null>
  } = {},
): Promise<Harness> {
  const store = opts.store ?? new InMemoryPptRelayStore()
  let liveEpoch = 0
  const roleMap = new Map<string, ResolvedRole>()
  let docStatus: 'live' | 'deleted' = 'live'

  const relay = new PptRelay({
    store,
    epochProvider: opts.epochProvider ?? (async () => liveEpoch),
    roleProvider: opts.roleProvider ?? (async ({ uid }) => roleMap.get(uid) ?? 'writer'),
    docStatusProvider: opts.docStatusProvider ?? (async () => docStatus),
    ...(opts.baseDocProvider ? { baseDocProvider: opts.baseDocProvider } : {}),
    limits: opts.limits,
  })
  const server: HttpServer = createServer()
  relay.attach(server)
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()))
  const port = (server.address() as AddressInfo).port

  const ticketFor = (o: { uid: string; role: Role; name?: string; epoch?: number; actor?: string }): string =>
    issuePptCollabToken({
      uid: o.uid,
      docId: DOC,
      documentName: DOCNAME,
      role: o.role,
      permission_epoch: o.epoch ?? liveEpoch,
      snapshotVersion: 0,
      ...(o.name ? { name: o.name } : {}),
      // A server-minted actor claim (XIN-1789 D1). Present => the relay enforces
      // `op.a === actor` + per-actor `s` continuity; absent => legacy first-frame pin.
      ...(o.actor ? { actor: o.actor } : {}),
    }).ticket

  const connect = (o: { uid: string; role: Role; name?: string; ticket?: string; path?: string; actor?: string }): Promise<WsClient> => {
    const ticket = o.ticket ?? ticketFor(o)
    const ws = new WebSocket(`ws://127.0.0.1:${port}${o.path ?? '/api/v1/ppt/collab'}`, ['ppt-relay', ticket])
    const client = new WsClient(ws)
    return new Promise<WsClient>((res, rej) => {
      ws.on('open', () => res(client))
      ws.on('error', rej)
    })
  }

  const h: Harness = {
    relay,
    store,
    connect,
    ticketFor,
    setEpoch: (e) => {
      liveEpoch = e
    },
    setRole: (uid, r) => {
      roleMap.set(uid, r)
    },
    setDocStatus: (s) => {
      docStatus = s
    },
    close: () =>
      new Promise<void>((res) => {
        relay.close()
        server.close(() => res())
      }),
  }
  harnesses.push(h)
  return h
}

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.close()
})

/** Send hello and drain the replay up to `ready`, returning the ready frame. */
async function helloReady(c: WsClient, since = 0): Promise<{ ready: Record<string, unknown>; replay: Record<string, unknown>[] }> {
  c.send({ t: 'hello', pv: 2, since })
  const replay = await c.recvUntil((m) => m.ctl === 'ready')
  return { ready: replay[replay.length - 1]!, replay }
}

/** Poll `probe` until it returns a truthy value (fire-and-forget server work like
 * the soft snapshotter completes on the room chain shortly after an ack). */
async function waitFor<T>(probe: () => Promise<T | null | undefined>, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await probe()
    if (v) return v
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const OPS_FRAME = (k: number, frameId: string, epoch = 0, ops: unknown[] = [{ op: 'set', a: 'u-test', s: 1, l: 1, k: 'x', v: 1 }]) => ({
  t: 'ops',
  pv: 2,
  k,
  frameId,
  epoch,
  ops,
})

describe('PPT relay: connect / replay / ready (PPT-WS-001)', () => {
  it('every role connects and receives replay -> ready with its role/epoch/snapshotVersion', async () => {
    const h = await setup()
    for (const role of ['reader', 'commenter', 'writer', 'admin'] as Role[]) {
      const c = await h.connect({ uid: `u_${role}`, role })
      const { ready } = await helloReady(c)
      expect(ready.ctl).toBe('ready')
      expect(ready.role).toBe(role)
      expect(ready.epoch).toBe(0)
      expect(ready.snapshotVersion).toBe(0)
      c.close()
    }
  })

  it('replays snapshot -> ops -> ready in order for a joiner behind the snapshot', async () => {
    const h = await setup()
    // Seed: 2 ops, a snapshot covering seq 1, then op 2 remains after prune.
    await h.store.appendOp(DOC, 'f1', OPS_FRAME(1, 'f1'))
    await h.store.appendOp(DOC, 'f2', OPS_FRAME(2, 'f2'))
    await h.store.saveSnapshot({ docId: DOC, coveredSeq: 1, doc: deck() })
    await h.store.pruneOpsThrough(DOC, 1)

    const c = await h.connect({ uid: 'u1', role: 'writer' })
    const { replay } = await helloReady(c)
    const kinds = replay.map((m) => m.ctl)
    expect(kinds[0]).toBe('snapshot')
    expect(kinds).toContain('op')
    expect(kinds[kinds.length - 1]).toBe('ready')
    // op index must come after snapshot index.
    expect(kinds.indexOf('op')).toBeGreaterThan(kinds.indexOf('snapshot'))
  })

  it('a bad / replayed ticket is rejected (single-use); missing ticket closes 4401', async () => {
    const h = await setup()
    const ticket = h.ticketFor({ uid: 'u1', role: 'writer' })
    const c1 = await h.connect({ uid: 'u1', role: 'writer', ticket })
    await helloReady(c1)
    // Reusing the SAME ticket string is rejected (single-use).
    const c2 = await h.connect({ uid: 'u1', role: 'writer', ticket })
    expect((await c2.closed).code).toBe(4401)
  })
})

describe('PPT relay: role gating (PPT-WS-002)', () => {
  it('reader/commenter may send ephemeral frames but ops/snap are refused forbidden-role', async () => {
    const h = await setup()
    const writer = await h.connect({ uid: 'u_w', role: 'writer' })
    await helloReady(writer)
    for (const role of ['reader', 'commenter'] as Role[]) {
      const c = await h.connect({ uid: `u_${role}`, role })
      await helloReady(c)
      // ephemeral p is accepted (writer sees presence, no refusal to c).
      c.send({ t: 'p', pv: 2, presence: { cursor: 1 } })
      const seen = await writer.recvUntil((m) => m.ctl === 'presence')
      expect(seen[seen.length - 1]!.uid).toBe(`u_${role}`)
      // ops is refused with forbidden-role, not persisted, not broadcast.
      c.send(OPS_FRAME(1, `${role}-f1`))
      const refused = await c.recv()
      expect(refused.ctl).toBe('refused')
      expect(refused.code).toBe('forbidden-role')
      expect(refused.retryable).toBe(false)
      c.close()
    }
    expect(await h.store.currentSeq(DOC)).toBe(0)
    // writer received no op broadcast from the readers.
    await expect(writer.recv(250)).rejects.toThrow()
  })
})

describe('PPT relay: op kinds + ack/broadcast ordering (PPT-WS-003 / PPT-WS-005)', () => {
  it('accepts all five op kinds; acks sender after durable persist; broadcasts to peers without echo', async () => {
    const h = await setup()
    const a = await h.connect({ uid: 'u_a', role: 'writer' })
    const b = await h.connect({ uid: 'u_b', role: 'writer' })
    await helloReady(a)
    await helloReady(b)

    const ops = [
      { op: 'set', a: 'u-test', s: 1, l: 1, k: 'x', v: 1 },
      { op: 'ins', a: 'u-test', s: 1, l: 1, kind: 'element', id: 's1\u001fe1', sl: 's1', ord: 'a1', node: { id: 'e1' } },
      { op: 'del', a: 'u-test', s: 1, l: 1, kind: 'element', id: 's1\u001fe1' },
      { op: 'ord', a: 'u-test', s: 1, l: 1, kind: 'slide', id: 's1', ord: 'a1' },
      { op: 'txt', a: 'u-test', s: 1, l: 1, el: 's1\u001fe1', sd: [1, 'u-test'], ins: [{ at: '^', toks: ['t'] }] },
    ]
    a.send(OPS_FRAME(42, 'a-f1', 0, ops))

    const ack = await a.recv()
    expect(ack.ctl).toBe('ack')
    expect(ack.k).toBe(42)
    expect(ack.q).toBe(1)
    expect(ack.snapshotVersion).toBe(0)

    // Peer B receives the sequenced op frame.
    const opMsg = await b.recvUntil((m) => m.ctl === 'op')
    const last = opMsg[opMsg.length - 1]!
    expect(last.q).toBe(1)
    expect((last.frame as { frameId: string }).frameId).toBe('a-f1')

    // Durable: the frame is persisted before the ack was sent.
    expect(await h.store.currentSeq(DOC)).toBe(1)

    // A must NOT echo its own op (only the ack arrived).
    await expect(a.recv(250)).rejects.toThrow()
  })

  it('a resent frame (same frameId) re-acks its original seq and is not rebroadcast', async () => {
    const h = await setup()
    const a = await h.connect({ uid: 'u_a', role: 'writer' })
    const b = await h.connect({ uid: 'u_b', role: 'writer' })
    await helloReady(a)
    await helloReady(b)

    a.send(OPS_FRAME(1, 'dup-1'))
    expect((await a.recv()).q).toBe(1)
    await b.recvUntil((m) => m.ctl === 'op')

    a.send(OPS_FRAME(1, 'dup-1')) // resend
    const ack2 = await a.recv()
    expect(ack2.ctl).toBe('ack')
    expect(ack2.q).toBe(1) // same seq, no new row
    expect(await h.store.currentSeq(DOC)).toBe(1)
    // B does not receive a second broadcast for the duplicate.
    await expect(b.recv(250)).rejects.toThrow()
  })

  it('a resent frameId with a different payload is refused and not re-acked', async () => {
    const h = await setup()
    const a = await h.connect({ uid: 'u_a', role: 'writer' })
    await helloReady(a)

    a.send(OPS_FRAME(1, 'dup-mismatch', 0, [{ op: 'set', a: 'u-test', s: 1, l: 1, k: 'x', v: 1 }]))
    expect(await a.recv()).toMatchObject({ ctl: 'ack', q: 1 })

    a.send(OPS_FRAME(2, 'dup-mismatch', 0, [{ op: 'set', a: 'u-test', s: 1, l: 1, k: 'x', v: 2 }]))
    expect(await a.recv()).toMatchObject({
      ctl: 'refused',
      code: 'protocol-version',
      frameId: 'dup-mismatch',
      retryable: false,
    })
    expect(await h.store.currentSeq(DOC)).toBe(1)
  })
})

describe('PPT relay: protocol version (PPT-WS-004)', () => {
  it('missing or incompatible pv is refused protocol-version and never persisted', async () => {
    const h = await setup()
    const a = await h.connect({ uid: 'u_a', role: 'writer' })
    await helloReady(a)

    a.send({ t: 'ops', k: 1, frameId: 'x', epoch: 0, ops: [{ op: 'set', a: 'u-test', s: 1, l: 1, k: 'x', v: 1 }] }) // no pv
    const r1 = await a.recv()
    expect(r1.ctl).toBe('refused')
    expect(r1.code).toBe('protocol-version')

    a.send({ t: 'ops', pv: 1, k: 2, frameId: 'y', epoch: 0, ops: [{ op: 'set', a: 'u-test', s: 1, l: 1, k: 'x', v: 1 }] }) // pv=1
    const r2 = await a.recv()
    expect(r2.code).toBe('protocol-version')

    expect(await h.store.currentSeq(DOC)).toBe(0)
  })
})

// XIN-1772 P0-2: op metadata is validated at the trust boundary. `op.a` is otherwise
// fully client-chosen, so the relay both charset-restricts it (no client can mint the
// reserved `@relay` reducer actor) AND binds it to the connection (an editor cannot
// attribute ops to a co-editor's actor to censor them, nor mint a per-actor gap under
// a foreign actor).
describe('PPT relay: op actor binding (XIN-1772 P0-2)', () => {
  it('refuses a frame minting the reserved reducer actor and never persists it', async () => {
    const h = await setup()
    const w = await h.connect({ uid: 'u_w', role: 'writer' })
    await helloReady(w)

    w.send({ t: 'ops', pv: 2, k: 1, frameId: 'reserved', epoch: 0, ops: [{ op: 'set', a: '@relay', s: 1, l: 1, k: 'x', v: 1 }] })
    expect(await w.recv()).toMatchObject({ ctl: 'refused', code: 'protocol-version' })
    expect(await h.store.currentSeq(DOC)).toBe(0)
  })

  it('pins the connection actor on its first ops frame and refuses a later foreign actor', async () => {
    const h = await setup()
    const w = await h.connect({ uid: 'u_w', role: 'writer' })
    await helloReady(w)

    // First frame establishes the connection actor `u-x` and is acked.
    w.send({ t: 'ops', pv: 2, k: 1, frameId: 'f1', epoch: 0, ops: [{ op: 'set', a: 'u-x', s: 1, l: 1, k: 'x', v: 1 }] })
    expect(await w.recv()).toMatchObject({ ctl: 'ack', q: 1 })

    // A later frame attributing ops to a DIFFERENT actor (co-editor censorship) is refused.
    w.send({ t: 'ops', pv: 2, k: 2, frameId: 'f2', epoch: 0, ops: [{ op: 'set', a: 'u-victim', s: 5, l: 5, k: 'x', v: 2 }] })
    expect(await w.recv()).toMatchObject({ ctl: 'refused', code: 'protocol-version' })

    // A frame mixing two actors is refused too.
    w.send({ t: 'ops', pv: 2, k: 3, frameId: 'f3', epoch: 0, ops: [
      { op: 'set', a: 'u-x', s: 2, l: 2, k: 'x', v: 3 },
      { op: 'set', a: 'u-other', s: 1, l: 3, k: 'y', v: 4 },
    ] })
    expect(await w.recv()).toMatchObject({ ctl: 'refused', code: 'protocol-version' })

    // Only the first (legitimate) frame ever persisted.
    expect(await h.store.currentSeq(DOC)).toBe(1)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// XIN-1789 D1: actor ↔ authenticated-uid binding (server-mint).
//
// The XIN-1772 block above pins conn.actor from the FIRST frame's self-declared
// op.a — a LEGACY credential with no actor claim keeps that behavior. D1 closes the
// impersonation/censorship path (Jerry J2 / yujiawei P0-2) by minting the actor
// SERVER-SIDE from the authenticated uid at token issuance (HMAC(uid,docId,session)
// truncated into the accepted charset, src/auth/pptCollabToken.ts `mintCollabActor`)
// and carrying it as a signed claim. The relay pins conn.actor from that claim (not
// the first frame) and refuses any op whose `a` differs, so the client can neither
// choose nor forge its actor. The two observable contracts:
//   1. a uid sending another collaborator's op.a is refused (no impersonation), and
//   2. a legitimate idempotent resend whose ops carry a DIFFERENT (freshly minted)
//      actor — an offline queue flushed after a page reload — is still RE-ACKED,
//      because the actor check runs AFTER the known-duplicate re-ack lookup and the
//      dedup identity is actor-independent (src/ppt/relay/store.ts canonicalPayloadHash).
describe('PPT relay: op actor bound to authenticated uid (XIN-1783 D1)', () => {
  it('refuses a first frame declaring another collaborator’s actor (impersonation)', async () => {
    const h = await setup()
    // D1: the credential carries a server-minted actor derived from the uid; the
    // client cannot choose it. The harness pins it deterministically to assert the
    // binding — production mints it via HMAC(uid, docId, session).
    const attacker = await h.connect({ uid: 'u_attacker', role: 'writer', actor: 'u-attacker-actor' })
    await helloReady(attacker)
    // The attacker read a victim's actor off a broadcast and declares it.
    attacker.send({ t: 'ops', pv: 2, k: 1, frameId: 'imp', epoch: 0, ops: [{ op: 'set', a: 'u-victim-actor', s: 1, l: 1, k: 'x', v: 1 }] })
    expect(await attacker.recv()).toMatchObject({ ctl: 'refused', code: 'protocol-version' })
    expect(await h.store.currentSeq(DOC)).toBe(0)
  })

  it('still re-acks a legitimate idempotent resend that carries a freshly-minted actor', async () => {
    const h = await setup()
    const w = await h.connect({ uid: 'u_w', role: 'writer', actor: 'u-w-actor-1' })
    await helloReady(w)
    // Original write commits under the session's first minted actor.
    w.send({ t: 'ops', pv: 2, k: 1, frameId: 'dup', epoch: 0, ops: [{ op: 'set', a: 'u-w-actor-1', s: 1, l: 1, k: 'x', v: 1 }] })
    expect(await w.recv()).toMatchObject({ ctl: 'ack', q: 1 })
    // Reload → offline queue flush → the SAME frameId is resent, now under a fresh
    // minted actor. It is already durable, so it MUST re-ack its stored seq, not be
    // refused: the dedup identity is actor-independent and the re-ack precedes the
    // actor check.
    const w2 = await h.connect({ uid: 'u_w', role: 'writer', actor: 'u-w-actor-2' })
    await helloReady(w2)
    w2.send({ t: 'ops', pv: 2, k: 1, frameId: 'dup', epoch: 0, ops: [{ op: 'set', a: 'u-w-actor-2', s: 1, l: 1, k: 'x', v: 1 }] })
    expect(await w2.recv()).toMatchObject({ ctl: 'ack', q: 1 })
  })
})

// ────────────────────────────────────────────────────────────────────────────
// XIN-1789 P1-1/P1-2/P1-3: op-metadata trust boundary — `s`, `l`, `sd[0]`. Same
// trust-boundary decision as the actor minting above (root-cause consolidation
// item 3). An absolute cap (MAX_OP_CLOCK) admits a wire-legal value FAR below the
// ceiling but far ABOVE the room's live clock that still bricks the room; the
// meaningful bound is RELATIVE to the room's live state. The relay now enforces
// per-actor `s` continuity (conn.nextS) and bounds `l`/`sd[0]` against
// `roomLamport + OP_CLOCK_SLACK`. All three run in server-bound mode (a minted
// actor claim), which also enables the per-actor `s` continuity gate.
describe('PPT relay: op-metadata bounds are relative, not absolute (XIN-1783 P1-1/1-2/1-3)', () => {
  it('P1-1: a non-contiguous / duplicate per-actor s is refused at the trust boundary', async () => {
    const h = await setup()
    const w = await h.connect({ uid: 'u_w', role: 'writer', actor: 'u-w-actor' })
    await helloReady(w)
    // s=1 establishes the per-connection sequence.
    w.send({ t: 'ops', pv: 2, k: 1, frameId: 'g1', epoch: 0, ops: [{ op: 'set', a: 'u-w-actor', s: 1, l: 1, k: 'x', v: 1 }] })
    expect(await w.recv()).toMatchObject({ ctl: 'ack', q: 1 })
    // A REPEAT of s=1 (a distinct frameId, so not a dedup re-ack) is refused: the
    // per-actor sequence already advanced past 1.
    w.send({ t: 'ops', pv: 2, k: 2, frameId: 'g1repeat', epoch: 0, ops: [{ op: 'set', a: 'u-w-actor', s: 1, l: 2, k: 'x', v: 9 }] })
    expect(await w.recv()).toMatchObject({ ctl: 'refused', code: 'protocol-version' })
    // s=3 skips s=2 → an unfillable per-actor gap that freezes room GC forever.
    // Must be refused (track conn.nextS; refuse skip/reorder/repeat).
    w.send({ t: 'ops', pv: 2, k: 3, frameId: 'g2', epoch: 0, ops: [{ op: 'set', a: 'u-w-actor', s: 3, l: 2, k: 'x', v: 2 }] })
    expect(await w.recv()).toMatchObject({ ctl: 'refused', code: 'protocol-version' })
    // The contiguous successor s=2 is still accepted (a refused frame never advanced
    // the sequence), so the room is not bricked by the rejected gap.
    w.send({ t: 'ops', pv: 2, k: 4, frameId: 'g2ok', epoch: 0, ops: [{ op: 'set', a: 'u-w-actor', s: 2, l: 2, k: 'x', v: 2 }] })
    expect(await w.recv()).toMatchObject({ ctl: 'ack', q: 2 })
  })

  it('P1-2: a near-ceiling Lamport clock does not permanently brick the room', async () => {
    const h = await setup()
    const w = await h.connect({ uid: 'u_w', role: 'writer', actor: 'u-w-actor' })
    await helloReady(w)
    // A poison op at the absolute ceiling: with a RELATIVE bound this is refused up
    // front (l far above roomLamport), so it can never pin the clock…
    w.send({ t: 'ops', pv: 2, k: 1, frameId: 'poison', epoch: 0, ops: [{ op: 'set', a: 'u-w-actor', s: 1, l: 2 ** 45, k: 'x', v: 1 }] })
    expect(await w.recv()).toMatchObject({ ctl: 'refused', code: 'protocol-version' })
    // …and a subsequent legitimately-minted op is still accepted (room not bricked).
    w.send({ t: 'ops', pv: 2, k: 2, frameId: 'ok', epoch: 0, ops: [{ op: 'set', a: 'u-w-actor', s: 1, l: 1, k: 'x', v: 2 }] })
    expect(await w.recv()).toMatchObject({ ctl: 'ack' })
  })

  it('P1-3: a txt seed generation (sd[0]) above the room clock is refused', async () => {
    const h = await setup()
    const w = await h.connect({ uid: 'u_w', role: 'writer', actor: 'u-w-actor' })
    await helloReady(w)
    // sd[0] is a Lamport value (cmpReg); a MAX_SAFE_INTEGER seed pins the text
    // generation above every legitimate successor. Same relative bound as `l`.
    w.send({ t: 'ops', pv: 2, k: 1, frameId: 'txtpoison', epoch: 0, ops: [
      { op: 'txt', a: 'u-w-actor', s: 1, l: 1, el: 'e1', sd: [Number.MAX_SAFE_INTEGER, 'u-w-actor'], base: 'x', ins: [{ at: 'x', toks: ['a'] }] },
    ] })
    expect(await w.recv()).toMatchObject({ ctl: 'refused', code: 'protocol-version' })
  })
})

describe('PPT relay: refused retry classification (PPT-WS-006)', () => {
  it('classifies every refused code; rate-limited is retryable with retryInMs', async () => {
    const h = await setup({ limits: { maxOpsPerFrame: 2, maxFramesPerWindow: 3, maxRoomFrameBytes: 100_000_000 } })
    const w = await h.connect({ uid: 'u_w', role: 'writer' })
    const rdr = await h.connect({ uid: 'u_r', role: 'reader' })
    await helloReady(w)
    await helloReady(rdr)

    // forbidden-role (reader)
    rdr.send(OPS_FRAME(1, 'r1'))
    expect((await rdr.recv())).toMatchObject({ code: 'forbidden-role', retryable: false })

    // protocol-version
    w.send({ t: 'ops', pv: 99, k: 1, frameId: 'pv1', epoch: 0, ops: [{ op: 'set', a: 'u-test', s: 1, l: 1, k: 'x', v: 1 }] })
    expect(await w.recv()).toMatchObject({ code: 'protocol-version', retryable: false })

    // too-large (op count over the per-frame cap of 2)
    w.send(OPS_FRAME(2, 'big', 0, [{ op: 'set', a: 'u-test', s: 1, l: 1, k: 'x', v: 1 }, { op: 'set', a: 'u-test', s: 1, l: 1, k: 'x', v: 1 }, { op: 'set', a: 'u-test', s: 1, l: 1, k: 'x', v: 1 }]))
    expect(await w.recv()).toMatchObject({ code: 'too-large', retryable: false })

    // stale-epoch (frame epoch != live epoch)
    h.setEpoch(4)
    w.send(OPS_FRAME(3, 'stale', 0))
    expect(await w.recv()).toMatchObject({ code: 'stale-epoch', retryable: false })
    h.setEpoch(0)

    // snapshot-conflict (snap covers a seq beyond the op log)
    w.send({ t: 'snap', pv: 2, k: 4, epoch: 0, q: 99, doc: deck() })
    expect(await w.recv()).toMatchObject({ code: 'snapshot-conflict', retryable: false })

    // rate-limited (4th persisted frame within the window of 3) — retryable with a
    // window-derived retryInMs (storage-retry is the other retryable code, covered
    // by its own P1-5 test below)
    w.send(OPS_FRAME(10, 'ok1'))
    await w.recv()
    w.send(OPS_FRAME(11, 'ok2'))
    await w.recv()
    w.send(OPS_FRAME(12, 'ok3'))
    await w.recv()
    w.send(OPS_FRAME(13, 'rl'))
    const rl = await w.recv()
    expect(rl.code).toBe('rate-limited')
    expect(rl.retryable).toBe(true)
    expect(typeof rl.retryInMs).toBe('number')
  })

  it('doc-deleted refuses mutations and storage-failed is surfaced (both permanent)', async () => {
    // storage-failed: a store whose appendOp always throws.
    const failing: PptRelayStore = {
      appendOp: async () => {
        throw new Error('boom')
      },
      frameSeq: async () => null,
      opsSince: async () => [],
      currentSeq: async () => 0,
      roomBytes: async () => 0,
      getSnapshot: async () => null,
      saveSnapshot: async () => ({ snapshotVersion: 1 }),
      pruneOpsThrough: async () => 0,
    }
    const h = await setup({ store: failing })
    const w = await h.connect({ uid: 'u_w', role: 'writer' })
    await helloReady(w)
    w.send(OPS_FRAME(1, 's1'))
    expect(await w.recv()).toMatchObject({ code: 'storage-failed', retryable: false })

    // doc-deleted: flip status; the next mutating frame is refused doc-deleted.
    const h2 = await setup({ limits: { docStatusCacheTtlMs: 0 } })
    const w2 = await h2.connect({ uid: 'u_w', role: 'writer' })
    await helloReady(w2)
    h2.setDocStatus('deleted')
    w2.send(OPS_FRAME(1, 'd1'))
    expect(await w2.recv()).toMatchObject({ code: 'doc-deleted', retryable: false })
  })
})

describe('PPT relay: convergence + presence (PPT-COLLAB-001 / PPT-COLLAB-002)', () => {
  it('two writers converge on one canonical op order with no echo loop', async () => {
    const h = await setup()
    const a = await h.connect({ uid: 'u_a', role: 'writer' })
    const b = await h.connect({ uid: 'u_b', role: 'writer' })
    await helloReady(a)
    await helloReady(b)

    // Fire 10 ops from each writer, then drain each queue. Each peer receives
    // exactly the OTHER's 10 ops (broadcast excludes the sender), plus its own
    // 10 acks. Draining sequentially (never two concurrent recvs on one socket)
    // avoids racing the shared message queue.
    for (let i = 0; i < 10; i++) {
      a.send(OPS_FRAME(i, `a-${i}`))
      b.send(OPS_FRAME(i, `b-${i}`))
    }
    const collect = async (c: WsClient): Promise<{ acks: number; opQs: number[] }> => {
      const opQs: number[] = []
      let acks = 0
      while (opQs.length < 10 || acks < 10) {
        const m = await c.recv(3000)
        if (m.ctl === 'op') opQs.push(m.q as number)
        else if (m.ctl === 'ack') acks++
      }
      return { acks, opQs }
    }
    const [ra, rb] = await Promise.all([collect(a), collect(b)])

    // 20 ops persisted in one monotonic order; each peer saw the other's 10.
    expect(await h.store.currentSeq(DOC)).toBe(20)
    expect(ra.opQs).toHaveLength(10)
    expect(rb.opQs).toHaveLength(10)
    expect(ra.acks).toBe(10)
    expect(rb.acks).toBe(10)
    // A peer never echoes its own frames: A's received op q's and B's are disjoint
    // halves of 1..20, and each is strictly increasing.
    for (const arr of [ra.opQs, rb.opQs]) {
      for (let i = 1; i < arr.length; i++) expect(arr[i]!).toBeGreaterThan(arr[i - 1]!)
    }
    const union = new Set([...ra.opQs, ...rb.opQs])
    expect(union.size).toBe(20) // 20 distinct sequences, no duplicate delivery
  })

  it('presence uses the SERVER-trusted name; bye removes immediately', async () => {
    const h = await setup()
    const a = await h.connect({ uid: 'u_a', role: 'writer', name: 'Ada' })
    const b = await h.connect({ uid: 'u_b', role: 'writer' })
    await helloReady(a)
    await helloReady(b)

    // A publishes presence with a SPOOFED name; relay stamps the trusted one.
    a.send({ t: 'p', pv: 2, presence: { cursor: 3 }, name: 'Mallory' })
    const p = await b.recvUntil((m) => m.ctl === 'presence')
    const last = p[p.length - 1]!
    expect(last.uid).toBe('u_a')
    expect(last.name).toBe('Ada')

    // bye: B sees a leave and A's socket closes.
    a.send({ t: 'bye', pv: 2 })
    await b.recvUntil((m) => m.ctl === 'presence')
    expect((await a.closed).code).toBe(1000)
  })
})

describe('PPT relay: snapshot + GC + offline replay (PPT-COLLAB-003 / PPT-COLLAB-004)', () => {
  it('rejects snapshot before the connection has completed replay', async () => {
    const h = await setup()
    const w = await h.connect({ uid: 'u_w', role: 'writer' })
    w.send({ t: 'snap', pv: 2, k: 1, epoch: 0, q: 0, doc: deck('early') })
    expect(await w.recv()).toMatchObject({ ctl: 'refused', code: 'snapshot-conflict' })
  })

  it('rejects snapshot coverage beyond this connection observed watermark', async () => {
    const h = await setup()
    const w = await h.connect({ uid: 'u_w', role: 'writer' })
    await helloReady(w)
    await h.store.appendOp(DOC, 'seed', OPS_FRAME(1, 'seed'))
    // The room high-water is 1, but this connection did not receive/ack seq 1.
    w.send({ t: 'snap', pv: 2, k: 1, epoch: 0, q: 1, doc: deck('unseen') })
    expect(await w.recv()).toMatchObject({ ctl: 'refused', code: 'snapshot-conflict' })
  })

  it('does not treat raw hello since as prune authority for a stale snapshot', async () => {
    const h = await setup()
    await h.store.appendOp(DOC, 'seed-op', OPS_FRAME(1, 'seed-op'))

    const stale = await h.connect({ uid: 'u_stale', role: 'writer' })
    const { replay } = await helloReady(stale, 1)
    expect(replay.filter((m) => m.ctl === 'op')).toHaveLength(0)

    stale.send({ t: 'snap', pv: 2, k: 1, epoch: 0, q: 1, doc: deck('stale') })
    expect(await stale.recv()).toMatchObject({ ctl: 'refused', code: 'snapshot-conflict' })
    expect((await h.store.opsSince(DOC, 0)).map((o) => o.seq)).toEqual([1])
  })

  it('client snap is server-managed (refused); the server snapshotter advances the snapshot and joiners replay it (XIN-1759 Part B)', async () => {
    // Soft threshold 1 byte → any append triggers the in-process snapshotter; a
    // baseDocProvider supplies the genesis reduction base (no client snap needed).
    const h = await setup({ baseDocProvider: async () => deck('genesis'), limits: { snapshotSoftThresholdBytes: 1 } })
    const w = await h.connect({ uid: 'u_w', role: 'writer' })
    await helloReady(w)
    for (let i = 1; i <= 3; i++) {
      w.send(OPS_FRAME(i, `f${i}`))
      await w.recvUntil((m) => m.ctl === 'ack')
    }
    // A client-provided snapshot is REFUSED as server-managed (never persisted/pruned).
    w.send({ t: 'snap', pv: 2, k: 100, epoch: 0, q: 2, doc: deck('client') })
    expect((await w.recvUntil((m) => m.ctl === 'ack' || m.ctl === 'refused')).at(-1)).toMatchObject({
      ctl: 'refused',
      code: 'snapshot-conflict',
    })
    // The SERVER snapshotter advanced a durable snapshot covering the whole log,
    // carrying BOTH doc and state, and pruned the covered ops — with NO from-scratch
    // client snapshot socket involved (Round-19 P1 replacement).
    const snap = await waitFor(async () => {
      const s = await h.store.getSnapshot(DOC)
      return s && s.coveredSeq >= 3 ? s : null
    })
    expect(snap.state).toBeTruthy()
    expect(await h.store.opsSince(DOC, 0)).toHaveLength(0)

    // A fresh joiner receives the SERVER snapshot (doc + state), then no uncovered ops.
    const joiner = await h.connect({ uid: 'u_j', role: 'reader' })
    const { replay } = await helloReady(joiner)
    expect(replay[0]!.ctl).toBe('snapshot')
    expect((replay[0] as { state?: unknown }).state).toBeTruthy()
    expect(replay.filter((m) => m.ctl === 'op')).toHaveLength(0)

    // An already-synced peer (since=coveredSeq) is NOT forced to reapply the snapshot.
    const synced = await h.connect({ uid: 'u_s', role: 'reader' })
    const { replay: r2 } = await helloReady(synced, snap.coveredSeq)
    expect(r2.some((m) => m.ctl === 'snapshot')).toBe(false)
  })

  it('offline peer reconnects with since=q and replays only the missing ops', async () => {
    const h = await setup()
    const online = await h.connect({ uid: 'u_on', role: 'writer' })
    await helloReady(online)
    // A was up to seq 1, then went offline.
    online.send(OPS_FRAME(1, 'base'))
    await online.recv()

    // While A is offline, B (here: online) commits two more ops.
    online.send(OPS_FRAME(2, 'b1'))
    await online.recv()
    online.send(OPS_FRAME(3, 'b2'))
    await online.recv()

    // A reconnects with since=1 and replays only ops 2 and 3.
    const a = await h.connect({ uid: 'u_a', role: 'writer' })
    const { replay } = await helloReady(a, 1)
    const qs = replay.filter((m) => m.ctl === 'op').map((m) => m.q)
    expect(qs).toEqual([2, 3])

    // A then flushes a queued op; it lands after 3 (both converge).
    a.send(OPS_FRAME(9, 'a-queued'))
    const ack = await a.recv()
    expect(ack.q).toBe(4)
    expect(await h.store.currentSeq(DOC)).toBe(4)
  })
})

describe('PPT relay: permission epoch (PPT-EPOCH-001 / 002 / 003)', () => {
  it('downgrade: role-changed is delivered and old-epoch ops are refused stale-epoch', async () => {
    const h = await setup()
    const a = await h.connect({ uid: 'u_a', role: 'writer' })
    const b = await h.connect({ uid: 'u_b', role: 'writer' })
    await helloReady(a)
    await helloReady(b)

    // Admin downgrades A to reader -> epoch bumps to 1.
    h.setRole('u_a', 'reader')
    h.setEpoch(1)
    await h.relay.applyEpochBump(DOCNAME)

    const rc = await a.recvUntil((m) => m.ctl === 'role-changed')
    const last = rc[rc.length - 1]!
    expect(last.role).toBe('reader')
    expect(last.epoch).toBe(1)

    // A keeps sending with the OLD epoch (0): refused stale-epoch, not persisted/broadcast.
    a.send(OPS_FRAME(1, 'stale', 0))
    const refused = await a.recv()
    expect(refused.code).toBe('stale-epoch')
    expect(refused.retryable).toBe(false)
    expect(await h.store.currentSeq(DOC)).toBe(0)
    await expect(b.recv(250)).rejects.toThrow()
  })

  it('revocation to none closes the socket 4403; doc deletion closes 4404', async () => {
    const h = await setup()
    const a = await h.connect({ uid: 'u_a', role: 'writer' })
    await helloReady(a)
    h.setRole('u_a', 'none')
    h.setEpoch(1)
    await h.relay.applyEpochBump(DOCNAME)
    expect((await a.closed).code).toBe(4403)

    const b = await h.connect({ uid: 'u_b', role: 'writer' })
    await helloReady(b)
    h.relay.closeRoomForDeleted(DOC)
    expect((await b.closed).code).toBe(4404)

    // A fresh token is refused once the doc is deleted (handshake guard).
    h.setDocStatus('deleted')
    const c = await h.connect({ uid: 'u_c', role: 'writer' })
    expect((await c.closed).code).toBe(4404)
  })

  it('upgrade requires fresh authority: the old socket stays non-mutating', async () => {
    const h = await setup()
    const r = await h.connect({ uid: 'u_r', role: 'reader' })
    await helloReady(r)

    // Reader is upgraded to writer at the source (epoch bump), but the live
    // socket must NOT gain write authority — that needs a fresh token/ticket.
    h.setRole('u_r', 'writer')
    h.setEpoch(1)
    await h.relay.applyEpochBump(DOCNAME)

    // Mutating on the old socket (even at the new epoch) is still forbidden-role.
    r.send(OPS_FRAME(1, 'up', 1))
    const refused = await r.recv()
    expect(refused.code).toBe('forbidden-role')
    expect(await h.store.currentSeq(DOC)).toBe(0)
  })

  it('buffers live delivery during pending epoch re-resolution and flushes authorized peers after reauth', async () => {
    let release!: () => void
    const gate = new Promise<void>((res) => {
      release = res
    })
    const h = await setup({
      roleProvider: async ({ uid }) => {
        if (uid === 'u_b') await gate
        return 'writer'
      },
    })
    const a = await h.connect({ uid: 'u_a', role: 'writer' })
    const b = await h.connect({ uid: 'u_b', role: 'writer' })
    await helloReady(a)
    await helloReady(b)

    h.setEpoch(1)
    const bump = h.relay.applyEpochBump(DOCNAME)
    a.send(OPS_FRAME(1, 'during-bump', 1))
    expect(await a.recv()).toMatchObject({ ctl: 'ack', q: 1 })
    await expect(b.recv(75)).rejects.toThrow()

    release()
    await bump
    expect((await b.recvUntil((m) => m.ctl === 'op')).at(-1)).toMatchObject({ ctl: 'op', q: 1 })
    expect(b.ws.readyState).toBe(WebSocket.OPEN)
  })

  it('discards buffered reads when pending epoch re-resolution revokes the peer', async () => {
    let release!: () => void
    const gate = new Promise<void>((res) => {
      release = res
    })
    const h = await setup({
      roleProvider: async ({ uid }) => {
        if (uid === 'u_b') await gate
        return uid === 'u_b' ? 'none' : 'writer'
      },
    })
    const a = await h.connect({ uid: 'u_a', role: 'writer' })
    const b = await h.connect({ uid: 'u_b', role: 'writer' })
    await helloReady(a)
    await helloReady(b)

    h.setEpoch(1)
    const bump = h.relay.applyEpochBump(DOCNAME)
    a.send(OPS_FRAME(1, 'during-revoke', 1))
    expect(await a.recv()).toMatchObject({ ctl: 'ack', q: 1 })
    await expect(b.recv(75)).rejects.toThrow()

    release()
    await bump
    expect((await b.closed).code).toBe(4403)
  })
})

describe('PPT relay: read cache and outbound backpressure', () => {
  it('caches live doc status across hot presence frames', async () => {
    let statusReads = 0
    const h = await setup({
      limits: { docStatusCacheTtlMs: 60_000, maxFramesPerWindow: 200 },
      docStatusProvider: async () => {
        statusReads++
        return 'live'
      },
    })
    const a = await h.connect({ uid: 'u_a', role: 'writer' })
    const b = await h.connect({ uid: 'u_b', role: 'reader' })
    await helloReady(a)
    await helloReady(b)
    statusReads = 0

    for (let i = 0; i < 50; i++) a.send({ t: 'p', pv: 2, presence: { i } })
    const seen = await b.recvUntil((m) => m.ctl === 'presence' && (m.presence as { i?: number } | undefined)?.i === 49)
    expect(seen.filter((m) => m.ctl === 'presence')).toHaveLength(50)
    expect(statusReads).toBeLessThanOrEqual(1)
  })

  it('applies the send high-water policy to live broadcasts', async () => {
    const relay = new PptRelay({
      store: new InMemoryPptRelayStore(),
      epochProvider: async () => 0,
      limits: { sendHighWaterBytes: 0, sendDrainTimeoutMs: 15 },
    })
    const closed: Array<{ code: number; reason: string }> = []
    const fakeSocket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 1,
      send: vi.fn(),
      close: (code: number, reason: string) => {
        closed.push({ code, reason })
        fakeSocket.readyState = WebSocket.CLOSING
      },
    }
    const peer = {
      socket: fakeSocket,
      uid: 'u_slow',
      docId: DOC,
      documentName: DOCNAME,
      role: 'reader',
      roleEpoch: 0,
      spaceMember: false,
      frameTimes: [],
      ephemeralFrameTimes: [],
      caughtUp: true,
      replayInFlight: false,
      replayPending: null,
      liveBuffer: [],
      deliveredThrough: 0,
      flushDepth: 0,
      liveBufferBytes: 0,
      auth: { readAllowed: true, invalidated: false },
      inboundChain: Promise.resolve(),
      outboundChain: Promise.resolve(),
      drainChain: Promise.resolve(),
    }
    await (relay as unknown as { deliver: (conn: unknown, frame: unknown) => Promise<void> }).deliver(peer, { ctl: 'op', q: 1, frame: OPS_FRAME(1, 'live') })
    expect(closed).toEqual([{ code: 1011, reason: 'send drain timeout' }])
    expect(fakeSocket.send).not.toHaveBeenCalled()
    relay.close()
  })

  it('preserves live broadcast order when a slow peer drains between a concurrent burst', async () => {
    const relay = new PptRelay({
      store: new InMemoryPptRelayStore(),
      epochProvider: async () => 0,
      limits: { sendHighWaterBytes: 0, sendDrainTimeoutMs: 250 },
    })
    const sent: unknown[] = []
    const fakeSocket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 1,
      send: vi.fn((raw: string) => {
        sent.push(JSON.parse(raw))
      }),
      close: vi.fn(),
    }
    const peer = {
      socket: fakeSocket,
      uid: 'u_slow',
      docId: DOC,
      documentName: DOCNAME,
      role: 'reader',
      roleEpoch: 0,
      spaceMember: false,
      frameTimes: [],
      ephemeralFrameTimes: [],
      caughtUp: true,
      replayInFlight: false,
      replayPending: null,
      liveBuffer: [],
      deliveredThrough: 0,
      flushDepth: 0,
      liveBufferBytes: 0,
      auth: { readAllowed: true, invalidated: false },
      inboundChain: Promise.resolve(),
      outboundChain: Promise.resolve(),
      drainChain: Promise.resolve(),
    }

    const deliver = (relay as unknown as { deliver: (conn: unknown, frame: unknown) => Promise<void> }).deliver.bind(relay)
    const first = deliver(peer, { ctl: 'op', q: 1, frame: OPS_FRAME(1, 'ordered-1') })
    await sleep(20)
    const second = deliver(peer, { ctl: 'op', q: 2, frame: OPS_FRAME(2, 'ordered-2') })
    await sleep(20)
    fakeSocket.bufferedAmount = 0
    await Promise.all([first, second])

    expect(sent.map((m) => (m as { q?: number }).q)).toEqual([1, 2])
    relay.close()
  })
})

describe('PPT relay: stale-ticket epoch cutoff fails CLOSED (PPT-EPOCH-001 regression)', () => {
  // A ticket carries the role/epoch snapshot from issuance. If the live epoch has
  // moved on (downgrade / revocation) BEFORE the socket connects, the ticket's
  // cached role must not seed write authority — the connection role is re-resolved
  // server-side at connect and can never be refreshed by the epoch the client
  // stamps on a frame.
  it('(a) stale writer ticket + downgraded-to-reader: ops stamped with the CURRENT epoch is REFUSED', async () => {
    const h = await setup({ limits: { docStatusCacheTtlMs: 0 } })
    // The user was a writer at epoch 0, then downgraded to reader at epoch 1.
    h.setEpoch(1)
    h.setRole('u_a', 'reader')
    // Ticket was minted at epoch 0 with role=writer (the pre-downgrade snapshot).
    const staleTicket = h.ticketFor({ uid: 'u_a', role: 'writer', epoch: 0 })
    const c = await h.connect({ uid: 'u_a', role: 'writer', ticket: staleTicket })

    // At connect the relay re-resolves the LIVE role: the socket is a reader now.
    const { ready } = await helloReady(c)
    expect(ready.role).toBe('reader')
    expect(ready.epoch).toBe(1)

    // The attack: stamp the CURRENT epoch (1) on the frame so the live-epoch check
    // passes. It must STILL be refused forbidden-role — the stale writer role is
    // gone — and nothing is persisted or broadcast.
    c.send(OPS_FRAME(1, 'bypass', 1))
    const refused = await c.recv()
    expect(refused.ctl).toBe('refused')
    expect(refused.code).toBe('forbidden-role')
    expect(refused.retryable).toBe(false)
    expect(await h.store.currentSeq(DOC)).toBe(0)
  })

  it('(b) stale ticket for a revoked (none) user: the socket is closed 4403 at connect', async () => {
    const h = await setup()
    h.setEpoch(1)
    h.setRole('u_b', 'none')
    const staleTicket = h.ticketFor({ uid: 'u_b', role: 'writer', epoch: 0 })
    const c = await h.connect({ uid: 'u_b', role: 'writer', ticket: staleTicket })
    expect((await c.closed).code).toBe(4403)
    expect(await h.store.currentSeq(DOC)).toBe(0)
  })

  it('(c) positive control: a legitimately-still-writer connection at the current epoch works', async () => {
    const h = await setup()
    h.setEpoch(1)
    h.setRole('u_c', 'writer')
    // Fresh ticket minted at the current epoch (1): trusted authority.
    const c = await h.connect({ uid: 'u_c', role: 'writer' })
    const { ready } = await helloReady(c)
    expect(ready.role).toBe('writer')
    expect(ready.epoch).toBe(1)

    c.send(OPS_FRAME(1, 'ok', 1))
    const ack = await c.recv()
    expect(ack.ctl).toBe('ack')
    expect(ack.q).toBe(1)
    expect(await h.store.currentSeq(DOC)).toBe(1)
  })

  it('a stale ticket whose user is STILL a writer re-resolves to writer and may mutate (no over-rejection)', async () => {
    const h = await setup()
    h.setEpoch(2)
    h.setRole('u_d', 'writer') // still a writer at the live epoch
    const staleTicket = h.ticketFor({ uid: 'u_d', role: 'writer', epoch: 0 })
    const c = await h.connect({ uid: 'u_d', role: 'writer', ticket: staleTicket })
    const { ready } = await helloReady(c)
    expect(ready.role).toBe('writer')

    c.send(OPS_FRAME(1, 'ok', 2))
    const ack = await c.recv()
    expect(ack.ctl).toBe('ack')
    expect(ack.q).toBe(1)
    expect(await h.store.currentSeq(DOC)).toBe(1)
  })

  it('per-frame guard: a downgrade after connect is enforced even without applyEpochBump', async () => {
    const h = await setup()
    // Connect as a legitimate writer at epoch 0 (fresh ticket).
    const c = await h.connect({ uid: 'u_e', role: 'writer' })
    await helloReady(c)

    // Downgrade at the source and bump the epoch, but DO NOT push applyEpochBump —
    // simulate the bump signal being missed. A frame stamped with the new live
    // epoch must not ride the cached writer role.
    h.setRole('u_e', 'reader')
    h.setEpoch(1)
    c.send(OPS_FRAME(1, 'lazy', 1))
    const refused = await c.recv()
    expect(refused.ctl).toBe('refused')
    expect(refused.code).toBe('forbidden-role')
    expect(await h.store.currentSeq(DOC)).toBe(0)
  })
})

describe('PPT relay: share-aware role re-resolution (B6 / P1-7)', () => {
  // A resolver that mirrors the PRODUCTION seam: a space-share member with no
  // doc_member row resolves to `writer` ONLY when the connection carried a
  // positive `space_member` claim — a direct-only resolver would return `none`
  // and wrongly revoke a legitimate share writer after any epoch bump.
  const shareResolver = async (ctx: {
    uid: string
    docId: string
    documentName: string
    spaceMember: boolean
  }): Promise<ResolvedRole> => {
    expect(ctx.docId).toBe(DOC)
    expect(ctx.documentName).toBe(DOCNAME)
    return ctx.spaceMember ? 'writer' : 'none'
  }

  it('a stale-epoch ticket for a share writer re-resolves to writer (not revoked) when space_member is carried', async () => {
    const h = await setup({ roleProvider: shareResolver })
    h.setEpoch(1) // live epoch advanced past the ticket's epoch 0
    // A legitimate ticket minted before the bump, carrying the space_member claim.
    const ticket = issuePptCollabToken({
      uid: 'u_share',
      docId: DOC,
      documentName: DOCNAME,
      role: 'writer',
      permission_epoch: 0,
      snapshotVersion: 0,
      spaceMember: true,
    }).ticket
    const c = await h.connect({ uid: 'u_share', role: 'writer', ticket })
    const { ready } = await helloReady(c)
    expect(ready.role).toBe('writer') // re-resolved via the share path, not revoked
    // And it can actually mutate at the live epoch.
    c.send(OPS_FRAME(1, 'sh1', 1))
    expect(await c.recv()).toMatchObject({ ctl: 'ack', q: 1 })
  })

  it('a stale-epoch ticket for a non-member fails closed (4403)', async () => {
    const h = await setup({ roleProvider: shareResolver })
    h.setEpoch(1)
    const ticket = issuePptCollabToken({
      uid: 'u_out',
      docId: DOC,
      documentName: DOCNAME,
      role: 'writer',
      permission_epoch: 0,
      snapshotVersion: 0,
      spaceMember: false,
    }).ticket
    const c = await h.connect({ uid: 'u_out', role: 'writer', ticket })
    expect((await c.closed).code).toBe(4403)
  })
})

describe('PPT relay: doc-deletion closes the room 4404 via the invalidate signal (B5)', () => {
  it('applyEpochBump closes live sockets with 4404 when the doc is deleted', async () => {
    const h = await setup()
    const a = await h.connect({ uid: 'u_a', role: 'writer' })
    const b = await h.connect({ uid: 'u_b', role: 'reader' })
    await helloReady(a)
    await helloReady(b)
    // Doc soft-delete bumps the epoch and publishes the same invalidate event
    // that drives applyEpochBump; the relay must close 4404 (not 4403).
    h.setDocStatus('deleted')
    await h.relay.applyEpochBump(DOCNAME)
    expect((await a.closed).code).toBe(4404)
    expect((await b.closed).code).toBe(4404)
    expect(h.relay.roomSize(DOC)).toBe(0)
  })
})

describe('PPT relay: no silent drops post-commit (B7 / P1-12)', () => {
  it('an op still ACKs when the durable write succeeded but the snapshot read throws', async () => {
    const base = new InMemoryPptRelayStore()
    const store: PptRelayStore = {
      appendOp: (d, f, fr) => base.appendOp(d, f, fr),
      frameSeq: (d, f) => base.frameSeq(d, f),
      opsSince: (d, s, l) => base.opsSince(d, s, l),
      currentSeq: (d) => base.currentSeq(d),
      roomBytes: (d) => base.roomBytes(d),
      getSnapshot: async (d) => {
        // Fail the post-commit snapshot read (there is a persisted op by then),
        // but let the pre-op replay read succeed so the client reaches `ready`.
        if ((await base.currentSeq(d)) > 0) throw new Error('snapshot read down')
        return base.getSnapshot(d)
      },
      saveSnapshot: (i) => base.saveSnapshot(i),
      pruneOpsThrough: (d, c) => base.pruneOpsThrough(d, c),
    }
    const h = await setup({ store })
    const w = await h.connect({ uid: 'u_w', role: 'writer' })
    await helloReady(w)
    w.send(OPS_FRAME(7, 'commit1'))
    const ack = await w.recv()
    expect(ack.ctl).toBe('ack') // durable op is acked despite the snapshot read failing
    expect(ack.q).toBe(1)
    expect(await base.currentSeq(DOC)).toBe(1)
  })

  it('the server snapshotter keeps the snapshot durable even if the post-save prune throws', async () => {
    const base = new InMemoryPptRelayStore()
    const store: PptRelayStore = {
      appendOp: (d, f, fr) => base.appendOp(d, f, fr),
      frameSeq: (d, f) => base.frameSeq(d, f),
      opsSince: (d, s, l) => base.opsSince(d, s, l),
      currentSeq: (d) => base.currentSeq(d),
      roomBytes: (d) => base.roomBytes(d),
      getSnapshot: (d) => base.getSnapshot(d),
      saveSnapshot: (i) => base.saveSnapshot(i),
      pruneOpsThrough: async () => {
        throw new Error('prune down')
      },
    }
    // Soft threshold 1 → the server snapshotter runs after the first append.
    const h = await setup({ store, baseDocProvider: async () => deck('genesis'), limits: { snapshotSoftThresholdBytes: 1 } })
    const w = await h.connect({ uid: 'u_w', role: 'writer' })
    await helloReady(w)
    w.send(OPS_FRAME(1, 'op1'))
    await w.recvUntil((m) => m.ctl === 'ack')
    // The snapshot is durable (saved BEFORE the prune) even though GC threw; the
    // failure is swallowed by the soft path and the room simply retries GC later.
    const snap = await waitFor(async () => {
      const s = await base.getSnapshot(DOC)
      return s && s.coveredSeq >= 1 ? s : null
    })
    expect(snap.snapshotVersion).toBe(1)
    expect(snap.state).toBeTruthy()
  })
})

describe('PPT relay: byte-accurate limits + binding blob cap (non-blocking)', () => {
  it('measures UTF-8 bytes, not code units, for the frame-size limit', async () => {
    // Each 4-byte emoji is one UTF-16 surrogate pair (2 code units). A frame whose
    // real UTF-8 size exceeds the cap but whose `raw.length` does not must still be
    // refused too-large.
    const h = await setup({ limits: { maxFrameBytes: 200 } })
    const w = await h.connect({ uid: 'u_w', role: 'writer' })
    await helloReady(w)
    const bigValue = '😀'.repeat(60) // 240 UTF-8 bytes, 120 UTF-16 code units
    w.send({ t: 'ops', pv: 2, k: 1, frameId: 'big', epoch: 0, ops: [{ op: 'set', a: 'u-test', s: 1, l: 1, k: 'text', v: bigValue }] })
    expect(await w.recv()).toMatchObject({ code: 'too-large', retryable: false })
  })

  it('an op frame over the op-byte cap is refused too-large; a client snapshot is refused server-managed', async () => {
    // maxFrameBytes (op cap) is small. Op frames over it are refused; client
    // snapshots are no longer a persisted path at all (server-managed, XIN-1759).
    const h = await setup({ limits: { maxFrameBytes: 300, maxSingleBlobBytes: 200_000 } })
    const w = await h.connect({ uid: 'u_w', role: 'writer' })
    await helloReady(w)
    // An op frame over the 300-byte op cap: refused.
    w.send({ t: 'ops', pv: 2, k: 1, frameId: 'bigop', epoch: 0, ops: [{ op: 'set', a: 'u-test', s: 1, l: 1, k: 'p', v: 'x'.repeat(400) }] })
    expect(await w.recv()).toMatchObject({ code: 'too-large' })
    // A client snapshot of any size is refused as server-managed (never persisted).
    const big = deck('x'.repeat(400))
    w.send({ t: 'snap', pv: 2, k: 2, epoch: 0, q: 0, doc: big })
    expect(await w.recv()).toMatchObject({ ctl: 'refused', code: 'snapshot-conflict' })
  })

  it('room-full budget is seeded from durable state so a fresh process counts existing ops', async () => {
    const store = new InMemoryPptRelayStore()
    // Seed durable ops totalling some bytes BEFORE any socket connects (models a
    // process that restarted with a non-empty room).
    await store.appendOp(DOC, 'seed1', { t: 'ops', ops: [{ op: 'set', a: 'u-test', s: 1, l: 1, k: 'p', v: 'y'.repeat(400) }] })
    const seeded = await store.roomBytes(DOC)
    expect(seeded).toBeGreaterThan(0)
    const h = await setup({ store, limits: { maxRoomFrameBytes: seeded + 10 } })
    const w = await h.connect({ uid: 'u_w', role: 'writer' })
    await helloReady(w)
    // The very first frame this process sees would fit if the counter started at
    // 0, but seeding from durable state pushes it over the room cap.
    w.send({ t: 'ops', pv: 2, k: 1, frameId: 'over', epoch: 0, ops: [{ op: 'set', a: 'u-test', s: 1, l: 1, k: 'p', v: 'z'.repeat(50) }] })
    expect(await w.recv()).toMatchObject({ code: 'room-full', retryable: false })
  })
})

/**
 * XIN-1655 GitHub round-3 blockers: per-room ordered broadcast (C2), replay
 * failure surfacing (C4), replay-cursor coordinate (C5), and ready.q semantics
 * (C6). Driven against the same real ws server + client harness as the suite above.
 */
describe('PPT relay: round-3 correctness fixes (XIN-1655)', () => {
  it('C2: concurrent live appends broadcast in assigned seq order (per-room serialization)', async () => {
    // A store whose FIRST snapshot read after arming is slow. In the pre-fix code
    // handleOps allocated the seq, then awaited getSnapshot before broadcasting, so
    // a later frame with a fast read could broadcast q=2 before q=1. The per-room
    // serialization chain forces f1's whole persist->ack->broadcast to finish first.
    class SlowFirstSnapshotStore extends InMemoryPptRelayStore {
      armed = false
      private calls = 0
      async getSnapshot(docId: string) {
        if (this.armed) {
          this.calls++
          if (this.calls === 1) await new Promise((r) => setTimeout(r, 60))
        }
        return super.getSnapshot(docId)
      }
    }
    const store = new SlowFirstSnapshotStore()
    const h = await setup({ store })
    const w = await h.connect({ uid: 'u_w', role: 'writer' })
    const p = await h.connect({ uid: 'u_p', role: 'writer' })
    await helloReady(w)
    await helloReady(p)
    store.armed = true // the first ack-time snapshot read (f1's) is now slow
    w.send(OPS_FRAME(1, 'f1'))
    w.send(OPS_FRAME(2, 'f2'))
    // Peer observes op broadcasts; recvUntil stops at q=2, so an out-of-order q=2
    // (arriving before q=1) would yield [2] and fail the assertion.
    const seen = await p.recvUntil((m) => m.ctl === 'op' && m.q === 2)
    const qs = seen.filter((m) => m.ctl === 'op').map((m) => m.q)
    expect(qs).toEqual([1, 2])
  })

  it('C4: a store failure during replay surfaces a refused + closes, never a silent hang', async () => {
    const boom = new Error('store down')
    const throwing: PptRelayStore = {
      appendOp: async () => { throw boom },
      frameSeq: async () => { throw boom },
      opsSince: async () => { throw boom },
      currentSeq: async () => { throw boom },
      roomBytes: async () => { throw boom },
      getSnapshot: async () => { throw boom },
      saveSnapshot: async () => { throw boom },
      pruneOpsThrough: async () => { throw boom },
    }
    const h = await setup({ store: throwing })
    const c = await h.connect({ uid: 'u1', role: 'writer' })
    c.send({ t: 'hello', pv: 2, since: 0 })
    // Before the fix replay() rejected inside a void-ed onMessage, so the client
    // got neither ready nor refused and hung. Now it gets a permanent refusal + close.
    const refused = await c.recv()
    expect(refused).toMatchObject({ ctl: 'refused', code: 'storage-failed', retryable: false })
    expect((await c.closed).code).toBe(1011)
  })

  it('C5: replay `since` is an op-seq boundary (coveredSeq), independent of snapshotVersion', async () => {
    const store = new InMemoryPptRelayStore()
    await store.appendOp(DOC, 'f1', OPS_FRAME(1, 'f1'))
    // Drive snapshotVersion ABOVE coveredSeq (two saves at the same covered seq),
    // so the two coordinate systems visibly diverge.
    await store.saveSnapshot({ docId: DOC, coveredSeq: 1, doc: deck() })
    await store.saveSnapshot({ docId: DOC, coveredSeq: 1, doc: deck() })
    const snap = await store.getSnapshot(DOC)
    expect(snap!.snapshotVersion).toBe(2)
    expect(snap!.coveredSeq).toBe(1)
    await store.appendOp(DOC, 'f2', OPS_FRAME(2, 'f2')) // op past the snapshot boundary

    const h = await setup({ store })
    // Fresh joiner (since=0): snapshot + EVERY op after coveredSeq(1). Treating the
    // cursor as snapshotVersion(2) would skip op seq 2 entirely.
    const c = await h.connect({ uid: 'u1', role: 'writer' })
    const { ready, replay } = await helloReady(c, 0)
    expect(replay[0]!.ctl).toBe('snapshot')
    expect(replay.filter((m) => m.ctl === 'op').map((m) => m.q)).toEqual([2])
    expect(ready.snapshotVersion).toBe(2) // version tag surfaced as-is
    expect(ready.q).toBe(2) // synced through op seq 2

    // A reconnect resuming at the op boundary (since=coveredSeq=1) skips the
    // snapshot and replays only the tail op — proving `since` is an op sequence.
    const c2 = await h.connect({ uid: 'u2', role: 'writer' })
    const { replay: replay2 } = await helloReady(c2, 1)
    expect(replay2.some((m) => m.ctl === 'snapshot')).toBe(false)
    expect(replay2.filter((m) => m.ctl === 'op').map((m) => m.q)).toEqual([2])
  })

  it('C6: ready.q is the last op actually delivered, not the counter high-water', async () => {
    // A counter far ahead of the delivered ops (models a seq allocated by an
    // append not yet visible to opsSince). Pre-fix ready.q came from currentSeq()
    // and would over-report, making the client skip an op it never received.
    class InflatedCounterStore extends InMemoryPptRelayStore {
      async currentSeq(): Promise<number> {
        return 999
      }
    }
    const store = new InflatedCounterStore()
    for (const f of ['f1', 'f2', 'f3']) await store.appendOp(DOC, f, OPS_FRAME(1, f))
    const h = await setup({ store })
    const c = await h.connect({ uid: 'u1', role: 'writer' })
    const { ready, replay } = await helloReady(c, 0)
    expect(replay.filter((m) => m.ctl === 'op').map((m) => m.q)).toEqual([1, 2, 3])
    expect(ready.q).toBe(3) // last delivered op, NOT currentSeq()=999
  })
})

/**
 * XIN-1660 GitHub round-4 blockers + hardening: known-duplicate resend bypasses the
 * room-full / rate gates (D3), handleSnap preflight reads are guarded so a storage
 * failure surfaces instead of hanging (D4), ephemeral frames are byte-capped and
 * rate-limited, replay is paginated, and the client-supplied resume cursor is
 * clamped to the real delivered boundary.
 */
describe('PPT relay: round-4 fixes (XIN-1660)', () => {
  // Compute the persisted byte size of an ops frame exactly as handleOps does, so a
  // test can pin a room/rate budget to "one frame".
  const frameBytes = (frame: unknown): number => Buffer.byteLength(JSON.stringify(frame), 'utf8')

  it('D3: a known-duplicate resend at the room-full cap is re-acked, not refused room-full', async () => {
    const first = OPS_FRAME(1, 'dup-room')
    const h = await setup({ limits: { maxRoomFrameBytes: frameBytes(first) } })
    const w = await h.connect({ uid: 'u_w', role: 'writer' })
    await helloReady(w)

    // First frame fills the room exactly to the cap.
    w.send(first)
    expect((await w.recv()).q).toBe(1)

    // A brand-new frame now exceeds the cap -> permanent room-full.
    w.send(OPS_FRAME(2, 'new-over'))
    expect(await w.recv()).toMatchObject({ code: 'room-full', retryable: false })

    // But RESENDING the already-durable frame (its ack was "lost") must bypass the
    // room-full gate and re-ack its original seq — the idempotent-resend contract.
    w.send(OPS_FRAME(1, 'dup-room'))
    const reack = await w.recv()
    expect(reack.ctl).toBe('ack')
    expect(reack.q).toBe(1)
    expect(await h.store.currentSeq(DOC)).toBe(1) // no new seq minted
  })

  it('D3: a known-duplicate resend when the rate window is full is re-acked, not refused rate-limited', async () => {
    const h = await setup({ limits: { maxFramesPerWindow: 1 } })
    const w = await h.connect({ uid: 'u_w', role: 'writer' })
    await helloReady(w)

    // The single rate slot is consumed by the first (new) frame.
    w.send(OPS_FRAME(1, 'dup-rate'))
    expect((await w.recv()).q).toBe(1)

    // A brand-new frame is now rate-limited (the ONLY retryable refusal).
    w.send(OPS_FRAME(2, 'new-rl'))
    expect(await w.recv()).toMatchObject({ code: 'rate-limited', retryable: true })

    // Resending the durable frame bypasses the rate gate and re-acks.
    w.send(OPS_FRAME(1, 'dup-rate'))
    const reack = await w.recv()
    expect(reack.ctl).toBe('ack')
    expect(reack.q).toBe(1)
  })

  it('a client snap is refused server-managed without any store read (no preflight to fail)', async () => {
    // handleSnap no longer does a preflight read or persists (XIN-1759 Part B):
    // snapshots are server-managed, so a client snap is refused up front and a
    // failing store is never even touched by the snap path.
    class SnapReadFailStore extends InMemoryPptRelayStore {
      failCurrentSeq = false
      failGetSnapshot = false
      override async currentSeq(docId: string): Promise<number> {
        if (this.failCurrentSeq) throw new Error('currentSeq down')
        return super.currentSeq(docId)
      }
      override async getSnapshot(docId: string): ReturnType<InMemoryPptRelayStore['getSnapshot']> {
        if (this.failGetSnapshot) throw new Error('getSnapshot down')
        return super.getSnapshot(docId)
      }
    }
    const s1 = new SnapReadFailStore()
    const h1 = await setup({ store: s1 })
    const w1 = await h1.connect({ uid: 'u_w', role: 'writer' })
    await helloReady(w1)
    s1.failCurrentSeq = true
    s1.failGetSnapshot = true
    w1.send({ t: 'snap', pv: 2, k: 5, epoch: 0, q: 0, doc: deck() })
    // Refused as server-managed — NOT storage-failed — because no store read runs.
    expect(await w1.recv()).toMatchObject({ ctl: 'refused', code: 'snapshot-conflict' })
  })

  it('hardening: an oversized ephemeral frame is refused too-large', async () => {
    const h = await setup({ limits: { maxEphemeralFrameBytes: 80 } })
    const c = await h.connect({ uid: 'u_e', role: 'writer' })
    await helloReady(c)
    // A presence frame whose wire size exceeds the ephemeral cap.
    c.send({ t: 'p', pv: 2, presence: { cursor: 'x'.repeat(200) } })
    expect(await c.recv()).toMatchObject({ code: 'too-large', retryable: false })
  })

  it('hardening: ephemeral frames are rate-limited in a window SEPARATE from ops', async () => {
    const h = await setup({ limits: { maxFramesPerWindow: 2 } })
    const c = await h.connect({ uid: 'u_e', role: 'writer' })
    // helloReady sends one ephemeral `hello` (window now holds 1).
    await helloReady(c)
    // One more ephemeral `p` fills the window (holds 2); the next is rate-limited.
    c.send({ t: 'p', pv: 2, presence: { c: 1 } })
    c.send({ t: 'p', pv: 2, presence: { c: 2 } })
    expect(await c.recv()).toMatchObject({ code: 'rate-limited', retryable: true })

    // The OPS window is separate: a persisted op still gets through despite the
    // ephemeral window being full.
    c.send(OPS_FRAME(1, 'ops-after-ephemeral-rl'))
    expect(await c.recv()).toMatchObject({ ctl: 'ack', q: 1 })
  })

  it('hardening: replay streams a backlog larger than the page size, in order and complete', async () => {
    const store = new InMemoryPptRelayStore()
    for (let i = 1; i <= 5; i++) await store.appendOp(DOC, `f${i}`, OPS_FRAME(i, `f${i}`))
    const h = await setup({ store, limits: { replayPageSize: 2 } }) // 5 ops across 3 pages
    const c = await h.connect({ uid: 'u1', role: 'writer' })
    const { ready, replay } = await helloReady(c, 0)
    expect(replay.filter((m) => m.ctl === 'op').map((m) => m.q)).toEqual([1, 2, 3, 4, 5])
    expect(ready.q).toBe(5)
  })

  it('P2-e: a resume cursor above the room high-water is refused (protocol error), not clamped', async () => {
    const store = new InMemoryPptRelayStore()
    for (const f of ['f1', 'f2', 'f3']) await store.appendOp(DOC, f, OPS_FRAME(1, f))
    const h = await setup({ store })
    const c = await h.connect({ uid: 'u1', role: 'writer' })
    // Client claims to be synced through seq 99999 (above the real high-water 3).
    // Such a cursor cannot arise legitimately (the counter never regresses), so it
    // is refused as a protocol error rather than clamped and endorsed back in
    // ready.q (which would make the client skip every op below it).
    c.send({ t: 'hello', pv: 2, since: 99999 })
    expect(await c.recv()).toMatchObject({ ctl: 'refused', code: 'protocol-version', retryable: false })

    // A subsequent hello with a valid cursor still replays normally (the refusal
    // did not wedge the connection).
    const { ready, replay } = await helloReady(c, 0)
    expect(replay.filter((m) => m.ctl === 'op').map((m) => m.q)).toEqual([1, 2, 3])
    expect(ready.q).toBe(3)
  })

  it('P0-1: a snap with a fractional / non-integer q is refused (protocol error), not silently rounded', async () => {
    const store = new InMemoryPptRelayStore()
    const h = await setup({ store })
    const w = await h.connect({ uid: 'u_w', role: 'writer' })
    await helloReady(w)
    // Commit op seq 1, then op seq 2.
    w.send(OPS_FRAME(1, 'op1'))
    expect((await w.recv()).q).toBe(1)
    w.send(OPS_FRAME(2, 'op2'))
    expect((await w.recv()).q).toBe(2)

    // A snapshot with a FRACTIONAL covered seq (q=1.5). Before the fix this passed
    // the number guards and MySQL rounded it to 2, pruning op 2 while the doc only
    // covered op 1 — silently destroying a co-editor's committed op. It must be
    // refused as a protocol error up front.
    w.send({ t: 'snap', pv: 2, k: 9, epoch: 0, q: 1.5, doc: deck() })
    expect(await w.recv()).toMatchObject({ ctl: 'refused', code: 'protocol-version', retryable: false })

    // Op 2 survives: a fresh joiner still replays it (never pruned by the bad snap).
    const joiner = await h.connect({ uid: 'u_j', role: 'writer' })
    const { replay } = await helloReady(joiner, 0)
    expect(replay.filter((m) => m.ctl === 'op').map((m) => m.q)).toContain(2)
  })

  it('P0-1/P2-h: an over-length frameId and a non-integer k are refused at parse (protocol error)', async () => {
    const h = await setup()
    const w = await h.connect({ uid: 'u_w', role: 'writer' })
    await helloReady(w)
    // frameId longer than the VARCHAR(64) dedup column.
    w.send({ ...OPS_FRAME(1, 'x'.repeat(65)) })
    expect(await w.recv()).toMatchObject({ ctl: 'refused', code: 'protocol-version', retryable: false })
    // Non-integer frame counter k.
    w.send({ t: 'ops', pv: 2, k: 1.5, frameId: 'kfrac', epoch: 0, ops: [{ op: 'set', a: 'u-test', s: 1, l: 1, k: 'x', v: 1 }] })
    expect(await w.recv()).toMatchObject({ ctl: 'refused', code: 'protocol-version', retryable: false })
  })

  it('hardening: an upgrade on a non-relay path is rejected (socket destroyed)', async () => {
    const h = await setup()
    await expect(h.connect({ uid: 'u1', role: 'writer', path: '/not/the/relay' })).rejects.toThrow()
  })

  it('hardening: the relay negotiates the ppt-relay subprotocol (ticket is never echoed)', async () => {
    const h = await setup()
    const c = await h.connect({ uid: 'u1', role: 'writer' })
    expect(c.ws.protocol).toBe('ppt-relay')
    c.close()
  })
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * XIN-1693 round-6 blockers: read-path authz (P1-2), read-path membership
 * fail-close (P1-6), the handshake listener race (Jerry-Xin), replay coalescing
 * (P1-3), and the live-frame buffering that keeps replay idempotent (P1-4).
 */
describe('PPT relay: round-6 fixes (XIN-1693)', () => {
  it('P1-5: storage-retry is a retryable refusal code; storage-failed stays permanent', () => {
    expect(isRetryable('storage-retry')).toBe(true)
    expect(isRetryable('rate-limited')).toBe(true)
    expect(isRetryable('storage-failed')).toBe(false)
  })

  it('P1-2: hello on a soft-deleted doc is refused doc-deleted + closed 4404, not served', async () => {
    const h = await setup({ limits: { docStatusCacheTtlMs: 0 } })
    const c = await h.connect({ uid: 'u_r', role: 'reader' })
    await helloReady(c) // healthy while live
    h.setDocStatus('deleted')
    c.send({ t: 'hello', pv: 2, since: 0 })
    expect(await c.recv()).toMatchObject({ ctl: 'refused', code: 'doc-deleted' })
    expect((await c.closed).code).toBe(4404)
  })

  it('P1-2: hello on a connection revoked (role -> none) after an epoch bump is refused + closed 4403', async () => {
    const h = await setup()
    const c = await h.connect({ uid: 'u_w', role: 'writer' })
    await helloReady(c)
    // Revoke after connect: the live epoch advances and the role resolves to none.
    h.setRole('u_w', 'none')
    h.setEpoch(1)
    c.send({ t: 'hello', pv: 2, since: 0 })
    expect(await c.recv()).toMatchObject({ ctl: 'refused', code: 'forbidden-role' })
    expect((await c.closed).code).toBe(4403)
  })

  it('P1-6: the read path fail-closes (4403) when a frozen space-membership claim becomes load-bearing after an epoch bump', async () => {
    // Share writer: writer ONLY via the space_member claim (no direct role).
    const h = await setup({
      roleProvider: async ({ spaceMember }) => (spaceMember ? 'writer' : 'none'),
    })
    const ticket = issuePptCollabToken({
      uid: 'u_share',
      docId: DOC,
      documentName: DOCNAME,
      role: 'writer',
      permission_epoch: 0,
      snapshotVersion: 0,
      spaceMember: true,
    }).ticket
    const c = await h.connect({ uid: 'u_share', role: 'writer', ticket })
    await helloReady(c) // connect-time trusts the fresh claim (B6)
    // An epoch bump ages the frozen claim. The relay cannot re-derive fresh
    // membership on a live socket, and the claim is load-bearing (writer WITH it,
    // none WITHOUT), so the read path fails closed rather than trust it (P1-6).
    h.setEpoch(1)
    c.send({ t: 'hello', pv: 2, since: 0 })
    expect((await c.closed).code).toBe(4403)
  })

  it('fails a share-membership socket closed after the reauth grace — for BOTH read and write — when no fresh ticket arrives, at production timing (authRefreshMs < reauthGraceMs)', async () => {
    // XIN-1739 P0-1: the ticket TTL no longer hard-disconnects a share-derived
    // socket (the old connect/replay/close loop). It enters pending-reauth and
    // fails closed only if no in-place `reauth` arrives within the grace window —
    // the SAME security bound (cannot read OR write indefinitely without fresh
    // membership), enforced by a bounded re-verify window.
    //
    // Pinned at PRODUCTION timing: authRefreshMs (100) < reauthGraceMs (1600), so
    // the periodic read-auth refresh fires 1-2× INSIDE every grace window (the real
    // default ordering, 5000 < 10000). On head 5fb58629 that refresh silently
    // cleared `pendingReauth` (its unconditional `conn.auth = { readAllowed:true }`),
    // so the grace timer fired into a no-op, the socket kept writer authority, and a
    // write was acked — this test times out / gets an ack instead of a refusal+close.
    // The old compressed timings (grace 200 < refresh 5000) inverted the ratio so the
    // refresh never fired in the window and masked the bug.
    const h = await setup({
      roleProvider: async ({ spaceMember }) => (spaceMember ? 'writer' : 'none'),
      limits: { reauthGraceMs: 1600, authRefreshMs: 100 },
    })
    const ticket = jwt.sign({
      uid: 'u_share_ttl',
      docId: DOC,
      documentName: DOCNAME,
      role: 'writer',
      permission_epoch: 0,
      space_member: true,
      jti: randomUUID(),
    }, config.collabToken.secret, {
      algorithm: 'HS256',
      audience: PPT_RELAY_TICKET_AUD,
      expiresIn: 1,
    })
    const c = await h.connect({ uid: 'u_share_ttl', role: 'writer', ticket })
    await helloReady(c)
    // Wait past the 1s ticket expiry (well inside the 1600ms grace). Several 100ms
    // read-auth refreshes fire in this interval; on the fixed head they PRESERVE the
    // now-sticky pending-reauth state instead of clearing it.
    await sleep(1200)
    // A write during the grace window is fail-closed (neither read nor write). On
    // 5fb58629 the refresh had cleared pendingReauth, so this frame was persisted and
    // acked; the sticky flag + the identity/mutation gate refuse it instead.
    c.send(OPS_FRAME(1, 'pending-reauth-write', 0))
    const w = await c.recvUntil((m) => m.ctl === 'ack' || m.ctl === 'refused')
    expect(w[w.length - 1]).toMatchObject({ ctl: 'refused', code: 'forbidden-role' })
    // And the socket fails closed when the grace elapses with no fresh ticket.
    expect((await c.closed).code).toBe(4403)
  })

  it('keeps direct-authority sockets open at ticket TTL when the space-member claim is not load-bearing', async () => {
    const h = await setup({
      roleProvider: async () => 'writer',
    })
    const ticket = jwt.sign({
      uid: 'u_direct_ttl',
      docId: DOC,
      documentName: DOCNAME,
      role: 'writer',
      permission_epoch: 0,
      space_member: true,
      jti: randomUUID(),
    }, config.collabToken.secret, {
      algorithm: 'HS256',
      audience: PPT_RELAY_TICKET_AUD,
      expiresIn: 1,
    })
    const c = await h.connect({ uid: 'u_direct_ttl', role: 'writer', ticket })
    await helloReady(c)
    const closed = await Promise.race([
      c.closed.then(() => true),
      new Promise<boolean>((res) => setTimeout(() => res(false), 1200)),
    ])
    expect(closed).toBe(false)
    await helloReady(c)
  })

  it('Jerry-Xin: a hello sent immediately after open (during the async handshake) is not lost', async () => {
    // A slow epoch lookup widens the handshake window. `ws` does not buffer frames
    // before a `message` listener exists, so before the fix (listeners attached
    // AFTER the awaits) a hello sent right after open was dropped -> silent hang.
    const h = await setup({ epochProvider: async () => { await sleep(60); return 0 } })
    const c = await h.connect({ uid: 'u1', role: 'writer' })
    c.send({ t: 'hello', pv: 2, since: 0 }) // fired while the handshake is still awaiting
    const ready = await c.recvUntil((m) => m.ctl === 'ready')
    expect(ready[ready.length - 1]).toMatchObject({ ctl: 'ready' })
  })

  it('P1-3: a burst of hello frames coalesces into at most one in-flight + one queued replay', async () => {
    class CountingReplayStore extends InMemoryPptRelayStore {
      replayCalls = 0
      override async readReplay(docId: string, since: number): ReturnType<InMemoryPptRelayStore['readReplay']> {
        this.replayCalls++
        await sleep(25) // hold the replay so the burst overlaps it
        return super.readReplay(docId, since)
      }
    }
    const store = new CountingReplayStore()
    const h = await setup({ store })
    const c = await h.connect({ uid: 'u1', role: 'writer' })
    for (let i = 0; i < 10; i++) c.send({ t: 'hello', pv: 2, since: 0 })
    await sleep(200)
    // 1 replay runs immediately; the other 9 collapse into a single queued replay.
    expect(store.replayCalls).toBeLessThanOrEqual(2)
    expect(store.replayCalls).toBeGreaterThanOrEqual(1)
  })

  it('P1-4: a peer op that arrives before a joiner has replayed is delivered exactly once (buffered, deduped)', async () => {
    const h = await setup()
    // Joiner connects (joins the room) but does NOT replay yet.
    const joiner = await h.connect({ uid: 'u_j', role: 'writer' })
    const a = await h.connect({ uid: 'u_a', role: 'writer' })
    await helloReady(a)
    // A's op is broadcast to the joiner while the joiner is not caught up -> buffered.
    a.send(OPS_FRAME(1, 'op1'))
    expect((await a.recv()).q).toBe(1)
    // The joiner now replays: it must receive op1 ONCE (from the replay), and the
    // buffered live copy is deduped on flush — never delivered a second time.
    const { replay } = await helloReady(joiner, 0)
    expect(replay.filter((m) => m.ctl === 'op').map((m) => m.q)).toEqual([1])
    // No duplicate op arrives after `ready`.
    await expect(joiner.recv(150)).rejects.toThrow()
  })

  it('P1-C: live-buffer overflow closes 4410 instead of silently dropping frames', async () => {
    const h = await setup({ limits: { maxLiveBufferFrames: 1, maxLiveBufferBytes: 1_000_000 } })
    const joiner = await h.connect({ uid: 'u_j', role: 'writer' })
    const writer = await h.connect({ uid: 'u_w', role: 'writer' })
    await helloReady(writer)

    writer.send(OPS_FRAME(1, 'overflow-1'))
    expect((await writer.recv()).q).toBe(1)
    writer.send(OPS_FRAME(2, 'overflow-2'))
    expect((await writer.recv()).q).toBe(2)

    expect((await joiner.closed).code).toBe(4410)
    expect(h.relay.roomSize(DOC)).toBe(1)
  })
})

/**
 * XIN-1695 RC round-7 blockers: the known-duplicate re-ack now precedes the
 * mutation gate (Jerry-Xin blocker 1 — idempotent-resend must acknowledge an
 * already-durable frame even from a downgraded/stale-epoch connection), and the
 * retry contract is stated consistently as `rate-limited` + `storage-retry`, with
 * `storage-retry` carrying a bounded `retryInMs` backoff hint (blocker 2).
 */
describe('PPT relay: round-7 fixes (XIN-1695)', () => {
  it('Blocker 1: a downgraded connection resending a KNOWN frameId re-acks its stored seq without rebroadcast', async () => {
    const h = await setup()
    const a = await h.connect({ uid: 'u_a', role: 'writer' })
    const b = await h.connect({ uid: 'u_b', role: 'writer' })
    await helloReady(a)
    await helloReady(b)

    // A (writer) commits a frame durably at epoch 0; B sees the broadcast.
    a.send(OPS_FRAME(1, 'known-frame', 0))
    expect((await a.recv()).q).toBe(1)
    expect(await b.recvUntil((m) => m.ctl === 'op' && m.q === 1)).toBeDefined()

    // Admin downgrades A to reader; the epoch advances to 1.
    h.setRole('u_a', 'reader')
    h.setEpoch(1)
    await h.relay.applyEpochBump(DOCNAME)
    const rc = await a.recvUntil((m) => m.ctl === 'role-changed')
    expect(rc[rc.length - 1]).toMatchObject({ role: 'reader', epoch: 1 })

    // A's original ack was "lost", so A resends the SAME frame (still stamped with
    // the pre-downgrade epoch 0). Before the fix guardMutation refused it
    // stale-epoch/forbidden-role and the durable write was never acknowledged.
    // Now the known-duplicate re-ack precedes the gate: the stored seq is re-acked.
    a.send(OPS_FRAME(1, 'known-frame', 0))
    const reack = await a.recv()
    expect(reack.ctl).toBe('ack')
    expect(reack.q).toBe(1)
    // No new seq minted and no rebroadcast to the peer.
    expect(await h.store.currentSeq(DOC)).toBe(1)
    await expect(b.recv(200)).rejects.toThrow()
  })

  it('Blocker 1: a downgraded connection sending a NEW frameId is still refused (forbidden-role / stale-epoch)', async () => {
    const h = await setup()
    const a = await h.connect({ uid: 'u_a', role: 'writer' })
    const b = await h.connect({ uid: 'u_b', role: 'writer' })
    await helloReady(a)
    await helloReady(b)

    a.send(OPS_FRAME(1, 'durable', 0))
    expect((await a.recv()).q).toBe(1)
    await b.recvUntil((m) => m.ctl === 'op' && m.q === 1)

    h.setRole('u_a', 'reader')
    h.setEpoch(1)
    await h.relay.applyEpochBump(DOCNAME)
    await a.recvUntil((m) => m.ctl === 'role-changed')

    // A NEW frame stamped with the CURRENT epoch is refused forbidden-role (the
    // downgraded role, not a known duplicate — the guard still binds).
    a.send(OPS_FRAME(2, 'new-current', 1))
    expect(await a.recv()).toMatchObject({ code: 'forbidden-role', retryable: false })
    // A NEW frame stamped with the OLD epoch is refused stale-epoch.
    a.send(OPS_FRAME(3, 'new-stale', 0))
    expect(await a.recv()).toMatchObject({ code: 'stale-epoch', retryable: false })

    // Nothing new persisted; the peer never saw a broadcast for either refusal.
    expect(await h.store.currentSeq(DOC)).toBe(1)
    await expect(b.recv(200)).rejects.toThrow()
  })

  it('Blocker 2: storage-retry is retryable and carries a bounded retryInMs backoff hint', async () => {
    // A store whose appendOp throws a transient (retryable) storage error: the
    // relay maps it to `storage-retry` and now attaches STORAGE_RETRY_BACKOFF_MS.
    class TransientAppendStore extends InMemoryPptRelayStore {
      override async appendOp(docId: string, frameId: string, frame: unknown): ReturnType<InMemoryPptRelayStore['appendOp']> {
        void docId
        void frameId
        void frame
        throw new RetryableStorageError('lock wait timeout')
      }
    }
    const h = await setup({ store: new TransientAppendStore() })
    const w = await h.connect({ uid: 'u_w', role: 'writer' })
    await helloReady(w)

    w.send(OPS_FRAME(1, 'transient'))
    const refused = await w.recv()
    expect(refused).toMatchObject({ ctl: 'refused', code: 'storage-retry', retryable: true })
    expect(refused.retryInMs).toBe(STORAGE_RETRY_BACKOFF_MS)
  })

  it('Blocker 2: the retryable set is exactly rate-limited + storage-retry', () => {
    expect(isRetryable('rate-limited')).toBe(true)
    expect(isRetryable('storage-retry')).toBe(true)
    // Every other refusal code is permanent.
    for (const code of ['too-large', 'storage-failed', 'room-full', 'forbidden-role', 'stale-epoch', 'protocol-version', 'snapshot-conflict', 'doc-deleted'] as const) {
      expect(isRetryable(code)).toBe(false)
    }
    expect(STORAGE_RETRY_BACKOFF_MS).toBeGreaterThan(0)
  })
})

/**
 * XIN-1750 (round-17): a duplicate resend whose ledger `payload_hash` is NULL —
 * the state the canonical-ops hash migration
 * (`2026-08-07-ppt-collab-frame-payload-hash-canonical-ops.sql`) leaves EVERY
 * pre-deploy frame in — must still re-ack its already-durable seq BEFORE the
 * mutation gate, exactly like the non-null fast re-ack. Otherwise a writer whose
 * permission epoch advanced (a common membership change) or who was downgraded,
 * resending a committed pre-deploy frame after a lost ack, is refused
 * `stale-epoch` / `forbidden-role` for a write that already committed and is left
 * PERMANENTLY unsynced — the "randomly loses edits after deploy" symptom.
 *
 * The store double here models the MIGRATED DB state the in-memory fake's own
 * ledger (always a non-null hash) can never reach: a committed op whose ledger row
 * had its `payload_hash` nulled, verified against the stored `frame_json`. These
 * tests FAIL on head 0f1c982 (which routes the NULL-hash row straight to
 * guardMutation) and pass on the fix.
 */
class MigratedNullHashStore extends InMemoryPptRelayStore {
  private readonly nulled = new Set<string>()
  private readonly pruned = new Set<string>()
  /** Model the migration: NULL the ledger row's payload_hash for a committed frame. */
  nullifyHash(docId: string, frameId: string): void {
    this.nulled.add(`${docId}:${frameId}`)
  }
  /** Model a post-snapshot GC: the op frame_json is gone, so a NULL-hash resend cannot be verified. */
  prunedOp(docId: string, frameId: string): void {
    this.pruned.add(`${docId}:${frameId}`)
  }
  override async frameIdentity(docId: string, frameId: string): Promise<{ seq: number; payloadHash: string | null } | null> {
    const id = await super.frameIdentity(docId, frameId)
    if (id !== null && this.nulled.has(`${docId}:${frameId}`)) return { seq: id.seq, payloadHash: null }
    return id
  }
  override async resolveNullHashReack(docId: string, frameId: string): Promise<{ seq: number; payloadHash: string } | null> {
    const key = `${docId}:${frameId}`
    if (!this.nulled.has(key)) return null
    const seq = await this.frameSeq(docId, frameId)
    if (seq === null || this.pruned.has(key)) return null // pruned op -> fail closed
    const op = (await this.opsSince(docId, 0)).find((o) => o.frameId === frameId)
    if (op === undefined) return null
    return { seq, payloadHash: canonicalPayloadHash(op.frame) }
  }
}

describe('PPT relay: NULL-hash pre-gate re-ack (XIN-1750, round-17)', () => {
  it('a NULL-hash duplicate resend re-acks its durable seq BEFORE the mutation gate (downgraded + epoch-advanced socket)', async () => {
    const store = new MigratedNullHashStore()
    const h = await setup({ store })
    const a = await h.connect({ uid: 'u_a', role: 'writer' })
    const b = await h.connect({ uid: 'u_b', role: 'writer' })
    await helloReady(a)
    await helloReady(b)

    // A (writer) commits a frame durably at epoch 0; B sees the broadcast.
    a.send(OPS_FRAME(1, 'legacy-frame', 0))
    expect((await a.recv()).q).toBe(1)
    await b.recvUntil((m) => m.ctl === 'op' && m.q === 1)

    // The canonical-ops hash migration NULLs the committed frame's ledger hash (the
    // op row is still present). Admin then downgrades A to reader AND advances the
    // epoch — the exact transitional window the migration comment warns about.
    store.nullifyHash(DOC, 'legacy-frame')
    h.setRole('u_a', 'reader')
    h.setEpoch(1)
    await h.relay.applyEpochBump(DOCNAME)
    await a.recvUntil((m) => m.ctl === 'role-changed')

    // A's ack was lost, so A resends the SAME frame (still stamped pre-downgrade
    // epoch 0). On head 0f1c982 the NULL-hash row fell through to guardMutation and
    // was refused stale-epoch/forbidden-role for an ALREADY-DURABLE write. The fix
    // verifies against frame_json and re-acks the original seq.
    a.send(OPS_FRAME(1, 'legacy-frame', 0))
    const reack = await a.recv()
    expect(reack.ctl).toBe('ack')
    expect(reack.q).toBe(1)
    // No new seq minted and no rebroadcast to the peer.
    expect(await store.currentSeq(DOC)).toBe(1)
    await expect(b.recv(200)).rejects.toThrow()
  })

  it('a NULL-hash resend whose canonical ops DIFFER is NOT re-acked through the pre-gate (no payload smuggling)', async () => {
    const store = new MigratedNullHashStore()
    const h = await setup({ store })
    const a = await h.connect({ uid: 'u_a', role: 'writer' })
    await helloReady(a)

    a.send(OPS_FRAME(1, 'shared-frame', 0))
    expect((await a.recv()).q).toBe(1)
    store.nullifyHash(DOC, 'shared-frame')

    h.setRole('u_a', 'reader')
    h.setEpoch(1)
    await h.relay.applyEpochBump(DOCNAME)
    await a.recvUntil((m) => m.ctl === 'role-changed')

    // Reuse the frameId with DIFFERENT ops. The pre-gate must NOT re-ack on frameId
    // alone: the canonical-ops hash mismatch routes it to the mutation gate, where
    // the downgraded/stale-epoch socket is correctly refused. A different payload can
    // never ride the pure-re-ack exemption through the gate.
    a.send({ t: 'ops', pv: 2, k: 1, frameId: 'shared-frame', epoch: 0, ops: [{ op: 'set', a: 'u-test', s: 1, l: 1, k: 'x', v: 999 }] })
    const refused = await a.recv()
    expect(refused.ctl).toBe('refused')
    expect(['stale-epoch', 'forbidden-role']).toContain(refused.code)
    expect(refused.retryable).toBe(false)
    // Nothing new persisted.
    expect(await store.currentSeq(DOC)).toBe(1)
  })

  it('a NULL-hash resend whose op row was PRUNED fails closed (no frame_json to verify) and does not smuggle a re-ack', async () => {
    const store = new MigratedNullHashStore()
    const h = await setup({ store })
    const a = await h.connect({ uid: 'u_a', role: 'writer' })
    await helloReady(a)

    a.send(OPS_FRAME(1, 'pruned-frame', 0))
    expect((await a.recv()).q).toBe(1)
    // Migration nulled the hash; a later snapshot pruned the op frame_json.
    store.nullifyHash(DOC, 'pruned-frame')
    store.prunedOp(DOC, 'pruned-frame')

    h.setRole('u_a', 'reader')
    h.setEpoch(1)
    await h.relay.applyEpochBump(DOCNAME)
    await a.recvUntil((m) => m.ctl === 'role-changed')

    // With no frame_json to verify against, the pre-gate cannot confirm identity, so
    // the resend falls through to the mutation gate and the downgraded/stale-epoch
    // socket is refused (fail closed) — it is not blindly re-acked on frameId alone.
    a.send(OPS_FRAME(1, 'pruned-frame', 0))
    const refused = await a.recv()
    expect(refused.ctl).toBe('refused')
    expect(['stale-epoch', 'forbidden-role']).toContain(refused.code)
  })

  it('a still-authorized writer resending a NULL-hash frame at the current epoch also re-acks (no regression to the non-null path)', async () => {
    const store = new MigratedNullHashStore()
    const h = await setup({ store })
    const a = await h.connect({ uid: 'u_a', role: 'writer' })
    await helloReady(a)

    a.send(OPS_FRAME(1, 'live-frame', 0))
    expect((await a.recv()).q).toBe(1)
    store.nullifyHash(DOC, 'live-frame')

    // Same authority, same epoch: the pre-gate re-ack still short-circuits (identical
    // to the non-null fast path) rather than re-persisting or minting a new seq.
    a.send(OPS_FRAME(1, 'live-frame', 0))
    const reack = await a.recv()
    expect(reack.ctl).toBe('ack')
    expect(reack.q).toBe(1)
    expect(await store.currentSeq(DOC)).toBe(1)
  })
})

describe('PPT relay: RC round-12 blockers (XIN-1736)', () => {
  it('P1-E: a re-hello with a stale (lower) cursor does NOT re-deliver already-delivered ops', async () => {
    const h = await setup()
    await h.store.appendOp(DOC, 'f1', OPS_FRAME(1, 'f1'))
    await h.store.appendOp(DOC, 'f2', OPS_FRAME(2, 'f2'))
    const c = await h.connect({ uid: 'u1', role: 'writer' })
    const first = await helloReady(c, 0)
    expect(first.replay.filter((m) => m.ctl === 'op').map((m) => m.q)).toEqual([1, 2])
    // Re-hello from the SAME stale cursor 0 (a coalesced burst / reconnect race).
    // The connection already applied ops 1 and 2; re-delivering them would double-
    // apply the non-idempotent ins/txt RGA and diverge the doc.
    const second = await helloReady(c, 0)
    expect(second.replay.filter((m) => m.ctl === 'op')).toEqual([])
    const ready = second.replay[second.replay.length - 1]!
    expect(ready.q).toBe(2) // reports the true synced-through seq, not the stale cursor
  })

  it('P1-C: a replay cursor.close() failure still releases the replay permit (no process-wide leak)', async () => {
    let closeCalls = 0
    const store = new InMemoryPptRelayStore()
    const realOpen = store.openReplay.bind(store)
    ;(store as { openReplay: PptRelayStore['openReplay'] }).openReplay = async (docId, since, limits) => {
      const cursor = await realOpen(docId, since, limits!)
      // Force the cursor-exceeds-high-water refusal path (highWater 0) AND make
      // close() reject, so the pre-fix `close(); release()` sequence skipped the
      // release and leaked the sole replay permit.
      return { ...cursor, highWater: 0, close: async () => { closeCalls++; throw new Error('close boom') } }
    }
    const h = await setup({ store, limits: { maxInFlightReplays: 1 } })
    const c = await h.connect({ uid: 'u1', role: 'writer' })
    c.send({ t: 'hello', pv: 2, since: 5 }) // since > highWater(0) -> protocol-version, close() throws
    const r1 = await c.recvUntil((m) => m.ctl === 'refused')
    expect(r1[r1.length - 1]!.code).toBe('protocol-version')
    // A SECOND replay must still acquire the (single) permit — proving the first
    // one's permit was released in `finally` despite close() throwing.
    c.send({ t: 'hello', pv: 2, since: 5 })
    const r2 = await c.recvUntil((m) => m.ctl === 'refused', 1500)
    expect(r2[r2.length - 1]!.code).toBe('protocol-version')
    expect(closeCalls).toBe(2)
  })

  it('P1-F: inbound frames beyond the queue cap are shed with rate-limited (bounded work queue)', async () => {
    // A tiny inbound-queue cap with a huge frame-rate window so any rate-limited
    // refusal comes from the QUEUE cap, not the per-window rate limit.
    const h = await setup({ limits: { maxInboundQueue: 1, maxFramesPerWindow: 1_000_000 } })
    const w = await h.connect({ uid: 'u1', role: 'writer' })
    await helloReady(w)
    for (let i = 0; i < 40; i++) w.send(OPS_FRAME(i, `flood-${i}`))
    const msgs = await w.recvUntil((m) => m.ctl === 'refused' && m.code === 'rate-limited', 3000)
    expect(msgs.some((m) => m.ctl === 'refused' && m.code === 'rate-limited')).toBe(true)
  })

  it('P1-I: a revoked (none) reader cannot re-ack a harvested frameId — the identity gate precedes the ledger lookup', async () => {
    const h = await setup()
    await h.store.appendOp(DOC, 'harv', OPS_FRAME(1, 'harv')) // a durable frame authored earlier
    const c = await h.connect({ uid: 'u_r', role: 'reader' })
    await helloReady(c)
    // Revoke to `none` and bump the epoch, WITHOUT pushing applyEpochBump: the
    // per-frame identity gate must catch it on the re-ack path.
    h.setRole('u_r', 'none')
    h.setEpoch(1)
    c.send(OPS_FRAME(1, 'harv', 1)) // try to re-ack the harvested (durable) frameId
    const refused = await c.recvUntil((m) => m.ctl === 'refused')
    expect(refused[refused.length - 1]!.code).toBe('forbidden-role')
    // No `ack` for the harvested frame was ever sent.
    expect(refused.some((m) => m.ctl === 'ack')).toBe(false)
  })

  it('P1-I: a still-authorized reader downgraded from writer STILL re-acks a genuine duplicate (round-7/D3 preserved)', async () => {
    const h = await setup()
    const w = await h.connect({ uid: 'u_w', role: 'writer' })
    await helloReady(w)
    w.send(OPS_FRAME(1, 'dup'))
    expect(await w.recv()).toMatchObject({ ctl: 'ack', q: 1 })
    // Downgrade writer -> reader and bump the epoch; the connection is still a
    // live reader, so its idempotent resend of the durable frame is re-acked.
    h.setRole('u_w', 'reader')
    h.setEpoch(1)
    w.send(OPS_FRAME(1, 'dup', 0)) // resend stamped with the pre-downgrade epoch
    const reack = await w.recvUntil((m) => m.ctl === 'ack' || m.ctl === 'refused')
    expect(reack[reack.length - 1]).toMatchObject({ ctl: 'ack', q: 1 })
  })
})

/**
 * XIN-1739 ordering-model redesign: legal seq gaps vs the observed high-water
 * (P1-1), the replay→live cutover drain-until-empty (P1-2), and in-place `reauth`
 * for share-derived sockets (P1-3). Each test fails on the pre-fix `3ebeccf` head.
 */
describe('PPT relay: ordering-model redesign (XIN-1739)', () => {
  // A store whose op log has a LEGAL gap: real ops at seq 1 and 3, seq 2 is a
  // burned compatibility hole, and the durable high-water is 3.
  class GappedStore extends InMemoryPptRelayStore {
    private readonly gapOps = [
      { seq: 1, frameId: 'g1', frame: OPS_FRAME(1, 'g1'), frameBytes: 40 },
      { seq: 3, frameId: 'g3', frame: OPS_FRAME(3, 'g3'), frameBytes: 40 },
    ]
    override async currentSeq(): Promise<number> {
      return 3
    }
    override async opsSince(_docId: string, since: number): Promise<typeof this.gapOps> {
      return this.gapOps.filter((o) => o.seq > since)
    }
    override async openReplay(
      docId: string,
      since: number,
      limits: { pageRows: number; pageBytes: number },
    ): ReturnType<InMemoryPptRelayStore['openReplay']> {
      const snapshot = await this.getSnapshot(docId)
      const rows = this.gapOps.filter((o) => o.seq > since)
      let i = 0
      return {
        highWater: 3,
        snapshot,
        fromSeq: since,
        nextPage: async () => {
          const page = rows.slice(i, i + limits.pageRows)
          i += page.length
          return page
        },
        close: async () => {},
      }
    }
  }

  it('P1-1: a burned seq gap does not wedge the watermark — replay delivers 1,3 and deliveredThrough reaches 3', async () => {
    const h = await setup({ store: new GappedStore() })
    const c = await h.connect({ uid: 'u_w', role: 'writer' })
    const { ready, replay } = await helloReady(c)
    // The delivered op sequence is monotonic-but-gapped (2 is a legal hole).
    expect(replay.filter((m) => m.ctl === 'op').map((m) => m.q)).toEqual([1, 3])
    expect(ready.q).toBe(3)
    // deliveredThrough reached 3 despite the burned seq 2 (the pre-fix contiguous
    // watermark stuck at 1). A client snap is server-managed and refused (prune moved
    // off the connection entirely, XIN-1759 Part A/B), so it no longer probes the
    // watermark; the [1,3] replay + ready.q=3 above already prove the gap didn't wedge it.
    c.send({ t: 'snap', pv: 2, k: 7, epoch: 0, q: 3, doc: deck() })
    const out = await c.recvUntil((m) => m.ctl === 'ack' || m.ctl === 'refused')
    expect(out[out.length - 1]).toMatchObject({ ctl: 'refused', code: 'snapshot-conflict' })
  })

  it('P1-2: ops that arrive while a joiner is catching up are delivered exactly once, in monotonic order (no mid-flush reorder)', async () => {
    // Gate the joiner's replay so live ops pile up during catch-up, then release
    // and assert the cutover drains them in order with no duplicates.
    let release!: () => void
    const gate = new Promise<void>((res) => {
      release = res
    })
    class GatedReplayStore extends InMemoryPptRelayStore {
      armed = false
      gatedOnce = false
      override async openReplay(
        docId: string,
        since: number,
        limits: { pageRows: number; pageBytes: number },
      ): ReturnType<InMemoryPptRelayStore['openReplay']> {
        if (this.armed && !this.gatedOnce) {
          this.gatedOnce = true
          await gate
        }
        return super.openReplay(docId, since, limits)
      }
    }
    const store = new GatedReplayStore()
    const h = await setup({ store })
    const a = await h.connect({ uid: 'u_a', role: 'writer' })
    await helloReady(a)
    store.armed = true // only the joiner's replay is gated from here
    const joiner = await h.connect({ uid: 'u_j', role: 'writer' })
    // Joiner starts replaying (blocks on the gate: replayInFlight, buffering).
    joiner.send({ t: 'hello', pv: 2, since: 0 })
    // Writer streams ops while the joiner is still catching up — all buffered.
    for (const [k, id] of [[1, 'c1'], [2, 'c2'], [3, 'c3']] as const) {
      a.send(OPS_FRAME(k, id))
      expect((await a.recv()).q).toBe(k)
    }
    // Release the replay; the cutover drains the buffer (deduped on the high-water)
    // and delivers each op exactly once, in order, before `ready`.
    release()
    const drained = await joiner.recvUntil((m) => m.ctl === 'ready')
    const opSeqs = drained.filter((m) => m.ctl === 'op').map((m) => m.q as number)
    expect(opSeqs).toEqual([...opSeqs].sort((x, y) => x - y)) // strictly monotonic
    expect(new Set(opSeqs).size).toBe(opSeqs.length) // no duplicates
    expect(opSeqs).toEqual([1, 2, 3])
    // A further live op after catch-up continues in order.
    a.send(OPS_FRAME(4, 'c4'))
    expect((await a.recv()).q).toBe(4)
    expect((await joiner.recvUntil((m) => m.ctl === 'op')).at(-1)).toMatchObject({ ctl: 'op', q: 4 })
  })

  it('P1-2: a broadcast that arrives mid-flush is buffered and ordered AFTER the buffered ops (no 10,12,11)', async () => {
    // Deterministic cutover race, driven against a fake socket whose drain we gate.
    // The connection is mid-cutover: replay succeeded, buffer holds ops 10 and 11,
    // and a drain is in progress (`flushDepth > 0`). While the flush awaits the drain
    // of op 10, a live broadcast (op 12) arrives. The pre-fix head set `caughtUp = true`
    // before the flush finished and did not gate on flushing, so op 12 bypassed the
    // buffer and enqueued between 10 and 11 → 10,12,11. The flush-depth gate buffers
    // it and the drain-until-empty loop emits it last → 10,11,12.
    const relay = new PptRelay({
      store: new InMemoryPptRelayStore(),
      epochProvider: async () => 0,
      limits: { sendHighWaterBytes: 0, sendDrainTimeoutMs: 500 },
    })
    const sent: unknown[] = []
    const fakeSocket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 1, // above the (0) high-water → the first send awaits the drain
      send: vi.fn((raw: string) => {
        sent.push(JSON.parse(raw))
      }),
      close: vi.fn(),
    }
    const op = (q: number) => ({ ctl: 'op' as const, q, frame: OPS_FRAME(q, `l${q}`) })
    const peer = {
      socket: fakeSocket,
      uid: 'u_cut',
      docId: DOC,
      documentName: DOCNAME,
      role: 'reader',
      roleEpoch: 0,
      spaceMember: false,
      frameTimes: [],
      ephemeralFrameTimes: [],
      caughtUp: true, // pre-fix set this true before the flush completed (the bug)
      replayInFlight: false,
      flushDepth: 1, // the cutover drain is in progress
      replayPending: null,
      liveBuffer: [op(10), op(11)],
      deliveredThrough: 9,
      liveBufferBytes: 0,
      auth: { readAllowed: true, invalidated: false },
      inboundChain: Promise.resolve(),
      inboundDepth: 0,
      outboundChain: Promise.resolve(),
    }
    const asAny = relay as unknown as {
      flushLiveBuffer: (c: unknown) => Promise<void>
      deliver: (c: unknown, f: unknown) => Promise<void>
    }
    const flushP = asAny.flushLiveBuffer(peer) // sends op 10, then awaits the gated drain
    await sleep(20)
    const deliverP = asAny.deliver(peer, op(12)) // arrives mid-flush → must be buffered
    await sleep(20)
    fakeSocket.bufferedAmount = 0 // release the drain
    await Promise.all([flushP, deliverP])
    expect(sent.map((m) => (m as { q?: number }).q)).toEqual([10, 11, 12])
    relay.close()
  })

  /** Sign a fresh single-use ticket (the client mints this via the collab-token endpoint). */
  const freshTicket = (o: { uid: string; role: Role; spaceMember: boolean; epoch?: number; ttl?: number }): string =>
    jwt.sign(
      { uid: o.uid, docId: DOC, documentName: DOCNAME, role: o.role, permission_epoch: o.epoch ?? 0, space_member: o.spaceMember, jti: randomUUID() },
      config.collabToken.secret,
      { algorithm: 'HS256', audience: PPT_RELAY_TICKET_AUD, expiresIn: o.ttl ?? 30 },
    )

  it('P1-3: an in-place reauth keeps a share-derived socket open past its old ticket expiry with NO full replay', async () => {
    const h = await setup({
      roleProvider: async ({ spaceMember }) => (spaceMember ? 'writer' : 'none'),
      limits: { reauthGraceMs: 300 },
    })
    const first = freshTicket({ uid: 'u_share', role: 'writer', spaceMember: true, ttl: 1 })
    const c = await h.connect({ uid: 'u_share', role: 'writer', ticket: first })
    await helloReady(c)
    // Before the short-TTL grace elapses, present a freshly-minted ticket in place.
    c.send({ t: 'reauth', pv: 2, ticket: freshTicket({ uid: 'u_share', role: 'writer', spaceMember: true, ttl: 30 }) })
    // The socket must NOT close (no fail-closed) and must NOT be forced to replay —
    // a `snap` still acks, proving it kept writer authority in place.
    const stillOpen = await Promise.race([
      c.closed.then(() => true),
      new Promise<boolean>((res) => setTimeout(() => res(false), 700)),
    ])
    expect(stillOpen).toBe(false)
    // A persisted `ops` write still acks, proving it kept writer authority in place
    // (snapshots are server-managed now, so `ops` is the authority proxy — XIN-1759).
    c.send(OPS_FRAME(9, 'reauth-proof'))
    const out = await c.recvUntil((m) => m.ctl === 'ack' || m.ctl === 'refused')
    expect(out[out.length - 1]).toMatchObject({ ctl: 'ack', k: 9 })
  })

  it('P1-3: a reauth whose fresh authority no longer grants access fails closed (4403)', async () => {
    let member = true
    const h = await setup({
      roleProvider: async ({ spaceMember }) => (spaceMember && member ? 'writer' : 'none'),
      limits: { reauthGraceMs: 5000 },
    })
    const c = await h.connect({ uid: 'u_share', role: 'writer', ticket: freshTicket({ uid: 'u_share', role: 'writer', spaceMember: true, ttl: 1 }) })
    await helloReady(c)
    // Membership was revoked at the authority; a reauth minted at a NEW epoch must
    // re-resolve to none and fail closed rather than refresh access in place.
    member = false
    h.setEpoch(1)
    c.send({ t: 'reauth', pv: 2, ticket: freshTicket({ uid: 'u_share', role: 'writer', spaceMember: true, epoch: 0, ttl: 30 }) })
    expect((await c.closed).code).toBe(4403)
  })

  it('P1-3: a reauth for a DIFFERENT uid/doc is rejected (identity is immutable across reauth)', async () => {
    const h = await setup({ roleProvider: async () => 'writer' })
    const c = await h.connect({ uid: 'u_share', role: 'writer', ticket: freshTicket({ uid: 'u_share', role: 'writer', spaceMember: true }) })
    await helloReady(c)
    const foreign = jwt.sign(
      { uid: 'someone_else', docId: DOC, documentName: DOCNAME, role: 'writer', permission_epoch: 0, space_member: true, jti: randomUUID() },
      config.collabToken.secret,
      { algorithm: 'HS256', audience: PPT_RELAY_TICKET_AUD, expiresIn: 30 },
    )
    c.send({ t: 'reauth', pv: 2, ticket: foreign })
    expect((await c.closed).code).toBe(4403)
  })

  it('P1-3: a replayed reauth ticket (same jti) is rejected — reauth consumes single-use like connect', async () => {
    const h = await setup({ roleProvider: async () => 'writer' })
    const c = await h.connect({ uid: 'u_share', role: 'writer', ticket: freshTicket({ uid: 'u_share', role: 'writer', spaceMember: true }) })
    await helloReady(c)
    const ticket = freshTicket({ uid: 'u_share', role: 'writer', spaceMember: true })
    c.send({ t: 'reauth', pv: 2, ticket }) // consumes the jti
    await sleep(50)
    expect(c.ws.readyState).toBe(WebSocket.OPEN)
    c.send({ t: 'reauth', pv: 2, ticket }) // replay of the same jti => rejected
    expect((await c.closed).code).toBe(4403)
  })
})

/**
 * XIN-1748 round-16 blockers: the re-ack watermark regression (P0-2) and the
 * non-reentrant flush gate (P1-1). Each test FAILS on head 5fb58629 and PASSES on
 * the fix.
 */
describe('PPT relay: round-16 fixes (XIN-1748)', () => {
  it('P0-2: a re-ack of the connection own durable frame does NOT advance the observation high-water — the un-clamped tail still replays', async () => {
    const h = await setup()
    const c = await h.connect({ uid: 'u_reack', role: 'writer' })
    await helloReady(c) // caught up on an EMPTY room → deliveredThrough stays 0
    // Peers durably commit ops 1..3 this socket never observed (seeded straight into
    // the store, so no broadcast reaches c) — the optimistic-write-then-drop shape.
    await h.store.appendOp(DOC, 'f1', OPS_FRAME(1, 'f1'))
    await h.store.appendOp(DOC, 'f2', OPS_FRAME(2, 'f2'))
    await h.store.appendOp(DOC, 'f3', OPS_FRAME(3, 'f3'))
    // c resends a frame already durable (same frameId + payload) — a known duplicate
    // that re-acks seq 3. On 5fb58629 the re-ack advanced c.deliveredThrough to 3.
    c.send(OPS_FRAME(1, 'f3'))
    const reack = await c.recvUntil((m) => m.ctl === 'ack')
    expect(reack[reack.length - 1]).toMatchObject({ ctl: 'ack', q: 3 })
    // c resyncs from 0: the un-observed tail 1..3 MUST replay. On 5fb58629 the re-ack
    // clamp (effectiveSince = max(0, 3) = 3) skipped every op → empty replay → the
    // ops were lost permanently.
    c.send({ t: 'hello', pv: 2, since: 0 })
    const replay = await c.recvUntil((m) => m.ctl === 'ready')
    const ops = replay.filter((m) => m.ctl === 'op').map((m) => m.q)
    expect(ops).toEqual([1, 2, 3])
  })

  it('P0-2: a snapshot covering a seq the connection only RE-ACKED (never observed) is refused', async () => {
    const h = await setup()
    const c = await h.connect({ uid: 'u_reack2', role: 'writer' })
    await helloReady(c) // caught up empty → deliveredThrough 0
    await h.store.appendOp(DOC, 'g1', OPS_FRAME(1, 'g1'))
    await h.store.appendOp(DOC, 'g2', OPS_FRAME(2, 'g2'))
    await h.store.appendOp(DOC, 'g3', OPS_FRAME(3, 'g3'))
    c.send(OPS_FRAME(1, 'g3'))
    expect((await c.recvUntil((m) => m.ctl === 'ack')).at(-1)).toMatchObject({ ctl: 'ack', q: 3 })
    // c is caught up but has observed NOTHING; a snapshot covering the re-acked seq 3
    // would prune ops 1..3 it never saw. On 5fb58629 the re-ack had advanced
    // deliveredThrough to 3, so the snap was ACCEPTED and the whole op log pruned.
    c.send({ t: 'snap', pv: 2, k: 7, epoch: 0, q: 3, doc: deck() })
    const out = await c.recvUntil((m) => m.ctl === 'ack' || m.ctl === 'refused')
    expect(out[out.length - 1]).toMatchObject({ ctl: 'refused', code: 'snapshot-conflict' })
  })

  it('P1-1: two overlapping cutover drains cannot interleave a live broadcast between buffered frames', async () => {
    // Deterministic double-drain race against a fake socket whose send we gate — the
    // shape of `applyEpochBump` concurrent with a `reauth`, or two quick epoch bumps.
    const relay = new PptRelay({
      store: new InMemoryPptRelayStore(),
      epochProvider: async () => 0,
      limits: { sendHighWaterBytes: 0, sendDrainTimeoutMs: 500 },
    })
    const sent: unknown[] = []
    const fakeSocket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 1, // above the (0) high-water → the first send awaits the drain
      send: vi.fn((raw: string) => {
        sent.push(JSON.parse(raw))
      }),
      close: vi.fn(),
    }
    const op = (q: number) => ({ ctl: 'op' as const, q, frame: OPS_FRAME(q, `l${q}`) })
    const peer = {
      socket: fakeSocket,
      uid: 'u_dd',
      docId: DOC,
      documentName: DOCNAME,
      role: 'reader',
      roleEpoch: 0,
      spaceMember: false,
      reauthGeneration: 0,
      frameTimes: [],
      ephemeralFrameTimes: [],
      caughtUp: true,
      replayInFlight: false,
      flushDepth: 0,
      replayPending: null,
      liveBuffer: [op(10), op(11)],
      deliveredThrough: 9,
      liveBufferBytes: 0,
      auth: { readAllowed: true, invalidated: false },
      inboundChain: Promise.resolve(),
      inboundDepth: 0,
      outboundChain: Promise.resolve(),
      drainChain: Promise.resolve(),
    }
    const asAny = relay as unknown as {
      drainLiveBuffer: (c: unknown) => Promise<void>
      deliver: (c: unknown, f: unknown) => Promise<void>
    }
    // Re-pinned (XIN-1739 P1-2): drain #1 swaps out [10,11] and awaits the gated
    // send of op 10; op 12 is then delivered mid-drain and BUFFERED; only THEN does
    // drain #2 enter — finding a NON-EMPTY buffer ([12]). A bare depth counter does
    // not serialise the drainers, so on head 7133d0e drain #2 swaps [12] and enqueues
    // op 12 on the outbound chain AHEAD of op 11 (drain #1 is still awaiting op 10's
    // gated send and has not reached 11), yielding 10,12,11 — permanent divergence
    // for the non-idempotent RGA. Serialising every drain body through one promise
    // chain keeps drain #1's swap+sends atomic w.r.t. drain #2, so the tail buffer is
    // drained in receipt order → strictly increasing 10,11,12.
    const drain1 = asAny.drainLiveBuffer(peer)
    await sleep(20)
    const deliverP = asAny.deliver(peer, op(12)) // arrives mid-drain → must be buffered
    await sleep(20)
    const drain2 = asAny.drainLiveBuffer(peer) // enters with a NON-empty buffer ([12])
    await sleep(20)
    fakeSocket.bufferedAmount = 0 // release the drain
    await Promise.all([drain1, drain2, deliverP])
    expect(sent.map((m) => (m as { q?: number }).q)).toEqual([10, 11, 12])
    relay.close()
  })
})

/**
 * XIN-1754 round-18 blockers: the observation watermark is advanced by events that
 * are not genuine observations, letting a snapshot then prune ops no one received
 * (P0-1 / P1); an in-place reauth undone by the expiry callback it replaced (P1-1);
 * a sticky pendingReauth after a transient epoch read (P1-3); a deep-nested ops
 * frame that escapes every guard as a silent drop (P2). Each FAILS on head 7133d0e
 * and PASSES on the fix. (The drain-order P1-2 regression re-pins the round-16 P1-1
 * test above so drain B finds a NON-empty buffer.)
 */
describe('PPT relay: round-18 fixes (XIN-1754)', () => {
  /** Sign a fresh single-use ticket (mirrors the ordering-model block's helper). */
  const freshTicket = (o: { uid: string; role: Role; spaceMember: boolean; epoch?: number; ttl?: number }): string =>
    jwt.sign(
      { uid: o.uid, docId: DOC, documentName: DOCNAME, role: o.role, permission_epoch: o.epoch ?? 0, space_member: o.spaceMember, jti: randomUUID() },
      config.collabToken.secret,
      { algorithm: 'HS256', audience: PPT_RELAY_TICKET_AUD, expiresIn: o.ttl ?? 30 },
    )

  /** A store whose ledger fast path (`frameIdentity`) is unavailable, so a resend
   * falls through to `appendOp` — which still dedups authoritatively. */
  class LedgerFastPathDownStore extends InMemoryPptRelayStore {
    async frameIdentity(): Promise<never> {
      throw new Error('ledger fast path unavailable')
    }
  }

  it('P0-1: a writer caught-up via a CLAIMED cursor cannot snap-prune ops it never observed', async () => {
    const h = await setup()
    // The room already holds durable peer ops 1..3, no snapshot.
    await h.store.appendOp(DOC, 'g1', OPS_FRAME(1, 'g1'))
    await h.store.appendOp(DOC, 'g2', OPS_FRAME(2, 'g2'))
    await h.store.appendOp(DOC, 'g3', OPS_FRAME(3, 'g3'))
    const c = await h.connect({ uid: 'u_claim', role: 'writer' })
    // Claim since = room high-water (3): replay streams NOTHING; the socket is marked
    // caught up with deliveredThrough 0 and a coverage floor of 3.
    const { replay } = await helloReady(c, 3)
    expect(replay.filter((m) => m.ctl === 'op')).toHaveLength(0)
    // One fresh op → seq 4. On 7133d0e the ack inflates deliveredThrough to 4.
    c.send(OPS_FRAME(1, 'g4'))
    expect((await c.recvUntil((m) => m.ctl === 'ack')).at(-1)).toMatchObject({ ctl: 'ack', q: 4 })
    // A snap covering its own seq 4 would prune ops 1..3 it never observed. On 7133d0e
    // it was ACCEPTED and pruned the whole op log; the fix binds prune authority to
    // the delivery floor and REFUSES it.
    c.send({ t: 'snap', pv: 2, k: 9, epoch: 0, q: 4, doc: deck('claim') })
    expect((await c.recvUntil((m) => m.ctl === 'ack' || m.ctl === 'refused')).at(-1)).toMatchObject({
      ctl: 'refused',
      code: 'snapshot-conflict',
    })
    // The durable op prefix survives.
    expect((await h.store.opsSince(DOC, 0)).map((o) => o.seq)).toEqual([1, 2, 3, 4])
  })

  it('P0-1b: a slow-duplicate resend (ledger fast path unavailable) does NOT advance the observation watermark', async () => {
    const store = new LedgerFastPathDownStore()
    const h = await setup({ store })
    const c = await h.connect({ uid: 'u_dup', role: 'writer' })
    await helloReady(c) // caught up on an empty room → deliveredThrough 0
    // Peers durably commit ops 1..3 this socket never observed.
    await store.appendOp(DOC, 'a1', OPS_FRAME(1, 'a1'))
    await store.appendOp(DOC, 'a2', OPS_FRAME(2, 'a2'))
    await store.appendOp(DOC, 'a3', OPS_FRAME(3, 'a3'))
    // c resends frame 'a3' (already durable at seq 3). frameIdentity throws → the
    // resend falls through to appendOp → duplicate:true at seq 3. On 7133d0e the
    // post-append markObservedSeq advanced deliveredThrough to 3 for this duplicate.
    c.send(OPS_FRAME(1, 'a3'))
    expect((await c.recvUntil((m) => m.ctl === 'ack')).at(-1)).toMatchObject({ ctl: 'ack', q: 3 })
    // A duplicate re-ack is not an observation: a snap covering 3 is refused, and a
    // re-hello from 0 still replays the un-observed tail 1..3 (not clamped away).
    c.send({ t: 'snap', pv: 2, k: 5, epoch: 0, q: 3, doc: deck('dup') })
    expect((await c.recvUntil((m) => m.ctl === 'ack' || m.ctl === 'refused')).at(-1)).toMatchObject({
      ctl: 'refused',
      code: 'snapshot-conflict',
    })
    c.send({ t: 'hello', pv: 2, since: 0 })
    const replay = await c.recvUntil((m) => m.ctl === 'ready')
    expect(replay.filter((m) => m.ctl === 'op').map((m) => m.q)).toEqual([1, 2, 3])
  })

  it('P1-1: a completed in-place reauth is NOT undone by the replaced share-expiry callback', async () => {
    let releaseDirect: () => void = () => {}
    const directGate = new Promise<void>((res) => {
      releaseDirect = res
    })
    let directCalls = 0
    const h = await setup({
      // Writer only via the space-membership claim; the direct-role resolve the
      // expiry callback runs blocks on `directGate` the FIRST time, simulating a
      // slow lookup that outlives the in-place reauth.
      roleProvider: async ({ spaceMember }) => {
        if (spaceMember) return 'writer'
        directCalls++
        if (directCalls === 1) await directGate
        return 'none'
      },
      limits: { reauthGraceMs: 5000, authRefreshMs: 100000 },
    })
    const first = freshTicket({ uid: 'u_share', role: 'writer', spaceMember: true, ttl: 1 })
    const c = await h.connect({ uid: 'u_share', role: 'writer', ticket: first })
    await helloReady(c)
    // Let the ~1s share-expiry timer fire and enter expireShareMembership, which
    // blocks in the (gated) direct-role resolve.
    await sleep(1300)
    // Present a fresh ticket at the SAME epoch → handleReauth trusts the ticket role
    // (no roleProvider await), succeeds, bumps the reauth generation, re-arms expiry.
    c.send({ t: 'reauth', pv: 2, ticket: freshTicket({ uid: 'u_share', role: 'writer', spaceMember: true, ttl: 30 }) })
    await sleep(80)
    // Release the stalled callback. On 7133d0e it resumes, re-checks only liveness,
    // sees direct='none' < writer, and shoves the FRESHLY reauthorized socket back
    // into pendingReauth + fail-closed grace. The generation guard makes it bail.
    releaseDirect()
    await sleep(80)
    // The socket keeps writer authority in place: a persisted `ops` write acks (not
    // refused/closed) — the authority proxy now that snapshots are server-managed.
    c.send(OPS_FRAME(9, 'reauth-not-undone'))
    expect((await c.recvUntil((m) => m.ctl === 'ack' || m.ctl === 'refused')).at(-1)).toMatchObject({
      ctl: 'ack',
      k: 9,
    })
  })

  it('P1-3: a transient epoch-read failure during an epoch bump does not permanently disable a direct writer', async () => {
    let failNextEpochRead = false
    const h = await setup({
      roleProvider: async () => 'writer', // a DIRECT writer, never downgraded
      epochProvider: async () => {
        if (failNextEpochRead) {
          failNextEpochRead = false
          throw new Error('transient epoch read failure')
        }
        return 0
      },
      limits: { authRefreshMs: 100000 },
    })
    const c = await h.connect({ uid: 'u_dw', role: 'writer' })
    await helloReady(c)
    // The epoch bump's epoch read fails transiently, then recovers on the next read.
    failNextEpochRead = true
    await h.relay.applyEpochBump(DOCNAME)
    // On 7133d0e the bump set a sticky pendingReauth (pendingReauth:!epochOk) with no
    // clearer, leaving the socket neither usable nor closed. The fix leaves the
    // re-resolved role authoritative, so the next write is acked once the read recovers.
    c.send(OPS_FRAME(1, 'w1'))
    expect((await c.recvUntil((m) => m.ctl === 'ack' || m.ctl === 'refused')).at(-1)).toMatchObject({
      ctl: 'ack',
      q: 1,
    })
  })

  it('P2: a deeply-nested ops frame gets a refusal verdict, never a silent drop', async () => {
    const h = await setup()
    const c = await h.connect({ uid: 'u_deep', role: 'writer' })
    await helloReady(c)
    // A ~3000-deep nested value: JSON.parse accepts it (well under the byte cap) but
    // it is far above the canonical-hash depth limit. On 7133d0e canonicalStringify
    // overflowed the native stack; the RangeError escaped handleOps and was swallowed
    // by the serialized-chain tail → the client got NEITHER an ack NOR a refusal.
    const depth = 3000
    const raw =
      '{"t":"ops","pv":2,"k":1,"frameId":"deep","epoch":0,"ops":[{"kind":"set","key":"s1e1","prop":"x","value":' +
      '{"n":'.repeat(depth) +
      '0' +
      '}'.repeat(depth) +
      '}]}'
    // Send the raw JSON string directly (do not re-stringify a JS object client-side).
    c.ws.send(raw)
    expect((await c.recvUntil((m) => m.ctl === 'ack' || m.ctl === 'refused')).at(-1)).toMatchObject({
      ctl: 'refused',
      code: 'protocol-version',
    })
  })
})

/**
 * XIN-1759 round-19 P0 (the reviewers' primary blocker): the authored-write
 * watermark advance omitted `!replayInFlight` at ONE of the four delivery sites.
 * A caught-up writer that (re-)issues a `need`/`hello` so a replay is streaming,
 * buffers a peer op, then authors a fresh op, would advance `deliveredThrough` past
 * the buffered-but-undelivered peer op; the cutover's dedup (`q <= deliveredThrough`)
 * then DROPS that peer op forever — a permanent divergence for the non-idempotent
 * RGA. Folding all four sites onto the shared `isDeliveryStable` predicate closes it.
 * This FAILS on head a45ba1e (whose inline guard was `caughtUp && flushDepth === 0`)
 * and PASSES on the fix.
 */
describe('PPT relay: round-19 P0 (XIN-1759) — deliveredThrough single-source predicate', () => {
  it('an authored write during an in-flight replay does NOT advance deliveredThrough, so a buffered peer op survives the cutover', async () => {
    const relay = new PptRelay({
      store: new InMemoryPptRelayStore(),
      epochProvider: async () => 0,
      limits: { sendHighWaterBytes: 1_000_000_000 },
    })
    const sent: unknown[] = []
    const fakeSocket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn((raw: string) => sent.push(JSON.parse(raw))),
      close: vi.fn(),
    }
    const peer = {
      socket: fakeSocket,
      uid: 'u_p',
      docId: DOC,
      documentName: DOCNAME,
      role: 'writer',
      roleEpoch: 0,
      spaceMember: false,
      frameTimes: [],
      ephemeralFrameTimes: [],
      caughtUp: true,
      replayInFlight: true, // a replay is streaming to this socket (re-issued need/hello)
      flushDepth: 0,
      replayPending: null,
      liveBuffer: [],
      deliveredThrough: 5,
      liveBufferBytes: 0,
      auth: { readAllowed: true, invalidated: false },
      inboundChain: Promise.resolve(),
      inboundDepth: 0,
      outboundChain: Promise.resolve(),
      drainChain: Promise.resolve(),
    }
    const asAny = relay as unknown as {
      deliver: (c: unknown, f: unknown) => Promise<void>
      flushLiveBuffer: (c: unknown) => Promise<void>
      isDeliveryStable: (c: unknown) => boolean
      canAdvanceDeliveredThroughFromAuthor: (c: unknown, dup: boolean) => boolean
    }

    // A peer op (seq 6) arrives DURING the in-flight replay → buffered, not delivered.
    await asAny.deliver(peer, { ctl: 'op', q: 6, frame: OPS_FRAME(6, 'peer6') })
    expect(peer.liveBuffer.map((f) => (f as { q: number }).q)).toEqual([6])
    expect(sent).toHaveLength(0)

    // The author writes a fresh op (seq 7) while the replay is STILL in flight. The
    // shared predicate must REFUSE to advance the watermark — the round-19 P0 fix.
    // On a45ba1e the equivalent guard (caughtUp && flushDepth === 0, no replay check)
    // was true, advancing deliveredThrough to 7.
    expect(asAny.isDeliveryStable(peer)).toBe(false)
    expect(asAny.canAdvanceDeliveredThroughFromAuthor(peer, false)).toBe(false)
    expect(peer.deliveredThrough).toBe(5) // unchanged: the authored write did not advance it

    // Sanity: once the replay finishes, an authored write WOULD be a true observation.
    peer.replayInFlight = false
    expect(asAny.isDeliveryStable(peer)).toBe(true)
    expect(asAny.canAdvanceDeliveredThroughFromAuthor(peer, false)).toBe(true)

    // Cutover: the replay finished; flush the buffer. The peer op q=6 (> deliveredThrough
    // 5) is delivered exactly once — NOT dedup-dropped. On a45ba1e the authored write had
    // advanced deliveredThrough to 7, so `6 <= 7` silently discarded it here.
    await asAny.flushLiveBuffer(peer)
    expect(sent.map((m) => (m as { q?: number }).q)).toEqual([6])
    expect(peer.deliveredThrough).toBe(6)
    relay.close()
  })

  it('a duplicate re-ack never advances deliveredThrough even when delivery-stable', () => {
    const relay = new PptRelay({ store: new InMemoryPptRelayStore(), epochProvider: async () => 0 })
    const stable = { caughtUp: true, replayInFlight: false, flushDepth: 0, deliveredThrough: 3, auth: { readAllowed: true, invalidated: false }, socket: { readyState: WebSocket.OPEN } }
    const asAny = relay as unknown as { canAdvanceDeliveredThroughFromAuthor: (c: unknown, dup: boolean) => boolean }
    expect(asAny.canAdvanceDeliveredThroughFromAuthor(stable, false)).toBe(true)
    expect(asAny.canAdvanceDeliveredThroughFromAuthor(stable, true)).toBe(false) // duplicate re-ack
    relay.close()
  })
})
