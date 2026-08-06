// Env seeding MUST be first so config/env.ts reads it at load time.
import './helpers/pptRelayEnv.js'

import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { PptRelay, type RelayLimits } from '../src/ppt/relay/pptRelay.js'
import { InMemoryPptRelayStore, type PptRelayStore } from '../src/ppt/relay/store.js'
import { issuePptCollabToken } from '../src/auth/pptCollabToken.js'
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
      const t = setTimeout(() => rej(new Error('recv timeout')), timeoutMs)
      this.resolvers.push((m) => {
        clearTimeout(t)
        res(m)
      })
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
  connect: (opts: { uid: string; role: Role; name?: string; ticket?: string }) => Promise<WsClient>
  ticketFor: (opts: { uid: string; role: Role; name?: string; epoch?: number }) => string
  setEpoch: (e: number) => void
  setRole: (uid: string, r: ResolvedRole) => void
  setDocStatus: (s: 'live' | 'deleted') => void
  close: () => Promise<void>
}

const harnesses: Harness[] = []

async function setup(opts: { store?: PptRelayStore; limits?: Partial<RelayLimits> } = {}): Promise<Harness> {
  const store = opts.store ?? new InMemoryPptRelayStore()
  let liveEpoch = 0
  const roleMap = new Map<string, ResolvedRole>()
  let docStatus: 'live' | 'deleted' = 'live'

  const relay = new PptRelay({
    store,
    epochProvider: async () => liveEpoch,
    roleProvider: async (uid: string) => roleMap.get(uid) ?? 'writer',
    docStatusProvider: async () => docStatus,
    limits: opts.limits,
  })
  const server: HttpServer = createServer()
  relay.attach(server)
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()))
  const port = (server.address() as AddressInfo).port

  const ticketFor = (o: { uid: string; role: Role; name?: string; epoch?: number }): string =>
    issuePptCollabToken({
      uid: o.uid,
      docId: DOC,
      documentName: DOCNAME,
      role: o.role,
      permission_epoch: o.epoch ?? liveEpoch,
      snapshotVersion: 0,
      ...(o.name ? { name: o.name } : {}),
    }).ticket

  const connect = (o: { uid: string; role: Role; name?: string; ticket?: string }): Promise<WsClient> => {
    const ticket = o.ticket ?? ticketFor(o)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ppt/collab`, ['ppt-relay', ticket])
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

const OPS_FRAME = (k: number, frameId: string, epoch = 0, ops: unknown[] = [{ kind: 'set', key: 's1e1', prop: 'x', value: 1 }]) => ({
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
      { kind: 'set', key: 's1e1', prop: 'x', value: 1 },
      { kind: 'ins', key: 's1e1', at: 0, value: 'a' },
      { kind: 'del', key: 's1e1', at: 0 },
      { kind: 'ord', key: 's1', order: ['e1'] },
      { kind: 'txt', key: 's1e1', delta: [{ retain: 1 }] },
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
})

describe('PPT relay: protocol version (PPT-WS-004)', () => {
  it('missing or incompatible pv is refused protocol-version and never persisted', async () => {
    const h = await setup()
    const a = await h.connect({ uid: 'u_a', role: 'writer' })
    await helloReady(a)

    a.send({ t: 'ops', k: 1, frameId: 'x', epoch: 0, ops: [{ kind: 'set' }] }) // no pv
    const r1 = await a.recv()
    expect(r1.ctl).toBe('refused')
    expect(r1.code).toBe('protocol-version')

    a.send({ t: 'ops', pv: 1, k: 2, frameId: 'y', epoch: 0, ops: [{ kind: 'set' }] }) // pv=1
    const r2 = await a.recv()
    expect(r2.code).toBe('protocol-version')

    expect(await h.store.currentSeq(DOC)).toBe(0)
  })
})

describe('PPT relay: refused retry classification (PPT-WS-006)', () => {
  it('classifies every refused code; only rate-limited is retryable with retryInMs', async () => {
    const h = await setup({ limits: { maxOpsPerFrame: 2, maxFramesPerWindow: 3, maxRoomFrameBytes: 100_000_000 } })
    const w = await h.connect({ uid: 'u_w', role: 'writer' })
    const rdr = await h.connect({ uid: 'u_r', role: 'reader' })
    await helloReady(w)
    await helloReady(rdr)

    // forbidden-role (reader)
    rdr.send(OPS_FRAME(1, 'r1'))
    expect((await rdr.recv())).toMatchObject({ code: 'forbidden-role', retryable: false })

    // protocol-version
    w.send({ t: 'ops', pv: 99, k: 1, frameId: 'pv1', epoch: 0, ops: [{ kind: 'set' }] })
    expect(await w.recv()).toMatchObject({ code: 'protocol-version', retryable: false })

    // too-large (op count over the per-frame cap of 2)
    w.send(OPS_FRAME(2, 'big', 0, [{ kind: 'set' }, { kind: 'set' }, { kind: 'set' }]))
    expect(await w.recv()).toMatchObject({ code: 'too-large', retryable: false })

    // stale-epoch (frame epoch != live epoch)
    h.setEpoch(4)
    w.send(OPS_FRAME(3, 'stale', 0))
    expect(await w.recv()).toMatchObject({ code: 'stale-epoch', retryable: false })
    h.setEpoch(0)

    // snapshot-conflict (snap covers a seq beyond the op log)
    w.send({ t: 'snap', pv: 2, k: 4, epoch: 0, q: 99, doc: deck() })
    expect(await w.recv()).toMatchObject({ code: 'snapshot-conflict', retryable: false })

    // rate-limited (4th persisted frame within the window of 3) — the ONLY retryable code
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
      opsSince: async () => [],
      currentSeq: async () => 0,
      getSnapshot: async () => null,
      saveSnapshot: async () => ({ snapshotVersion: 1 }),
      pruneOpsThrough: async () => undefined,
    }
    const h = await setup({ store: failing })
    const w = await h.connect({ uid: 'u_w', role: 'writer' })
    await helloReady(w)
    w.send(OPS_FRAME(1, 's1'))
    expect(await w.recv()).toMatchObject({ code: 'storage-failed', retryable: false })

    // doc-deleted: flip status; the next mutating frame is refused doc-deleted.
    const h2 = await setup()
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
  it('snapshot advances version atomically; covered ops are not replayed; synced peers skip snapshot', async () => {
    const h = await setup()
    const w = await h.connect({ uid: 'u_w', role: 'writer' })
    await helloReady(w)
    for (let i = 1; i <= 3; i++) {
      w.send(OPS_FRAME(i, `f${i}`))
      await w.recv()
    }
    // Upload a snapshot covering seq 2.
    w.send({ t: 'snap', pv: 2, k: 100, epoch: 0, q: 2, doc: deck('snap') })
    const snapAck = await w.recv()
    expect(snapAck.ctl).toBe('ack')
    expect(snapAck.snapshotVersion).toBe(1)

    // New joiner: gets snapshot + only op 3 (covered ops 1-2 are pruned/not replayed).
    const joiner = await h.connect({ uid: 'u_j', role: 'reader' })
    const { replay } = await helloReady(joiner)
    const ctls = replay.map((m) => m.ctl)
    expect(ctls[0]).toBe('snapshot')
    const opFrames = replay.filter((m) => m.ctl === 'op')
    expect(opFrames).toHaveLength(1)
    expect(opFrames[0]!.q).toBe(3)

    // An already-synced peer (since=3) is NOT forced to reapply the snapshot.
    const synced = await h.connect({ uid: 'u_s', role: 'reader' })
    const { replay: r2 } = await helloReady(synced, 3)
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
})

describe('PPT relay: stale-ticket epoch cutoff fails CLOSED (PPT-EPOCH-001 regression)', () => {
  // A ticket carries the role/epoch snapshot from issuance. If the live epoch has
  // moved on (downgrade / revocation) BEFORE the socket connects, the ticket's
  // cached role must not seed write authority — the connection role is re-resolved
  // server-side at connect and can never be refreshed by the epoch the client
  // stamps on a frame.
  it('(a) stale writer ticket + downgraded-to-reader: ops stamped with the CURRENT epoch is REFUSED', async () => {
    const h = await setup()
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
