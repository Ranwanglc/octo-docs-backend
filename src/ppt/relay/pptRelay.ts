/**
 * The Bento-frame WebSocket relay, hosted INSIDE B (§7.3).
 *
 * Owner-locked shape: this is NOT the Hocuspocus server and NOT a new deployable
 * service — it attaches to B's existing REST HTTP server on the
 * `/api/v1/ppt/collab` upgrade path (see {@link attachPptRelay}). It preserves
 * Bento frame semantics but enforces Octo auth/epoch and stores plaintext JSON.
 *
 * Correctness contract enforced here:
 *  - handshake authorizes via a SINGLE-USE ticket (subprotocol credential), then
 *    replays `snapshot -> ops -> ready`;
 *  - a persisted `ops` frame is validated (role, epoch, protocol version, op
 *    count, size), persisted DURABLY, ack'd to the sender ONLY after the durable
 *    write, and only THEN broadcast to peers (sender never echoes its own op);
 *  - `(docId, frameId)` is unique — a resent frame re-acks its original seq and
 *    is not rebroadcast, and this re-ack precedes the epoch/role gate so a resend
 *    after a lost ack still acknowledges an already-durable write;
 *  - a `snap` advances the snapshot version atomically, then prunes covered ops;
 *  - refusals classify retry: the retryable set is `rate-limited` + `storage-retry`
 *    (both carry a bounded `retryInMs` backoff hint); every other refusal is
 *    permanent and surfaced (the client shows unsynced state, never a silent drop);
 *  - permission epoch is the live cutoff: stale-epoch mutations are refused, and
 *    a downgrade to `none` / a deleted doc closes the socket (4403 / 4404).
 */
import type { IncomingMessage } from 'node:http'
import type { Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket } from 'ws'
import { config } from '../../config/env.js'
import { roleAtLeast, roleRank, type ResolvedRole } from '../../permission/role.js'
import { isBentoDoc, type BentoDoc } from '../bentoDoc.js'
import {
  parseClientFrame,
  opsAreValid,
  isRetryable,
  STORAGE_RETRY_BACKOFF_MS,
  type OpsFrame,
  type SnapFrame,
  type RefusedCode,
  type ServerFrame,
} from './frames.js'
import { isRetryableStorageError, RetryableStorageError, type PptRelayStore, type RelaySnapshot, type ReplayCursor } from './store.js'
import {
  verifyPptRelayTicket,
  InMemoryTicketStore,
  type TicketStore,
  type PptCollabClaims,
} from '../../auth/pptCollabToken.js'

/** WS close codes (application range) mirroring the collab-token statuses. */
export const CLOSE_UNAUTHORIZED = 4401
export const CLOSE_FORBIDDEN = 4403
export const CLOSE_NOT_FOUND = 4404
export const CLOSE_RESYNC_REQUIRED = 4410
/** WS internal-error close (RFC 6455 1011): a store failure we cannot recover. */
export const CLOSE_UNAVAILABLE = 1011

export interface RelayLimits {
  maxFrameBytes: number
  maxOpsPerFrame: number
  maxFramesPerWindow: number
  rateWindowMs: number
  maxSingleBlobBytes: number
  maxRoomFrameBytes: number
  /** Byte cap for ephemeral frames (`hello`/`need`/`p`/`bye`). */
  maxEphemeralFrameBytes: number
  /** Max op rows read per replay batch (bounds replay memory). */
  replayPageSize: number
  /** Approximate max persisted op JSON bytes per replay page. */
  replayPageBytes: number
  /** Process-wide cap for replay cursors holding store resources. */
  maxInFlightReplays: number
  /** Max live frames buffered while replay catches up. */
  maxLiveBufferFrames: number
  /** Max live frame bytes buffered while replay catches up. */
  maxLiveBufferBytes: number
  /**
   * Socket `bufferedAmount` (bytes) above which replay pauses before sending the
   * next frame, so one slow/greedy consumer cannot make the relay buffer an
   * unbounded backlog in kernel/userspace send queues (XIN-1693 P1-3).
   */
  sendHighWaterBytes: number
  /** Max time (ms) to wait for send buffer drain before closing the peer. */
  sendDrainTimeoutMs: number
  /** Periodic per-connection read-auth refresh interval. */
  authRefreshMs: number
  /** Short TTL for doc-status read-path cache. */
  docStatusCacheTtlMs: number
}

function defaultLimits(): RelayLimits {
  const r = config.ppt.relay
  return {
    maxFrameBytes: r.maxFrameBytes,
    maxOpsPerFrame: r.maxOpsPerFrame,
    maxFramesPerWindow: r.maxFramesPerWindow,
    rateWindowMs: r.rateWindowMs,
    maxSingleBlobBytes: r.maxSingleBlobBytes,
    maxRoomFrameBytes: r.maxRoomFrameBytes,
    maxEphemeralFrameBytes: r.maxEphemeralFrameBytes,
    replayPageSize: r.replayPageSize,
    replayPageBytes: r.replayPageBytes,
    maxInFlightReplays: r.maxInFlightReplays,
    maxLiveBufferFrames: r.maxLiveBufferFrames,
    maxLiveBufferBytes: r.maxLiveBufferBytes,
    sendHighWaterBytes: r.sendHighWaterBytes,
    sendDrainTimeoutMs: r.sendDrainTimeoutMs,
    authRefreshMs: r.authRefreshMs,
    docStatusCacheTtlMs: r.docStatusCacheTtlMs,
  }
}

/** Max client frames buffered during the pre-auth handshake window before they
 * are dropped (a flood before auth cannot grow memory unbounded, XIN-1693). */
const MAX_PREAUTH_FRAMES = 16
/** Poll interval (ms) while waiting for the socket send buffer to drain. */
const SEND_DRAIN_POLL_MS = 5

/** Await `ms`, resolving via a timer. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Context handed to the role re-resolver when a connection's cached role must be
 * re-validated (connect-time stale epoch, per-frame downgrade, or an epoch bump).
 *
 * It carries `documentName` and `spaceMember` — not just `(uid, docId)` — so the
 * relay can re-resolve the SAME effective role issuance did: `resolveEffectiveRole`
 * / `recheckCurrentRole` need the connection key and the caller's space-membership
 * claim to fold in an `anyone_in_space` share grant. Resolving with a direct-only
 * seam here would disagree with issuance and wrongly revoke a legitimate share
 * writer (see B6 / P1-7).
 */
export interface RoleResolutionContext {
  uid: string
  docId: string
  documentName: string
  /** Space-membership claim minted at issuance (fail-closed to false). */
  spaceMember: boolean
}

export interface PptRelayDeps {
  /** Durable op/snapshot store. */
  store: PptRelayStore
  /** Verify the ticket string -> claims (throws on invalid/expired). */
  verifyTicket?: (ticket: string) => PptCollabClaims & { jti: string }
  /** Single-use consume of a verified ticket's jti (false => already used). */
  ticketStore?: TicketStore
  /** Authoritative live epoch for a documentName (fail-closed: throw => reject). */
  epochProvider: (documentName: string) => Promise<number>
  /** Re-resolve a connection's effective role (default: none => close). */
  roleProvider?: (ctx: RoleResolutionContext) => Promise<ResolvedRole>
  /** Doc liveness for the doc-deleted guard (default: assume live). */
  docStatusProvider?: (docId: string) => Promise<'live' | 'deleted'>
  protocolVersion?: number
  limits?: Partial<RelayLimits>
}

interface ConnAuthState {
  readAllowed: boolean
  invalidated: boolean
  terminalClose?: { code: number; reason: string; refused?: RefusedCode }
}

interface Conn {
  socket: WebSocket
  uid: string
  docId: string
  documentName: string
  role: ResolvedRole
  /**
   * The permission epoch the cached `role` was resolved against. The role is
   * authoritative ONLY at this epoch; once the live epoch moves past it the
   * cached role is stale and must be re-resolved before it can authorize a
   * mutation (see {@link guardMutation}).
   */
  roleEpoch: number
  name?: string
  /** Space-membership claim minted at issuance (fed to role re-resolution). */
  spaceMember: boolean
  /** Timestamps of recently persisted frames, for the sliding-window rate limit. */
  frameTimes: number[]
  /**
   * Timestamps of recent EPHEMERAL frames (`hello`/`need`/`p`), rate-limited in a
   * SEPARATE window from persisted `ops`/`snap` so a presence/handshake flood
   * neither consumes the op budget nor is masked by it (XIN-1660 hardening).
   */
  ephemeralFrameTimes: number[]
  /**
   * True once this connection's first replay reached a stable boundary. Until
   * then — and while any replay is in flight — a peer's live op/presence frame is
   * BUFFERED (see {@link liveBuffer}) instead of delivered, so a peer op is never
   * delivered live AND again from the replay's op log (non-idempotent for the
   * ins/txt RGA), which would diverge the doc permanently (XIN-1693 P1-4).
   */
  caughtUp: boolean
  /** A replay is currently streaming to this connection (XIN-1693 P1-3). */
  replayInFlight: boolean
  /**
   * A coalesced pending replay request (latest wins) captured while one was in
   * flight. At most one replay runs and at most one is queued per connection, so a
   * `hello`/`need` burst cannot fan out into N concurrent snapshot reads (P1-3).
   */
  replayPending: { since: number; ready: boolean } | null
  /** Live frames buffered while this connection is not yet caught up (P1-4). */
  liveBuffer: ServerFrame[]
  /** Highest op seq already delivered to this connection (dedup on buffer flush). */
  lastDelivered: number
  /** Approximate bytes held in liveBuffer. */
  liveBufferBytes: number
  /** Cached read authority used by no-I/O push delivery. */
  auth: ConnAuthState
  /** Per-connection inbound ordering chain. */
  inboundChain: Promise<void>
  /** Per-connection outbound ordering chain. */
  outboundChain: Promise<void>
  /** Periodic read-auth refresh timer. */
  authTimer?: NodeJS.Timeout
}

function send(socket: WebSocket, frame: ServerFrame): void {
  try {
    socket.send(JSON.stringify(frame))
  } catch {
    /* peer closed mid-broadcast; the close handler prunes it */
  }
}

class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    this.active++
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      this.waiters.shift()?.()
    }
  }
}

/** The subprotocol marker the client and server agree on for the relay. */
export const PPT_RELAY_SUBPROTOCOL = 'ppt-relay'

/** Extract the one-time ticket from `Sec-WebSocket-Protocol` (marker + ticket). */
export function extractTicket(req: IncomingMessage): string | null {
  const raw = req.headers['sec-websocket-protocol']
  if (typeof raw !== 'string') return null
  const parts = raw.split(',').map((p) => p.trim()).filter((p) => p !== '')
  // The client sends ['ppt-relay', <ticket>]; the ticket is the non-marker token.
  const ticket = parts.find((p) => p !== PPT_RELAY_SUBPROTOCOL)
  return ticket ?? null
}

export class PptRelay {
  private readonly wss: WebSocketServer
  private readonly store: PptRelayStore
  private readonly verifyTicket: (ticket: string) => PptCollabClaims & { jti: string }
  private readonly ticketStore: TicketStore
  private readonly epochProvider: (documentName: string) => Promise<number>
  private readonly roleProvider?: (ctx: RoleResolutionContext) => Promise<ResolvedRole>
  private readonly docStatusProvider?: (docId: string) => Promise<'live' | 'deleted'>
  private readonly pv: number
  private readonly limits: RelayLimits
  private readonly rooms = new Map<string, Set<Conn>>()
  /** Cumulative persisted frame bytes per room (room-full guard). */
  private readonly roomBytes = new Map<string, number>()
  /** Rooms whose {@link roomBytes} has been seeded from durable state. */
  private readonly roomBytesSeeded = new Set<string>()
  /**
   * Per-room serialization chain for seq-allocating frames (`ops`/`snap`).
   * `onMessage` is fire-and-forget (`void`), so without this two concurrent
   * writers could allocate seq 1 and 2 but broadcast 2 before 1 — peers would
   * observe ops out of the authoritative room order. Chaining each mutating
   * frame's whole persist→ack→broadcast behind the prior one guarantees live
   * delivery follows the assigned seq (XIN-1655 C2). It also serializes the
   * room-budget read/modify so concurrent frames cannot both pass the cap and
   * lose an increment (the non-blocking `ensureRoomBudget` race).
   */
  private readonly roomChains = new Map<string, Promise<void>>()
  private readonly replaySemaphore: Semaphore
  private readonly docStatusCache = new Map<string, { status: 'live' | 'deleted'; expiresAt: number }>()

  constructor(deps: PptRelayDeps) {
    this.store = deps.store
    this.verifyTicket = deps.verifyTicket ?? verifyPptRelayTicket
    this.ticketStore = deps.ticketStore ?? new InMemoryTicketStore()
    this.epochProvider = deps.epochProvider
    this.roleProvider = deps.roleProvider
    this.docStatusProvider = deps.docStatusProvider
    this.pv = deps.protocolVersion ?? config.ppt.relay.protocolVersion
    this.limits = { ...defaultLimits(), ...(deps.limits ?? {}) }
    this.replaySemaphore = new Semaphore(this.limits.maxInFlightReplays)
    // noServer: the relay owns no listener of its own — it is attached to B's
    // existing HTTP server (no second service).
    //
    // Hardening (XIN-1660):
    //  - `maxPayload` caps a single WS message at the largest legitimate frame (a
    //    snapshot blob), so an oversized/DoS frame is dropped at the transport
    //    layer (close 1009) before the relay ever parses it.
    //  - `handleProtocols` explicitly negotiates the `ppt-relay` subprotocol so the
    //    single-use ticket carried alongside it in `Sec-WebSocket-Protocol` is never
    //    reflected back as the selected subprotocol (order-independent, unlike the
    //    ws default of echoing the first offered token).
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: this.limits.maxSingleBlobBytes,
      handleProtocols: (protocols) =>
        protocols.has(PPT_RELAY_SUBPROTOCOL) ? PPT_RELAY_SUBPROTOCOL : false,
    })
  }

  /** Attach to an existing HTTP server, handling upgrades on `/api/v1/ppt/collab`. */
  attach(server: HttpServer, path = '/api/v1/ppt/collab'): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      let pathname: string
      try {
        pathname = new URL(req.url ?? '', 'http://localhost').pathname
      } catch {
        socket.destroy()
        return
      }
      if (pathname !== path) {
        // The relay is the only upgrade handler on B's REST HTTP server (Hocuspocus
        // runs its own listener), so an upgrade on any other path is unroutable.
        // Reject and destroy it rather than leaving the socket dangling until it
        // times out — an unmatched-upgrade DoS/leak surface (XIN-1660 hardening).
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req)
      })
    })
    this.wss.on('connection', (ws, req) => {
      void this.onConnection(ws, req as IncomingMessage)
    })
  }

  /** Test seam: drive a connection directly against an already-open socket. */
  async onConnection(socket: WebSocket, req: IncomingMessage): Promise<void> {
    // Handshake listener race (Jerry-Xin round-5): `ws` does NOT buffer inbound
    // messages before a `message` listener exists, and the handshake below has
    // several awaits (ticket consume, doc-status, epoch, role — Redis/DB-backed in
    // prod). Register `message`/`close`/`error` handlers SYNCHRONOUSLY, before the
    // first await, so a client `hello` sent immediately after `open` is buffered
    // (not lost -> silent hang) and an early `close` is observed (so we never
    // `addToRoom` a socket that already went away). Frames received before auth
    // completes are queued and drained in order once `conn` is live.
    let conn: Conn | null = null
    let earlyClosed = false
    const preauth: string[] = []
    const onData = (data: unknown): void => {
      const raw = typeof data === 'string' ? data : String(data)
      if (conn) {
        conn.inboundChain = conn.inboundChain.then(() => this.onMessage(conn!, raw), () => this.onMessage(conn!, raw))
        return
      }
      if (preauth.length < MAX_PREAUTH_FRAMES) preauth.push(raw)
      // else: pre-auth flood — drop; the client gets no `ready` and can reconnect.
    }
    const onGone = (): void => {
      earlyClosed = true
      if (conn) this.removeFromRoom(conn)
    }
    socket.on('message', onData)
    socket.on('close', onGone)
    socket.on('error', onGone)

    const ticket = extractTicket(req)
    if (!ticket) {
      socket.close(CLOSE_UNAUTHORIZED, 'missing ticket')
      return
    }
    let claims: PptCollabClaims & { jti: string }
    try {
      claims = this.verifyTicket(ticket)
    } catch {
      socket.close(CLOSE_UNAUTHORIZED, 'invalid ticket')
      return
    }
    // Single-use: a replayed ticket (same jti) is rejected even if still valid.
    // A store error (e.g. Redis down for RedisTicketStore) must fail CLOSED and
    // close the just-upgraded socket rather than rejecting `onConnection` and
    // leaking an open socket with no replay protection (XIN-1655 non-blocking).
    let fresh: boolean
    try {
      fresh = await this.ticketStore.consume(claims.jti)
    } catch {
      socket.close(CLOSE_UNAUTHORIZED, 'ticket store unavailable')
      return
    }
    if (!fresh) {
      socket.close(CLOSE_UNAUTHORIZED, 'ticket already used')
      return
    }
    // Doc-deletion guard at handshake (§7.3).
    if (this.docStatusProvider) {
      try {
        if ((await this.docStatusProvider(claims.docId)) === 'deleted') {
          socket.close(CLOSE_NOT_FOUND, 'document deleted')
          return
        }
      } catch {
        socket.close(CLOSE_NOT_FOUND, 'document unavailable')
        return
      }
    }
    // Fail-closed: an unconfirmable epoch is a rejection, not a default.
    let liveEpoch: number
    try {
      liveEpoch = await this.epochProvider(claims.documentName)
    } catch {
      socket.close(CLOSE_NOT_FOUND, 'document unavailable')
      return
    }

    // The ticket's `role`/`permission_epoch` are a SNAPSHOT taken at issuance.
    // If the live epoch has advanced since, the user may have been downgraded or
    // revoked between issuance and connect, so the ticket's cached role MUST NOT
    // seed the connection's authority — otherwise a stale writer ticket could
    // mutate simply by stamping the current epoch on its frames (PPT-EPOCH-001).
    // Re-resolve the LIVE role server-side; if we cannot (no roleProvider), the
    // stale ticket is rejected so the client re-mints a fresh one. A ticket at
    // the current epoch is trusted as-is (its authority is still fresh).
    let role: ResolvedRole = claims.role
    const spaceMember = claims.space_member === true
    if (claims.permission_epoch !== liveEpoch) {
      if (!this.roleProvider) {
        socket.close(CLOSE_UNAUTHORIZED, 'stale ticket epoch')
        return
      }
      // At CONNECT the ticket's `space_member` claim is the FRESHEST membership
      // signal available (minted seconds ago at issuance, within the short ticket
      // TTL), so it is trusted as-is here — a legitimate `anyone_in_space` share
      // writer whose epoch bumped between issuance and connect must re-resolve to
      // writer, not be revoked (B6 / P1-7). The P1-6 fail-closed membership recheck
      // applies only LATER, once the claim has aged across an epoch bump (see
      // {@link refreshRoleDownOnly} / {@link applyEpochBump}): there the client can
      // re-mint to refresh the claim, whereas failing closed at connect would
      // deadlock a share writer that just presented a valid fresh ticket.
      try {
        role = await this.roleProvider({
          uid: claims.uid,
          docId: claims.docId,
          documentName: claims.documentName,
          spaceMember,
        })
      } catch {
        role = 'none'
      }
      if (role === 'none') {
        socket.close(CLOSE_FORBIDDEN, 'access revoked')
        return
      }
    }

    // If the socket already closed during the async handshake window, do NOT join
    // the room (Jerry-Xin: never `addToRoom` a closed socket).
    if (earlyClosed || socket.readyState !== WebSocket.OPEN) return

    conn = {
      socket,
      uid: claims.uid,
      docId: claims.docId,
      documentName: claims.documentName,
      role,
      // The role above was validated/re-resolved against the live epoch.
      roleEpoch: liveEpoch,
      name: claims.name,
      spaceMember,
      frameTimes: [],
      ephemeralFrameTimes: [],
      caughtUp: false,
      replayInFlight: false,
      replayPending: null,
      liveBuffer: [],
      lastDelivered: 0,
      liveBufferBytes: 0,
      auth: { readAllowed: roleAtLeast(role, 'reader'), invalidated: false },
      inboundChain: Promise.resolve(),
      outboundChain: Promise.resolve(),
    }
    this.addToRoom(conn)
    this.armAuthRefresh(conn)
    // Drain frames buffered before auth completed, in receipt order. No `await`
    // runs between assigning `conn` and this loop, so no `onData` callback can
    // interleave and reorder ahead of the queued frames.
    for (const raw of preauth) {
      conn.inboundChain = conn.inboundChain.then(() => this.onMessage(conn!, raw), () => this.onMessage(conn!, raw))
    }
  }

  private addToRoom(conn: Conn): void {
    let room = this.rooms.get(conn.docId)
    if (!room) {
      room = new Set()
      this.rooms.set(conn.docId, room)
    }
    room.add(conn)
  }

  private removeFromRoom(conn: Conn): void {
    if (conn.authTimer) clearTimeout(conn.authTimer)
    conn.authTimer = undefined
    const room = this.rooms.get(conn.docId)
    if (!room) return
    room.delete(conn)
    if (room.size === 0) {
      this.rooms.delete(conn.docId)
      // Drop the process-local budget for an empty room; it re-seeds from durable
      // state when the room is next joined, so this only bounds memory.
      this.roomBytes.delete(conn.docId)
      this.roomBytesSeeded.delete(conn.docId)
    }
  }

  private broadcast(conn: Conn, frame: ServerFrame): void {
    const room = this.rooms.get(conn.docId)
    if (!room) return
    for (const peer of room) {
      if (peer === conn) continue // sender never echoes its own op
      void this.deliver(peer, frame)
    }
  }

  private enqueueOutbound(conn: Conn, task: () => Promise<void> | void): Promise<void> {
    const run = conn.outboundChain.then(async () => {
      if (conn.socket.readyState !== WebSocket.OPEN) return
      await task()
    }, async () => {
      if (conn.socket.readyState !== WebSocket.OPEN) return
      await task()
    })
    conn.outboundChain = run.catch(() => {})
    return run
  }

  private sendFrame(conn: Conn, frame: ServerFrame): Promise<void> {
    return this.enqueueOutbound(conn, () => send(conn.socket, frame))
  }

  private closeConn(conn: Conn, code: number, reason: string): Promise<void> {
    return this.enqueueOutbound(conn, () => {
      conn.socket.close(code, reason)
      this.removeFromRoom(conn)
    })
  }

  private canPushRead(conn: Conn): boolean {
    return conn.auth.readAllowed && !conn.auth.invalidated && conn.socket.readyState === WebSocket.OPEN
  }

  /**
   * Deliver a live frame to one peer, BUFFERING it while that peer has not yet
   * caught up (its first replay has not reached a stable boundary, or a replay is
   * in flight). This is the P1-4 fix: a peer that joined the room before replaying
   * must not receive an op live AND again from its replay's op log — the ins/txt
   * RGA is non-idempotent, so a double-apply diverges the doc permanently. The
   * buffer is bounded; a peer that never catches up drops overflow and must resync
   * via reconnect rather than grow memory unbounded.
   */
  private async deliver(peer: Conn, frame: ServerFrame): Promise<void> {
    if (!this.canPushRead(peer)) {
      const terminal = peer.auth.terminalClose
      await this.closeConn(peer, terminal?.code ?? CLOSE_FORBIDDEN, terminal?.reason ?? 'read authorization invalidated')
      return
    }
    if (!peer.caughtUp || peer.replayInFlight) {
      const frameBytes = Buffer.byteLength(JSON.stringify(frame), 'utf8')
      if (
        peer.liveBuffer.length >= this.limits.maxLiveBufferFrames ||
        peer.liveBufferBytes + frameBytes > this.limits.maxLiveBufferBytes
      ) {
        const frameCount = peer.liveBuffer.length
        const bytes = peer.liveBufferBytes
        peer.liveBuffer = []
        peer.liveBufferBytes = 0
        // eslint-disable-next-line no-console
        console.warn('[ppt-relay] live buffer overflow; closing for resync', {
          docId: peer.docId,
          uid: peer.uid,
          frameCount,
          bytes,
          reason: 'live-buffer-overflow',
        })
        await this.closeConn(peer, CLOSE_RESYNC_REQUIRED, 'resync required')
        return
      }
      peer.liveBuffer.push(frame)
      peer.liveBufferBytes += frameBytes
      return
    }
    await this.sendFrame(peer, frame)
  }

  /**
   * Flush a connection's buffered live frames once its replay has caught up.
   * Op frames whose seq the replay already delivered are dropped (dedup on
   * `lastDelivered`), so an op buffered during replay that the replay also
   * streamed is delivered exactly once (P1-4).
   */
  private flushLiveBuffer(conn: Conn): void {
    if (conn.liveBuffer.length === 0) return
    const buffered = conn.liveBuffer
    conn.liveBuffer = []
    conn.liveBufferBytes = 0
    for (const frame of buffered) {
      if (frame.ctl === 'op') {
        if (frame.q <= conn.lastDelivered) continue
        conn.lastDelivered = frame.q
      }
      void this.sendFrame(conn, frame)
    }
  }

  /**
   * Send a replay frame, PAUSING first while the socket's send buffer is over the
   * high-water mark so a slow/greedy consumer cannot make the relay accumulate an
   * unbounded backlog (XIN-1693 P1-3). Bounded by the drain timeout so a
   * wedged client cannot stall replay forever; on a closed socket it is a no-op.
   */
  private async gatedSend(conn: Conn, frame: ServerFrame): Promise<void> {
    const socket = conn.socket
    let waited = 0
    while (
      socket.readyState === WebSocket.OPEN &&
      socket.bufferedAmount > this.limits.sendHighWaterBytes &&
      waited < this.limits.sendDrainTimeoutMs
    ) {
      await delay(SEND_DRAIN_POLL_MS)
      waited += SEND_DRAIN_POLL_MS
    }
    if (socket.readyState !== WebSocket.OPEN) return
    if (socket.bufferedAmount > this.limits.sendHighWaterBytes) {
      await this.closeConn(conn, CLOSE_UNAVAILABLE, 'send drain timeout')
      return
    }
    await this.sendFrame(conn, frame)
  }

  /**
   * Run a seq-allocating frame handler serialized behind any prior one for the
   * SAME room, so seq allocation and the subsequent broadcast happen in the same
   * order (XIN-1655 C2). The chained tail never rejects (a handler owns its own
   * error surfacing via `refuse`), so one frame's failure cannot stall the room's
   * queue. The map entry is dropped once the chain drains, bounding memory to the
   * set of rooms with in-flight mutations.
   */
  private runSerialized(docId: string, task: () => Promise<void>): Promise<void> {
    const prev = this.roomChains.get(docId) ?? Promise.resolve()
    const run = prev.then(task, task).catch((err) => {
      // A handler owns its own client-facing error surfacing (via `refuse`); this
      // tail only guards the CHAIN so one frame's failure cannot stall the room's
      // queue. A throw reaching here is unexpected — log it rather than silently
      // discard, so a latent handler bug is observable (XIN-1693 P2-j).
      // eslint-disable-next-line no-console
      console.warn('[ppt-relay] serialized frame handler threw:', err)
    })
    this.roomChains.set(docId, run)
    void run.then(() => {
      if (this.roomChains.get(docId) === run) this.roomChains.delete(docId)
    })
    return run
  }

  private refuse(
    conn: Conn,
    code: RefusedCode,
    opts: { k?: number; frameId?: string; message?: string; retryInMs?: number } = {},
  ): void {
    const retryable = isRetryable(code)
    // Both retryable codes carry a bounded backoff hint. `rate-limited` supplies
    // its window-derived delay via opts; `storage-retry` defaults to a small fixed
    // backoff (STORAGE_RETRY_BACKOFF_MS) when a caller does not pass one, so the
    // client always has a concrete delay instead of an unbounded busy-retry.
    const retryInMs =
      opts.retryInMs !== undefined ? opts.retryInMs : code === 'storage-retry' ? STORAGE_RETRY_BACKOFF_MS : undefined
    void this.sendFrame(conn, {
      ctl: 'refused',
      code,
      retryable,
      ...(retryable && retryInMs !== undefined ? { retryInMs } : {}),
      ...(opts.k !== undefined ? { k: opts.k } : {}),
      ...(opts.frameId !== undefined ? { frameId: opts.frameId } : {}),
      ...(opts.message !== undefined ? { message: opts.message } : {}),
    })
  }

  /**
   * Byte-cap + rate-limit an ephemeral frame (`hello`/`need`/`p`). Returns true
   * (and has already sent the refusal) when the frame must be dropped. Ephemeral
   * frames were previously unguarded — only `ops`/`snap` were capped — leaving a
   * floodable ingress; they use a SEPARATE rate window from persisted frames so a
   * presence/handshake flood neither drains the op budget nor is hidden by it.
   */
  private enforceEphemeralLimits(conn: Conn, rawBytes: number): boolean {
    if (rawBytes > this.limits.maxEphemeralFrameBytes) {
      this.refuse(conn, 'too-large', { message: 'ephemeral frame exceeds size limit' })
      return true
    }
    const retryInMs = this.rateLimited(conn.ephemeralFrameTimes)
    if (retryInMs !== null) {
      this.refuse(conn, 'rate-limited', { retryInMs })
      return true
    }
    return false
  }

  private async onMessage(conn: Conn, raw: string): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.refuse(conn, 'protocol-version', { message: 'malformed JSON frame' })
      return
    }
    const result = parseClientFrame(parsed, this.pv)
    if (!result.ok) {
      this.refuse(conn, result.code, { k: result.k, frameId: result.frameId, message: result.message })
      return
    }
    const frame = result.frame
    // Byte size of the wire frame for the size/room limits. `raw.length` is a
    // UTF-16 code-unit count that UNDERCOUNTS multi-byte JSON; the limits are
    // byte budgets, so measure real UTF-8 bytes.
    const rawBytes = Buffer.byteLength(raw, 'utf8')
    switch (frame.t) {
      case 'hello':
        if (this.enforceEphemeralLimits(conn, rawBytes)) return
        if (!(await this.refreshReadAuth(conn, 'hello'))) return
        this.requestReplay(conn, typeof frame.since === 'number' ? frame.since : 0, /* ready */ true)
        return
      case 'need':
        if (this.enforceEphemeralLimits(conn, rawBytes)) return
        if (!(await this.refreshReadAuth(conn, 'need'))) return
        this.requestReplay(conn, typeof frame.since === 'number' ? frame.since : 0, /* ready */ false)
        return
      case 'p':
        if (this.enforceEphemeralLimits(conn, rawBytes)) return
        // A revoked/soft-deleted/downgraded-to-none reader must not broadcast
        // presence either — gate `p` with the same read-path authz (P1-2).
        if (!(await this.refreshReadAuth(conn, 'presence'))) return
        this.broadcast(conn, { ctl: 'presence', uid: conn.uid, ...(conn.name ? { name: conn.name } : {}), presence: (frame as { presence?: unknown }).presence })
        return
      case 'bye':
        // `bye` is terminal (it closes the socket), so it is byte-capped but not
        // rate-limited — a flood of them is bounded by the close on the first.
        if (rawBytes > this.limits.maxEphemeralFrameBytes) {
          this.refuse(conn, 'too-large', { message: 'ephemeral frame exceeds size limit' })
          return
        }
        this.broadcast(conn, { ctl: 'presence', uid: conn.uid, ...(conn.name ? { name: conn.name } : {}), presence: undefined })
        void this.closeConn(conn, 1000, 'bye')
        return
      case 'ops':
        // Serialize per room so the assigned seq order is also the broadcast
        // order (XIN-1655 C2).
        await this.runSerialized(conn.docId, () => this.handleOps(conn, frame as OpsFrame, rawBytes))
        return
      case 'snap':
        await this.runSerialized(conn.docId, () => this.handleSnap(conn, frame as SnapFrame, rawBytes))
        return
      default:
        this.refuse(conn, 'protocol-version', { message: 'unhandled frame type' })
    }
  }

  /**
   * Read-path authorization for `hello`/`need`/`p` (§7.3 / XIN-1693 P1-2).
   *
   * `replay()` used to serve the full snapshot + op log after only a handshake
   * ticket check, so a reader revoked or soft-deleted AFTER connect kept receiving
   * state for the whole socket lifetime (unbounded by the ticket TTL). Give the
   * read path the SAME doc-status / epoch / role gate `guardMutation` enforces on
   * `ops`/`snap`: a deleted doc closes 4404, a revoked (`none`) role closes 4403,
   * and a stale epoch triggers a downgrade-only re-resolution (with the P1-6
   * share-membership fail-closed check). Returns false when the connection was
   * refused/closed (the caller must not proceed).
   */
  private async readDocStatus(conn: Conn): Promise<'live' | 'deleted'> {
    if (!this.docStatusProvider) return 'live'
    const cached = this.docStatusCache.get(conn.docId)
    const now = Date.now()
    if (cached && cached.expiresAt > now) return cached.status
    const status = await this.docStatusProvider(conn.docId)
    this.docStatusCache.set(conn.docId, {
      status,
      expiresAt: now + (status === 'deleted' ? this.limits.docStatusCacheTtlMs : 0),
    })
    return status
  }

  private armAuthRefresh(conn: Conn): void {
    const jitter = Math.floor(Math.random() * Math.max(1, this.limits.authRefreshMs / 5))
    conn.authTimer = setTimeout(() => {
      void this.refreshReadAuth(conn, 'timer').finally(() => {
        if (this.rooms.get(conn.docId)?.has(conn) && conn.socket.readyState === WebSocket.OPEN) this.armAuthRefresh(conn)
      })
    }, this.limits.authRefreshMs + jitter)
  }

  private async refreshReadAuth(conn: Conn, _reason: string): Promise<boolean> {
    if (conn.socket.readyState !== WebSocket.OPEN) return false
    if (this.docStatusProvider) {
      let deleted: boolean
      try {
        deleted = (await this.readDocStatus(conn)) === 'deleted'
      } catch {
        deleted = true // fail closed
      }
      if (deleted) {
        conn.auth = { readAllowed: false, invalidated: false, terminalClose: { code: CLOSE_NOT_FOUND, reason: 'document deleted', refused: 'doc-deleted' } }
        this.refuse(conn, 'doc-deleted', { message: 'document deleted' })
        await this.closeConn(conn, CLOSE_NOT_FOUND, 'document deleted')
        return false
      }
    }
    let live: number
    try {
      live = await this.epochProvider(conn.documentName)
    } catch {
      // Unconfirmable epoch on the read path: fail closed rather than serve state.
      conn.auth = { readAllowed: false, invalidated: false, terminalClose: { code: CLOSE_NOT_FOUND, reason: 'document unavailable', refused: 'doc-deleted' } }
      this.refuse(conn, 'doc-deleted', { message: 'document unavailable' })
      await this.closeConn(conn, CLOSE_NOT_FOUND, 'document unavailable')
      return false
    }
    if (conn.roleEpoch !== live) {
      const closed = await this.refreshRoleDownOnly(conn, live)
      if (closed) return false
    }
    if (!roleAtLeast(conn.role, 'reader')) {
      conn.auth = { readAllowed: false, invalidated: false, terminalClose: { code: CLOSE_FORBIDDEN, reason: 'access revoked', refused: 'forbidden-role' } }
      this.refuse(conn, 'forbidden-role', { message: 'access revoked' })
      await this.closeConn(conn, CLOSE_FORBIDDEN, 'access revoked')
      return false
    }
    conn.auth = { readAllowed: true, invalidated: false }
    return true
  }

  /**
   * Request a replay, coalescing bursts so at most ONE replay runs and at most one
   * is queued per connection (XIN-1693 P1-3). `onMessage` is fire-and-forget, so
   * without this a 50-`hello` burst would fan out into 50 concurrent snapshot
   * reads. A request arriving while a replay is in flight overwrites the pending
   * one (latest cursor wins) rather than stacking.
   */
  private requestReplay(conn: Conn, since: number, ready: boolean): void {
    if (conn.replayInFlight) {
      conn.replayPending = { since, ready }
      return
    }
    conn.replayInFlight = true
    void this.runReplay(conn, since, ready)
  }

  /** Drive one replay, then either run a coalesced pending one or, once none
   * remains, mark the connection caught up and flush its buffered live frames. */
  private async runReplay(conn: Conn, since: number, ready: boolean): Promise<void> {
    let ok = false
    try {
      ok = await this.replay(conn, since, ready)
    } catch {
      ok = false
    }
    conn.replayInFlight = false
    const pending = conn.replayPending
    conn.replayPending = null
    if (pending && conn.socket.readyState === WebSocket.OPEN) {
      conn.replayInFlight = true
      void this.runReplay(conn, pending.since, pending.ready)
      return
    }
    // Only a SUCCESSFUL replay establishes the caught-up boundary. A refused
    // replay (e.g. a bogus cursor) leaves the connection buffering so it does not
    // receive live ops with no base state; the client re-hello's with a valid
    // cursor and that replay flushes.
    if (ok) {
      conn.caughtUp = true
      this.flushLiveBuffer(conn)
    }
  }

  /**
   * Replay `snapshot -> ops since q -> ready` (§7.3). `need` omits the ready.
   * Returns true when the replay completed successfully (the caller then marks the
   * connection caught up and flushes buffered live frames), false on a refusal.
   *
   * `since` is an OP-SEQUENCE cursor, NOT a snapshot version (XIN-1655 C5): the
   * client resumes from the highest op seq it has already applied — 0 on a fresh
   * join, or the last `ready.q`/`op.q`/`ack.q` it saw on a reconnect. The
   * `snapshotVersion` the collab-token hands the client is a version TAG for
   * change detection, never a replay cursor.
   *
   * `since` is client-supplied. A cursor ABOVE the room high-water cannot arise
   * legitimately (the counter never regresses), so it is REFUSED as a protocol
   * error rather than clamped — clamping would endorse a non-existent boundary
   * back in `ready.q` and make the client skip every op below it (XIN-1693 P2-e).
   *
   * The high-water, snapshot, and op tail are read as ONE consistent view
   * ({@link PptRelayStore.openReplay}) so a concurrent `snap`+prune cannot slip
   * between them and leave a reader with neither the snapshot nor the pruned ops
   * (XIN-1693 P1-4). A store failure surfaces a `storage-failed` refusal + close,
   * never a silent hang (XIN-1655 C4). Replay sends are backpressure-gated (P1-3).
   */
  private async replay(conn: Conn, rawSince: number, ready = true): Promise<boolean> {
    if (!(await this.refreshReadAuth(conn, 'replay-start'))) return false
    let release: (() => void) | null = null
    let cursor: ReplayCursor | null = null
    try {
      release = await this.replaySemaphore.acquire()
      cursor = this.store.openReplay
        ? await this.store.openReplay(conn.docId, rawSince, {
          pageRows: this.limits.replayPageSize,
          pageBytes: this.limits.replayPageBytes,
        })
        : await this.composeReplayCursor(conn.docId, rawSince)
    } catch (err) {
      const code = isRetryableStorageError(err) ? 'storage-retry' : 'storage-failed'
      this.refuse(conn, code, { message: 'replay failed' })
      if (code === 'storage-failed') await this.closeConn(conn, CLOSE_UNAVAILABLE, 'replay failed')
      release?.()
      return false
    }
    const { highWater, snapshot } = cursor
    if (rawSince > highWater) {
      this.refuse(conn, 'protocol-version', { message: 'resume cursor exceeds room high-water' })
      await cursor.close()
      release?.()
      return false
    }
    try {
      let fromSeq = rawSince
      // Only send the snapshot to a peer behind it; an already-synced peer is not
      // forced to reapply it (PPT-COLLAB-003).
      if (snapshot && rawSince < snapshot.coveredSeq) {
        await this.gatedSend(conn, { ctl: 'snapshot', snapshotVersion: snapshot.snapshotVersion, doc: snapshot.doc })
        fromSeq = snapshot.coveredSeq
      }
      // Highest op seq ACTUALLY delivered, so `ready.q` reports what the client is
      // truly synced through, not the counter high-water (XIN-1655 C6).
      let delivered = fromSeq
      for (;;) {
        if (!(await this.refreshReadAuth(conn, 'replay-page'))) {
          await cursor.close()
          release?.()
          return false
        }
        const ops = await cursor.nextPage()
        if (ops.length === 0) break
        for (const op of ops) {
          if (op.seq <= fromSeq) continue
          await this.gatedSend(conn, { ctl: 'op', q: op.seq, frame: op.frame })
          delivered = op.seq
        }
      }
      conn.lastDelivered = Math.max(conn.lastDelivered, delivered)
      if (ready) {
        // Fallback is the connection's last-known LIVE epoch (validated at
        // handshake), NOT the snapshot version — stamping a snapshot counter as an
        // epoch would make every subsequent mutation fail `stale-epoch` with no
        // recovery.
        let epoch = conn.roleEpoch
        try {
          epoch = await this.epochProvider(conn.documentName)
        } catch {
          /* keep replay usable with the last-known epoch; mutation re-checks */
        }
        await this.gatedSend(conn, {
          ctl: 'ready',
          q: delivered,
          snapshotVersion: snapshot?.snapshotVersion ?? 0,
          epoch,
          role: conn.role,
        })
      }
      await cursor.close()
      release?.()
      return true
    } catch (err) {
      try {
        await cursor.close()
      } catch {
        /* ignore close failure */
      }
      release?.()
      const code = isRetryableStorageError(err) ? 'storage-retry' : 'storage-failed'
      this.refuse(conn, code, { message: 'replay failed' })
      if (code === 'storage-failed') await this.closeConn(conn, CLOSE_UNAVAILABLE, 'replay failed')
      return false
    }
  }

  /**
   * Fallback replay view for a store that does not implement the atomic
   * {@link PptRelayStore.openReplay} seam: compose the individual reads (paged) as
   * the pre-P1-4 code did. Production ({@link DbPptRelayStore}) and the in-memory
   * store both provide `openReplay`, so this only serves bespoke test doubles.
   */
  private async composeReplayCursor(docId: string, sinceSeq: number): Promise<ReplayCursor> {
    const highWater = await this.store.currentSeq(docId)
    const snapshot = await this.store.getSnapshot(docId)
    const pageSize = this.limits.replayPageSize
    let cursor = sinceSeq
    let closed = false
    return {
      highWater,
      snapshot,
      fromSeq: sinceSeq,
      nextPage: async () => {
        if (closed) return []
        const rows = await this.store.opsSince(docId, cursor, pageSize)
        const page = []
        let bytes = 0
        for (const row of rows) {
          const frameBytes = row.frameBytes ?? Buffer.byteLength(JSON.stringify(row.frame), 'utf8')
          if (page.length > 0 && bytes + frameBytes > this.limits.replayPageBytes) break
          page.push(row)
          bytes += frameBytes
        }
        if (page.length > 0) cursor = page[page.length - 1]!.seq
        return page
      },
      close: async () => {
        closed = true
      },
    }
  }

  /**
   * Shared pre-persist validation for `ops`/`snap` (returns a code or null).
   * `maxBytes` is the size gate for THIS frame kind: an op frame uses the small
   * per-frame limit, a snapshot the larger single-blob limit — so the snapshot
   * blob budget actually binds rather than being pre-empted by the op-frame cap.
   */
  private async guardMutation(conn: Conn, frameEpoch: number, rawBytes: number, maxBytes: number): Promise<RefusedCode | null> {
    if (rawBytes > maxBytes) return 'too-large'
    if (this.docStatusProvider) {
      try {
        if ((await this.readDocStatus(conn)) === 'deleted') return 'doc-deleted'
      } catch {
        return 'doc-deleted'
      }
    }
    // Epoch is the live cutoff and is checked BEFORE role: a frame stamped with a
    // pre-downgrade epoch is `stale-epoch` (the client must catch up / refetch),
    // regardless of what the connection's role has since become. A frame at the
    // CURRENT epoch then falls through to the role gate below.
    let live: number
    try {
      live = await this.epochProvider(conn.documentName)
    } catch {
      return 'stale-epoch'
    }
    if (frameEpoch !== live) return 'stale-epoch'
    // The cached role is authoritative ONLY at the epoch it was resolved against.
    // If the live epoch has advanced since (a downgrade/revocation not yet pushed
    // via applyEpochBump), the cached role is stale and must NOT be honored just
    // because the client stamped the current epoch on this frame. Re-resolve and
    // apply DOWNGRADES only — an upgrade still requires a fresh ticket
    // (PPT-EPOCH-003) — failing closed to `none` when re-resolution is impossible.
    if (conn.roleEpoch !== live) {
      if (await this.refreshRoleDownOnly(conn, live)) return 'forbidden-role'
    }
    // Only writer/admin may persist; a reader/commenter (or a downgraded socket
    // at the current epoch) is refused `forbidden-role`.
    if (!roleAtLeast(conn.role, 'writer')) return 'forbidden-role'
    return null
  }

  /**
   * Re-resolve a connection's EFFECTIVE role, with the P1-6 share-membership
   * fail-closed check baked in. The relay holds no octo session token on a live
   * socket, so it cannot re-derive fresh space membership — it only has the
   * `space_member` claim FROZEN at ticket issuance. If a connection's authority
   * currently DEPENDS on that frozen claim (its role WITH the claim differs from
   * its role WITHOUT it, i.e. an `anyone_in_space` share grant is load-bearing),
   * the claim can no longer be trusted and we signal the caller to fail closed
   * (close the socket) so the client re-presents fresh membership via a new
   * ticket. When the claim is NOT load-bearing (direct role dominates, or the
   * connection never carried a membership claim) the claim-independent role is
   * authoritative and returned. `share_scope`/`share_role` are still read FRESH by
   * the provider, so a scope narrowing tightens immediately either way.
   */
  private async recheckRole(
    ctx: RoleResolutionContext,
  ): Promise<{ kind: 'role'; role: ResolvedRole } | { kind: 'close-membership' }> {
    if (!this.roleProvider) return { kind: 'role', role: 'none' }
    let withClaim: ResolvedRole
    try {
      withClaim = await this.roleProvider(ctx)
    } catch {
      return { kind: 'role', role: 'none' }
    }
    // Without a space-membership claim the share grant contributes nothing, so the
    // frozen claim can never be load-bearing — skip the second resolve.
    if (!ctx.spaceMember) return { kind: 'role', role: withClaim }
    let withoutClaim: ResolvedRole
    try {
      withoutClaim = await this.roleProvider({ ...ctx, spaceMember: false })
    } catch {
      withoutClaim = 'none'
    }
    if (roleRank(withClaim) !== roleRank(withoutClaim)) return { kind: 'close-membership' }
    return { kind: 'role', role: withoutClaim }
  }

  /**
   * Re-resolve `conn.role` against the current `live` epoch, applying ONLY a
   * downgrade (elevated authority needs a fresh ticket per PPT-EPOCH-003). Fails
   * closed to `none` when no roleProvider is wired or the lookup throws, so a
   * mutation can never ride a role that predates the live epoch. Stamps
   * `roleEpoch = live` so a settled connection re-resolves at most once per epoch
   * change. Returns true when it CLOSED the socket because the frozen
   * space-membership claim became load-bearing and unverifiable (P1-6).
   */
  private async refreshRoleDownOnly(conn: Conn, live: number): Promise<boolean> {
    const outcome = await this.recheckRole({
      uid: conn.uid,
      docId: conn.docId,
      documentName: conn.documentName,
      spaceMember: conn.spaceMember,
    })
    if (outcome.kind === 'close-membership') {
      conn.role = 'none'
      conn.auth = { readAllowed: false, invalidated: false, terminalClose: { code: CLOSE_FORBIDDEN, reason: 'membership recheck required' } }
      void this.closeConn(conn, CLOSE_FORBIDDEN, 'membership recheck required')
      return true
    }
    if (roleRank(outcome.role) < roleRank(conn.role)) conn.role = outcome.role
    conn.roleEpoch = live
    conn.auth = { readAllowed: roleAtLeast(conn.role, 'reader'), invalidated: false }
    return false
  }

  /** Sliding-window rate limit over `times`; returns retry delay ms when over. */
  private rateLimited(times: number[]): number | null {
    const now = Date.now()
    const windowStart = now - this.limits.rateWindowMs
    // Compact in place so the caller's array stays the live window.
    let write = 0
    for (const t of times) if (t > windowStart) times[write++] = t
    times.length = write
    if (times.length >= this.limits.maxFramesPerWindow) {
      const oldest = times[0] ?? now
      return Math.max(1, oldest + this.limits.rateWindowMs - now)
    }
    times.push(now)
    return null
  }

  /**
   * Return the room's current persisted-byte budget usage, seeding it once from
   * durable state. The counter is process-local, so on a fresh process (restart,
   * or another node) it would otherwise start at 0 and ignore already-persisted
   * ops; seeding from the store's `roomBytes` makes the first frame per room
   * account for the durable backlog. A seed read that FAILS is fail-CLOSED: it
   * throws a retryable storage error so the frame is refused `storage-retry` (the
   * client re-sends) rather than admitted against a wrong 0-byte budget, which
   * would let a full room accept unbounded frames until the seed happens to
   * succeed (XIN-1693 P2-c).
   */
  private async ensureRoomBudget(docId: string): Promise<number> {
    if (!this.roomBytesSeeded.has(docId)) {
      try {
        const durable = await this.store.roomBytes(docId)
        // Do not clobber bytes counted by frames that landed during the seed read.
        this.roomBytes.set(docId, Math.max(durable, this.roomBytes.get(docId) ?? 0))
        this.roomBytesSeeded.add(docId)
      } catch (err) {
        throw new RetryableStorageError('room budget seed read failed', { cause: err })
      }
    }
    return this.roomBytes.get(docId) ?? 0
  }

  private async handleOps(conn: Conn, frame: OpsFrame, rawBytes: number): Promise<void> {
    const k = typeof frame.k === 'number' ? frame.k : undefined
    const frameId = typeof frame.frameId === 'string' ? frame.frameId : undefined
    if (!frameId) {
      this.refuse(conn, 'protocol-version', { k, message: 'ops frame requires frameId' })
      return
    }
    if (!opsAreValid(frame.ops)) {
      this.refuse(conn, 'protocol-version', { k, frameId, message: 'ops must be an array of whitelisted op kinds' })
      return
    }
    if (frame.ops.length > this.limits.maxOpsPerFrame) {
      this.refuse(conn, 'too-large', { k, frameId, message: 'op count exceeds per-frame limit' })
      return
    }
    // D3 / idempotent-resend: a KNOWN-DUPLICATE resend (its original ack was lost)
    // must re-ack its stored seq and MUST NOT be refused — never `room-full` /
    // `rate-limited`, and never `stale-epoch` / `forbidden-role` / `doc-deleted`
    // either. A pure re-ack of an already-durable frame is NOT a new mutation, so
    // it runs BEFORE `guardMutation` (the epoch/role/status/size gate) and BEFORE
    // the byte/rate accounting: a duplicate must acknowledge the durable original
    // even from a connection that was since downgraded or whose epoch advanced,
    // otherwise a resend after a lost ack leaves the client showing unsynced state
    // for a write that actually committed. The lookup is a CURRENT read of the
    // dedup ledger; it consumes neither budget nor a rate slot, does not persist,
    // and is not rebroadcast — it only echoes the already-committed seq. A lookup
    // failure falls through to the normal path (appendOp still dedups
    // authoritatively). A genuinely NEW frame (`known === null`) still hits
    // `guardMutation` below, so a downgraded/stale-epoch connection is refused for
    // any mutation that is not a known-durable duplicate.
    let known: number | null = null
    try {
      known = await this.store.frameSeq(conn.docId, frameId)
    } catch {
      /* fall through: appendOp's ledger PK remains the authoritative dedup */
    }
    if (known !== null) {
      let snapshotVersion = 0
      try {
        const snap = await this.store.getSnapshot(conn.docId)
        snapshotVersion = snap?.snapshotVersion ?? 0
      } catch {
        /* keep the re-ack: the frame is already durable regardless of this read */
      }
      // `k` is echoed back as the ack counter; apply `?? 0` consistently across
      // every ack path so an omitted `k` never lands as `undefined` in the frame
      // (P2-h — parse also refuses a non-integer `k`).
      void this.sendFrame(conn, { ctl: 'ack', k: frame.k ?? 0, q: known, snapshotVersion })
      return
    }
    // Not a known duplicate: enforce the mutation gate (size / doc-status / epoch /
    // role). Only genuinely new mutations reach here, so a downgraded or
    // stale-epoch connection is refused for any write it has not already committed.
    const guardCode = await this.guardMutation(conn, typeof frame.epoch === 'number' ? frame.epoch : -1, rawBytes, this.limits.maxFrameBytes)
    if (guardCode) {
      this.refuse(conn, guardCode, { k, frameId })
      return
    }
    // Room-full: a room whose durable frame bytes would exceed the cap refuses
    // further persisted frames (permanent). The budget is measured in PERSISTED
    // frame bytes (what a prune later reclaims), seeded once from durable state so
    // a restart does not silently reset the room to empty (see ensureRoomBudget).
    const frameBytes = Buffer.byteLength(JSON.stringify(frame), 'utf8')
    let roomUsed: number
    try {
      roomUsed = await this.ensureRoomBudget(conn.docId)
    } catch (err) {
      // The room-budget seed read could not be confirmed — fail closed and
      // RETRYABLY rather than admit the frame against a wrong 0 budget (P2-c).
      const code = isRetryableStorageError(err) ? 'storage-retry' : 'storage-failed'
      this.refuse(conn, code, { k, frameId, message: 'room budget unavailable' })
      return
    }
    if (roomUsed + frameBytes > this.limits.maxRoomFrameBytes) {
      this.refuse(conn, 'room-full', { k, frameId, message: 'room frame budget exhausted' })
      return
    }
    const retryInMs = this.rateLimited(conn.frameTimes)
    if (retryInMs !== null) {
      this.refuse(conn, 'rate-limited', { k, frameId, retryInMs })
      return
    }

    // Persist DURABLY before acking (§7.3). A duplicate frameId re-acks its
    // original seq and is NOT rebroadcast (idempotent resend).
    let seq: number
    let duplicate: boolean
    try {
      const res = await this.store.appendOp(conn.docId, frameId, frame)
      seq = res.seq
      duplicate = res.duplicate
    } catch (err) {
      // A TRANSIENT lock failure that outlived the store's retries is
      // `storage-retry` (retryable) so the client re-sends; anything else is a
      // permanent `storage-failed` (XIN-1693 P1-5).
      const code = isRetryableStorageError(err) ? 'storage-retry' : 'storage-failed'
      this.refuse(conn, code, { k, frameId, message: 'durable persistence failed' })
      return
    }
    if (!duplicate) this.roomBytes.set(conn.docId, roomUsed + frameBytes)

    // Post-commit: the write is DURABLE, so the sender MUST get an ack (never a
    // silent drop, §7.3). Reading the snapshot version for the ack is best-effort
    // — a failure there must not swallow the ack for an already-persisted op.
    let snapshotVersion = 0
    try {
      const snap = await this.store.getSnapshot(conn.docId)
      snapshotVersion = snap?.snapshotVersion ?? 0
    } catch {
      /* keep the ack: the op is durable regardless of the snapshot read */
    }
    // Ack the sender ONLY after the durable write.
    void this.sendFrame(conn, { ctl: 'ack', k: frame.k ?? 0, q: seq, snapshotVersion })
    // Broadcast to peers only for a first-seen frame (no echo, no double-apply).
    if (!duplicate) this.broadcast(conn, { ctl: 'op', q: seq, frame })
  }

  private async handleSnap(conn: Conn, frame: SnapFrame, rawBytes: number): Promise<void> {
    const k = typeof frame.k === 'number' ? frame.k : undefined
    // The single-blob limit is enforced inside guardMutation (as this frame's
    // size gate) so a legitimately large snapshot is not pre-empted by the small
    // per-op-frame cap.
    const guardCode = await this.guardMutation(conn, typeof frame.epoch === 'number' ? frame.epoch : -1, rawBytes, this.limits.maxSingleBlobBytes)
    if (guardCode) {
      this.refuse(conn, guardCode, { k })
      return
    }
    if (!isBentoDoc(frame.doc)) {
      this.refuse(conn, 'snapshot-conflict', { k, message: 'snapshot is not a valid bento/slides doc' })
      return
    }
    const covered = typeof frame.q === 'number' ? frame.q : -1
    // D4: the preflight reads run inside `runSerialized`, whose chain tail is
    // `.catch(()=>{})` — an unguarded throw here is swallowed, so the writer gets
    // neither `ack` nor `refused` and hangs (the same defect class C4 closed in
    // `replay()`). Wrap them so a storage failure surfaces `storage-failed`.
    let currentSeq: number
    let existing: RelaySnapshot | null
    try {
      currentSeq = await this.store.currentSeq(conn.docId)
      existing = await this.store.getSnapshot(conn.docId)
    } catch {
      this.refuse(conn, 'storage-failed', { k, message: 'snapshot preflight failed' })
      return
    }
    // A snapshot must cover a real, non-regressing prefix of the op log.
    if (covered < 0 || covered > currentSeq || (existing && covered < existing.coveredSeq)) {
      this.refuse(conn, 'snapshot-conflict', { k, message: 'snapshot covered seq conflicts with the op log' })
      return
    }
    // Rate-limit the persisted snapshot alongside `ops` (shared window): only ops
    // were rate-limited before, so a client could flood `snap` frames uncapped
    // (XIN-1660 hardening). Checked after the conflict guard so a rejected snapshot
    // does not consume a rate slot.
    const retryInMs = this.rateLimited(conn.frameTimes)
    if (retryInMs !== null) {
      this.refuse(conn, 'rate-limited', { k, retryInMs })
      return
    }
    let snapshotVersion: number
    let prunableSeq: number
    try {
      const res = await this.store.saveSnapshot({ docId: conn.docId, coveredSeq: covered, doc: frame.doc as BentoDoc })
      snapshotVersion = res.snapshotVersion
      // Prune with the AUTHORITATIVE post-write coveredSeq the store read back
      // (GREATEST(existing, incoming)), never the client's raw `q`: a snapshot may
      // only ever prune the op prefix the persisted doc actually subsumes, so an
      // op the snapshot did not cover can never be deleted (XIN-1693 P0-1). Parse
      // already refuses a fractional/out-of-range `q`, so this is defense in depth.
      prunableSeq = res.coveredSeq ?? covered
    } catch (err) {
      const code = isRetryableStorageError(err) ? 'storage-retry' : 'storage-failed'
      this.refuse(conn, code, { k, message: 'snapshot persistence failed' })
      return
    }
    // GC only AFTER the snapshot is durable (§7.3). The snapshot is already
    // committed, so a prune failure must NOT swallow the ack (the pruned ops are
    // subsumed by the durable snapshot; leaving them just defers GC). Reclaim the
    // freed bytes from the room budget so it does not monotonically grow.
    try {
      const freed = await this.store.pruneOpsThrough(conn.docId, prunableSeq)
      if (this.roomBytesSeeded.has(conn.docId)) {
        const used = this.roomBytes.get(conn.docId) ?? 0
        this.roomBytes.set(conn.docId, Math.max(0, used - freed))
      }
    } catch {
      /* keep the ack: the snapshot is durable; prune is best-effort GC */
    }
    void this.sendFrame(conn, { ctl: 'ack', k: frame.k ?? 0, q: covered, snapshotVersion })
  }

  /**
   * React to a permission-epoch bump on a room (§7.4). A doc soft-delete bumps
   * the epoch and publishes the SAME invalidation event (see
   * `docMetaRepo.softDelete` + `refreshAndPublish`), so this is also the live
   * signal that wires {@link closeRoomForDeleted}: a deleted doc closes its
   * sockets with 4404 (document deleted), which takes precedence over the role
   * path below (a revoked-but-live doc closes 4403). Otherwise it re-resolves
   * each connection's role and applies ONLY the safe direction on the live socket:
   *   · `none`      → close the socket (4403); access revoked.
   *   · a DOWNGRADE → lower `conn.role` and notify `role-changed` so the client
   *                   disables editing; old-epoch frames in flight are refused.
   *   · an UPGRADE  → deliberately NOT applied to the live socket. Elevated
   *                   authority requires a FRESH token/ticket (PPT-EPOCH-003), so
   *                   the old socket stays non-mutating until the client
   *                   reconnects. We do not raise privileges mid-connection.
   * No-op for the role path when no `roleProvider` was injected (deletion-close
   * still runs).
   */
  async applyEpochBump(documentName: string): Promise<void> {
    this.docStatusCache.clear()
    for (const room of this.rooms.values()) {
      for (const conn of room) {
        if (conn.documentName === documentName) {
          conn.auth.invalidated = true
          conn.auth.readAllowed = false
        }
      }
    }
    // Deletion takes precedence: a doc that is now gone closes 4404, not 4403.
    // (This also covers the case where deletion is the only reason for the bump.)
    if (this.docStatusProvider) {
      const docIds = new Set<string>()
      for (const room of this.rooms.values()) {
        for (const conn of room) {
          if (conn.documentName === documentName) docIds.add(conn.docId)
        }
      }
      for (const docId of docIds) {
        let deleted = false
        try {
          deleted = (await this.docStatusProvider(docId)) === 'deleted'
        } catch {
          // A transient status-lookup failure is NOT treated as deletion here;
          // the role path below still fails closed (resolve throws => 'none' =>
          // 4403), so the socket is not left authorized.
          deleted = false
        }
        if (deleted) this.closeRoomForDeleted(docId)
      }
    }

    if (!this.roleProvider) return
    let newEpoch = 0
    let epochOk = false
    try {
      newEpoch = await this.epochProvider(documentName)
      epochOk = true
    } catch {
      /* fall through: still re-resolve roles; a lost epoch is handled per-frame */
    }
    for (const room of this.rooms.values()) {
      for (const conn of [...room]) {
        if (conn.documentName !== documentName) continue
        const outcome = await this.recheckRole({
          uid: conn.uid,
          docId: conn.docId,
          documentName: conn.documentName,
          spaceMember: conn.spaceMember,
        })
        if (outcome.kind === 'close-membership') {
          // The frozen space-membership claim became load-bearing and cannot be
          // re-verified on a live socket — fail closed (P1-6). The client re-mints
          // a ticket carrying fresh membership.
          conn.auth = { readAllowed: false, invalidated: false, terminalClose: { code: CLOSE_FORBIDDEN, reason: 'membership recheck required' } }
          void this.closeConn(conn, CLOSE_FORBIDDEN, 'membership recheck required')
          continue
        }
        const role = outcome.role
        if (role === 'none') {
          conn.auth = { readAllowed: false, invalidated: false, terminalClose: { code: CLOSE_FORBIDDEN, reason: 'access revoked' } }
          void this.closeConn(conn, CLOSE_FORBIDDEN, 'access revoked')
          continue
        }
        // Only a downgrade takes effect live; an upgrade needs fresh authority.
        if (roleRank(role) < roleRank(conn.role)) {
          conn.role = role
          void this.sendFrame(conn, { ctl: 'role-changed', role, epoch: newEpoch })
        }
        // Record that this connection's role now reflects the live epoch, so
        // guardMutation does not re-resolve it again for the same epoch. Only
        // stamp when we actually have the authoritative epoch — otherwise leave
        // roleEpoch stale so the per-frame guard re-resolves later.
        if (epochOk) conn.roleEpoch = newEpoch
        conn.auth = { readAllowed: roleAtLeast(conn.role, 'reader'), invalidated: !epochOk }
      }
    }
  }

  /** Close every socket in a deleted doc's room with 4404 (§6.4 / EPOCH-002). */
  closeRoomForDeleted(docId: string): void {
    const room = this.rooms.get(docId)
    if (!room) return
    for (const conn of [...room]) {
      conn.auth = { readAllowed: false, invalidated: false, terminalClose: { code: CLOSE_NOT_FOUND, reason: 'document deleted' } }
      void this.closeConn(conn, CLOSE_NOT_FOUND, 'document deleted')
    }
  }

  /** Current live connection count for a room (observability / tests). */
  roomSize(docId: string): number {
    return this.rooms.get(docId)?.size ?? 0
  }

  close(): void {
    for (const room of this.rooms.values()) {
      for (const conn of [...room]) void this.closeConn(conn, 1001, 'relay shutting down')
    }
    this.rooms.clear()
    this.wss.close()
  }
}
