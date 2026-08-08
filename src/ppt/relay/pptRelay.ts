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
  type ReauthFrame,
  type RefusedCode,
  type ServerFrame,
} from './frames.js'
import {
  canonicalPayloadHash,
  isCanonicalDepthError,
  isDuplicateFramePayloadError,
  isRetryableStorageError,
  RetryableStorageError,
  type PptRelayStore,
  type RelaySnapshot,
  type ReplayCursor,
} from './store.js'
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
  /** Max time (ms) to wait for a replay slot before refusing `storage-retry`. */
  replayAcquireTimeoutMs: number
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
  /**
   * Grace window (ms) after a share-derived socket's ticket membership claim
   * expires for a fresh in-place `reauth` to arrive before the relay fails closed
   * (XIN-1739 P1-3).
   */
  reauthGraceMs: number
  /** Max inbound frames queued on a connection's ordering chain before shedding. */
  maxInboundQueue: number
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
    replayAcquireTimeoutMs: r.replayAcquireTimeoutMs,
    maxLiveBufferFrames: r.maxLiveBufferFrames,
    maxLiveBufferBytes: r.maxLiveBufferBytes,
    sendHighWaterBytes: r.sendHighWaterBytes,
    sendDrainTimeoutMs: r.sendDrainTimeoutMs,
    authRefreshMs: r.authRefreshMs,
    docStatusCacheTtlMs: r.docStatusCacheTtlMs,
    reauthGraceMs: r.reauthGraceMs,
    maxInboundQueue: r.maxInboundQueue,
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
  pendingReauth?: boolean
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
  /**
   * Monotonic counter bumped on every successful in-place `reauth` (XIN-1739 P1-1).
   * A share-expiry callback ({@link expireShareMembership}) captures this value
   * BEFORE its `roleProvider` await and bails if it changed while awaiting: a fresh
   * `reauth` that completed in the meantime already replaced the connection's
   * authority and re-armed the expiry timer, so the stalled OLD callback must not
   * resume and shove the freshly re-authorized socket back into `pendingReauth`.
   */
  reauthGeneration: number
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
   * The catch-up buffer drain is in progress (XIN-1739 P1-2). Set the instant a
   * successful replay finishes and held until the live buffer drains to EMPTY;
   * `deliver` and `requestReplay` both treat it as a NOT-caught-up state, so a
   * broadcast arriving mid-drain is buffered (never delivered ahead of the buffer)
   * and no concurrent replay can start during the drain. This closes the reorder
   * window the old code left when it set `caughtUp = true` BEFORE the flush
   * completed (the `10,12,11` defect).
   */
  /**
   * Depth of in-progress catch-up buffer drains (XIN-1739 P1-1/P1-2). A COUNTER,
   * not a boolean: three call sites drain (the replay cutover, a `handleReauth`
   * success, an `applyEpochBump` that cleared pendingReauth) and two are
   * fire-and-forget, so a second drain can start while the first is mid-loop. As a
   * boolean the second drain's `finally` cleared the flag while the first was still
   * awaiting a `gatedSend`, reopening the reorder window `deliver` closes (a live
   * broadcast slipping between buffered frames — the `10,12,11` defect). As a depth
   * counter the state reads BUSY until EVERY concurrent drain has returned, so
   * `deliver`/`requestReplay`/`handleSnap` keep treating the connection as
   * not-caught-up for the whole overlap. Incremented on drain entry, decremented in
   * `finally`; `> 0` means a drain is in flight.
   */
  flushDepth: number
  /**
   * A coalesced pending replay request (latest wins) captured while one was in
   * flight. At most one replay runs and at most one is queued per connection, so a
   * `hello`/`need` burst cannot fan out into N concurrent snapshot reads (P1-3).
   */
  replayPending: { since: number; ready: boolean } | null
  /** Live frames buffered while this connection is not yet caught up (P1-4). */
  liveBuffer: ServerFrame[]
  /**
   * Highest op seq this connection has an authoritative basis for — observed as a
   * peer `op.q`, an author `ack.q`, or covered by a delivered snapshot (XIN-1739).
   * This is a HIGH-WATER, NOT a contiguous prefix: the wire contract allows legal
   * seq gaps (a burned op-dup-reconciliation seq, a rolled-back append), so a
   * missing intermediate seq is a hole, never a blocker. The replay clamp, the
   * snapshot-coverage gate, and the live-buffer dedup all key off this value; it
   * replaces the old contiguous `lastDelivered`, which a single burned seq wedged
   * forever (P1-1).
   */
  observedHighWater: number
  /**
   * The lowest room seq below which this connection's document state is NOT backed
   * by an actual relay delivery — it was TRUSTED from the client's `hello.since`
   * claim rather than replayed to the socket (XIN-1739 P0-1/P1 prune-gate bypass).
   *
   * Set on every SUCCESSFUL replay to the delivered snapshot's `coveredSeq` (the
   * connection received a full base doc through it) if a snapshot was delivered,
   * else the clamped `effectiveSince` (the replay's lower bound — ops at or below it
   * were never streamed, only claimed). It is the connection's ACTUAL delivery floor
   * and is the authority a `snap` prune is bound to: a `snap` may only prune the op
   * prefix when everything below this floor is ALREADY subsumed by a durable snapshot
   * (`coverageFloor <= existing snapshot coveredSeq`). This closes the path where a
   * writer `hello`s with `since = room high-water` (receiving NO ops), is marked
   * caught-up, writes one fresh op that inflates `observedHighWater`, then `snap`s
   * covering it and prunes durable ops it never observed. `Infinity` until the first
   * successful replay establishes a floor (no snap can pass before then anyway — the
   * `caughtUp` gate refuses it).
   */
  coverageFloor: number
  /** Approximate bytes held in liveBuffer. */
  liveBufferBytes: number
  /** Cached read authority used by no-I/O push delivery. */
  auth: ConnAuthState
  /** Per-connection inbound ordering chain. */
  inboundChain: Promise<void>
  /** Frames currently queued on {@link inboundChain} (backpressure cap, P1-F). */
  inboundDepth: number
  /** Per-connection outbound ordering chain. */
  outboundChain: Promise<void>
  /**
   * Per-connection catch-up drain chain (XIN-1739 P1-2). The three drain entry
   * points — the replay cutover, a `handleReauth` success, an `applyEpochBump` that
   * cleared pendingReauth — are SERIALIZED through this one promise so a second
   * drain never starts until the first has fully flushed. A depth counter alone
   * (`flushDepth`) marks the connection busy but does NOT stop two drains from each
   * swapping out a slice of the live buffer and interleaving their sends on the
   * outbound chain (the `10,12,11` reorder): drain A sends 10 and awaits, a live op
   * 12 buffers, drain B swaps `[12]` and enqueues 12 AHEAD of A's still-unsent 11.
   * Chaining every drain body behind the prior one keeps each drain's buffer swap +
   * sends atomic w.r.t. the next drain, so the outbound order stays strictly
   * increasing. `flushDepth` is retained purely as the BUSY signal the
   * deliver/requestReplay/handleSnap gates read.
   */
  drainChain: Promise<void>
  /** Periodic read-auth refresh timer. */
  authTimer?: NodeJS.Timeout
  /** Fail-closed timer for sockets whose ticket carried a space-membership claim. */
  shareExpiryTimer?: NodeJS.Timeout
  /**
   * Fail-closed deadline for an in-place `reauth` to arrive after a share-derived
   * ticket's membership claim expired (XIN-1739 P1-3). Cleared on a successful
   * reauth; on fire (still pending) the socket is closed.
   */
  reauthGraceTimer?: NodeJS.Timeout
}

function send(socket: WebSocket, frame: ServerFrame): void {
  try {
    socket.send(JSON.stringify(frame))
  } catch {
    /* peer closed mid-broadcast; the close handler prunes it */
  }
}

/**
 * A counting semaphore that never admits more than `max` holders. Exported for
 * direct unit coverage of the max+1 barge invariant (P1-D).
 */
export class Semaphore {
  private active = 0
  // A waiter returns true when it actually took the handed-over permit, false
  // when it had already been settled (timed out) and the permit must be offered
  // to the next waiter instead — otherwise a permit handed to a dead waiter
  // would leak (XIN-1736 P1-H).
  private readonly waiters: Array<() => boolean> = []

  constructor(private readonly max: number) {}

  /** Current number of held permits (test observability). */
  get held(): number {
    return this.active
  }

  /**
   * Acquire a permit, resolving to a release fn. When `timeoutMs` is given and no
   * permit becomes available in time, rejects with a {@link RetryableStorageError}
   * (the relay maps it to `storage-retry` so the client retries) and removes its
   * waiter — so a burst of joins queued behind a slow replay cannot block
   * unboundedly (XIN-1736 P1-H). Without `timeoutMs` it waits indefinitely.
   */
  async acquire(timeoutMs?: number): Promise<() => void> {
    if (this.active < this.max) {
      this.active++
    } else {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        let timer: NodeJS.Timeout | undefined
        const waiter = (): boolean => {
          if (settled) return false
          settled = true
          if (timer) clearTimeout(timer)
          resolve()
          return true
        }
        this.waiters.push(waiter)
        if (timeoutMs !== undefined) {
          timer = setTimeout(() => {
            if (settled) return
            settled = true
            const i = this.waiters.indexOf(waiter)
            if (i >= 0) this.waiters.splice(i, 1)
            reject(new RetryableStorageError('replay slot acquire timeout'))
          }, timeoutMs)
        }
      })
      // Resumed by release(): the permit was handed over, `active` unchanged.
    }
    let released = false
    return () => {
      if (released) return
      released = true
      // Hand the permit straight to the next LIVE waiter — do NOT drop `active`,
      // or a concurrent acquire() would see a free slot the waiter is about to
      // consume and admit one over the cap. Skip waiters that already timed out.
      for (;;) {
        const next = this.waiters.shift()
        if (!next) {
          this.active--
          return
        }
        if (next()) return
      }
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
        this.enqueueInbound(conn, raw)
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
      reauthGeneration: 0,
      frameTimes: [],
      ephemeralFrameTimes: [],
      caughtUp: false,
      replayInFlight: false,
      flushDepth: 0,
      replayPending: null,
      liveBuffer: [],
      observedHighWater: 0,
      coverageFloor: Infinity,
      liveBufferBytes: 0,
      auth: { readAllowed: roleAtLeast(role, 'reader'), invalidated: false },
      inboundChain: Promise.resolve(),
      inboundDepth: 0,
      outboundChain: Promise.resolve(),
      drainChain: Promise.resolve(),
    }
    this.addToRoom(conn)
    this.armAuthRefresh(conn)
    this.armShareExpiry(conn, claims.exp)
    // Drain frames buffered before auth completed, in receipt order. No `await`
    // runs between assigning `conn` and this loop, so no `onData` callback can
    // interleave and reorder ahead of the queued frames.
    for (const raw of preauth) {
      this.enqueueInbound(conn, raw)
    }
  }

  /**
   * Enqueue one inbound frame on the connection's ordering chain, bounded by
   * {@link RelayLimits.maxInboundQueue}. Beyond the cap the frame is shed with
   * `rate-limited` rather than growing an unbounded work queue that keeps
   * persisting after the socket is gone — the P1-F defect where 29/30 ops
   * persisted after a close because `onData` never capped depth and `onMessage`
   * never checked `readyState` (XIN-1736 P1-F). `onMessage` itself no-ops once the
   * socket is no longer OPEN, so a queued frame for a gone client never persists.
   */
  private enqueueInbound(conn: Conn, raw: string): void {
    if (conn.inboundDepth >= this.limits.maxInboundQueue) {
      this.refuse(conn, 'rate-limited', { retryInMs: this.limits.rateWindowMs })
      return
    }
    conn.inboundDepth++
    const run = async (): Promise<void> => {
      try {
        await this.onMessage(conn, raw)
      } finally {
        conn.inboundDepth--
      }
    }
    conn.inboundChain = conn.inboundChain.then(run, run)
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
    if (conn.shareExpiryTimer) clearTimeout(conn.shareExpiryTimer)
    conn.shareExpiryTimer = undefined
    if (conn.reauthGraceTimer) clearTimeout(conn.reauthGraceTimer)
    conn.reauthGraceTimer = undefined
    const room = this.rooms.get(conn.docId)
    if (!room) return
    room.delete(conn)
    if (room.size === 0) {
      this.rooms.delete(conn.docId)
      // Drop the process-local budget for an empty room; it re-seeds from durable
      // state when the room is next joined, so this only bounds memory.
      this.roomBytes.delete(conn.docId)
      this.roomBytesSeeded.delete(conn.docId)
      // Evict the room's doc-status cache entry too, so a churn of short-lived
      // rooms cannot grow the cache unbounded (XIN-1736 P2-b). It re-populates on
      // the next join within its short TTL.
      this.docStatusCache.delete(conn.docId)
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
    return conn.auth.readAllowed && !conn.auth.invalidated && conn.auth.pendingReauth !== true && conn.socket.readyState === WebSocket.OPEN
  }

  /**
   * Advance this connection's observed HIGH-WATER (XIN-1739 P1-1). A seq at or
   * below the high-water is already accounted for; a higher seq advances it. This
   * is a high-water, NOT a contiguous prefix: the wire contract allows legal seq
   * gaps (a burned op-dup-reconciliation seq, a rolled-back append), and because
   * observations arrive in room order, seeing seq N means every real op below N was
   * already delivered to (or is a legal hole for) this connection. The replay
   * clamp and the snapshot-coverage gate both key off this value. It is advanced
   * only by genuine OBSERVATIONS — a peer op delivered, a replay op, delivered
   * snapshot coverage, or a fresh authored write's ack — never by a duplicate
   * re-ack (see the re-ack path in {@link handleOps}, XIN-1739 P0-2).
   */
  private markObservedSeq(conn: Conn, seq: number): void {
    if (seq > conn.observedHighWater) conn.observedHighWater = seq
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
    if (peer.auth.pendingReauth === true && peer.socket.readyState === WebSocket.OPEN) {
      await this.bufferLiveFrame(peer, frame)
      return
    }
    if (!this.canPushRead(peer)) {
      const terminal = peer.auth.terminalClose
      await this.closeConn(peer, terminal?.code ?? CLOSE_FORBIDDEN, terminal?.reason ?? 'read authorization invalidated')
      return
    }
    if (!peer.caughtUp || peer.replayInFlight || peer.flushDepth > 0) {
      await this.bufferLiveFrame(peer, frame)
      return
    }
    await this.gatedSend(peer, frame)
    if (frame.ctl === 'op' && peer.socket.readyState === WebSocket.OPEN) this.markObservedSeq(peer, frame.q)
  }

  private async bufferLiveFrame(peer: Conn, frame: ServerFrame): Promise<void> {
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
  }

  /**
   * Flush a connection's buffered live frames once its replay has caught up.
   * Op frames whose seq the replay already delivered are dropped (dedup on
   * `observedHighWater`), so an op buffered during replay that the replay also
   * streamed is delivered exactly once (P1-4).
   *
   * Drains in BATCHES until the buffer is empty (XIN-1739 P1-2): while flushing,
   * `deliver` keeps buffering new broadcasts (the `flushDepth` gate), so a
   * batch can grow the buffer; each new batch is drained in receipt order until
   * none remain. Because the outbound chain is the sole socket-order owner, order
   * is preserved within and across batches. The caller raises `flushDepth`
   * around this call and only marks `caughtUp` once it returns with an empty buffer.
   */
  private async flushLiveBuffer(conn: Conn): Promise<void> {
    while (conn.liveBuffer.length > 0) {
      const buffered = conn.liveBuffer
      conn.liveBuffer = []
      conn.liveBufferBytes = 0
      for (const frame of buffered) {
        if (!this.canPushRead(conn)) {
          const terminal = conn.auth.terminalClose
          await this.closeConn(conn, terminal?.code ?? CLOSE_FORBIDDEN, terminal?.reason ?? 'read authorization invalidated')
          return
        }
        if (frame.ctl === 'op' && frame.q <= conn.observedHighWater) continue
        await this.gatedSend(conn, frame)
        if (frame.ctl === 'op' && conn.socket.readyState === WebSocket.OPEN) this.markObservedSeq(conn, frame.q)
      }
    }
  }

  /**
   * Drain the live buffer under the flush gate, so a broadcast that arrives
   * mid-drain is buffered (not delivered ahead of it) and no concurrent replay
   * starts (XIN-1739 P1-2). Used by the non-replay flush paths (an epoch bump that
   * cleared `pendingReauth`, or a successful in-place `reauth`) where the connection
   * is already `caughtUp`; the replay cutover uses {@link cutoverDrain}.
   *
   * SERIALIZED through {@link Conn.drainChain}: the whole body — the buffer swap and
   * every send — runs behind any prior drain, so two overlapping drains cannot each
   * swap out a slice of the buffer and interleave their sends on the outbound chain
   * (the `10,12,11` reorder a bare depth counter left open, XIN-1739 P1-2). The
   * `flushDepth` counter is incremented SYNCHRONOUSLY on entry (before the chain
   * await) and decremented when this drain's flush finishes, so the
   * deliver/requestReplay/handleSnap gates read the connection as BUSY for the whole
   * queued+running overlap even though only one drain flushes at a time.
   */
  private drainLiveBuffer(conn: Conn): Promise<void> {
    return this.chainedDrain(conn)
  }

  /**
   * Serialize `flushLiveBuffer` (plus, for the replay cutover, the `caughtUp`
   * flip) behind any prior drain on this connection. `flushDepth` is raised
   * synchronously so the busy gates see the drain the instant it is requested, not
   * only once it reaches the head of the chain.
   */
  private chainedDrain(conn: Conn, markCaughtUp = false): Promise<void> {
    conn.flushDepth++
    const body = async (): Promise<void> => {
      try {
        await this.flushLiveBuffer(conn)
        // Set `caughtUp` synchronously right after the buffer empties (no await
        // between), so no broadcast can slip in unbuffered before the flag flips
        // (XIN-1739 P1-2 cutover invariant).
        if (markCaughtUp) conn.caughtUp = true
      } finally {
        conn.flushDepth--
      }
    }
    const run = conn.drainChain.then(body, body)
    conn.drainChain = run.catch(() => {})
    return run
  }

  /**
   * Send a replay frame, PAUSING first while the socket's send buffer is over the
   * high-water mark so a slow/greedy consumer cannot make the relay accumulate an
   * unbounded backlog (XIN-1693 P1-3). Bounded by the drain timeout so a
   * wedged client cannot stall replay forever; on a closed socket it is a no-op.
   */
  private async gatedSend(conn: Conn, frame: ServerFrame): Promise<void> {
    await this.enqueueOutbound(conn, async () => {
      if (!this.canPushRead(conn)) {
        const terminal = conn.auth.terminalClose
        conn.socket.close(terminal?.code ?? CLOSE_FORBIDDEN, terminal?.reason ?? 'read authorization invalidated')
        this.removeFromRoom(conn)
        return
      }
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
      if (!this.canPushRead(conn)) {
        const terminal = conn.auth.terminalClose
        conn.socket.close(terminal?.code ?? CLOSE_FORBIDDEN, terminal?.reason ?? 'read authorization invalidated')
        this.removeFromRoom(conn)
        return
      }
      if (socket.bufferedAmount > this.limits.sendHighWaterBytes) {
        conn.socket.close(CLOSE_UNAVAILABLE, 'send drain timeout')
        this.removeFromRoom(conn)
        return
      }
      send(socket, frame)
    })
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
    // A frame queued on the ordering chain may only reach here AFTER the socket
    // closed (client sent a burst then went away, or a slow chain drains post
    // close). Nothing should be persisted or broadcast for a gone client, so drop
    // it up front — this is the top-of-onMessage readyState check the inbound
    // work-queue needs so ops do not persist after close (XIN-1736 P1-F).
    if (conn.socket.readyState !== WebSocket.OPEN) return
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
      case 'reauth':
        // In-place re-authorization (XIN-1739 P1-3): byte-capped + rate-limited as
        // an ephemeral control frame (never persisted, never broadcast). Verifies a
        // freshly-minted ticket on the EXISTING socket so a share-derived writer
        // refreshes membership without a full disconnect/replay.
        if (this.enforceEphemeralLimits(conn, rawBytes)) return
        await this.handleReauth(conn, (frame as ReauthFrame).ticket)
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
      expiresAt: now + this.limits.docStatusCacheTtlMs,
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

  private armShareExpiry(conn: Conn, expSeconds: number | undefined): void {
    if (!conn.spaceMember) return
    const expiresAt = typeof expSeconds === 'number' ? expSeconds * 1000 : Date.now()
    const delayMs = Math.max(0, expiresAt - Date.now())
    conn.shareExpiryTimer = setTimeout(() => {
      conn.shareExpiryTimer = undefined
      void this.expireShareMembership(conn)
    }, delayMs)
  }

  private async expireShareMembership(conn: Conn): Promise<void> {
    if (!conn.spaceMember || conn.socket.readyState !== WebSocket.OPEN || !this.rooms.get(conn.docId)?.has(conn)) return
    // Capture the reauth generation BEFORE the roleProvider await (XIN-1739 P1-1):
    // an in-place `reauth` that completes while we await replaces the connection's
    // authority and re-arms this timer, so a resume that ignored it would clobber a
    // freshly re-authorized socket back into pendingReauth. The callback that ran
    // this method already nulled `shareExpiryTimer`, so `handleReauth`'s clearTimeout
    // cannot cancel this in-flight body — the generation guard is what stops it.
    const generation = conn.reauthGeneration
    let directRole: ResolvedRole = 'none'
    if (this.roleProvider) {
      try {
        directRole = await this.roleProvider({
          uid: conn.uid,
          docId: conn.docId,
          documentName: conn.documentName,
          spaceMember: false,
        })
      } catch {
        directRole = 'none'
      }
    }
    // A reauth (or another expiry cycle) intervened while awaiting → this callback
    // is stale; bail without touching the connection's now-fresh authority.
    if (conn.reauthGeneration !== generation) return
    if (!conn.spaceMember || conn.socket.readyState !== WebSocket.OPEN || !this.rooms.get(conn.docId)?.has(conn)) return
    if (roleRank(directRole) >= roleRank(conn.role)) {
      // Direct role covers the connection independent of the expired membership
      // claim — keep the socket, drop the (now stale) membership dependency.
      conn.spaceMember = false
      conn.auth = { readAllowed: roleAtLeast(conn.role, 'reader'), invalidated: false }
      return
    }
    // Genuinely share-derived: the ticket's membership claim just expired and the
    // direct role does not cover it. Instead of hard-closing — which, with the
    // short ticket TTL, becomes a permanent connect/replay/close loop (P1-3) —
    // enter PENDING-REAUTH: buffer live frames and give the client a short grace
    // window to present a freshly-minted ticket via an in-place `reauth` frame. If
    // none arrives before the deadline, fail closed. A client that reauth'd
    // proactively (before expiry) already re-armed this timer, so it never fires.
    conn.auth = { readAllowed: conn.auth.readAllowed, invalidated: false, pendingReauth: true }
    this.armReauthGrace(conn)
  }

  /**
   * Fail-closed deadline for an in-place `reauth` (XIN-1739 P1-3). If the socket is
   * still `pendingReauth` when the grace window elapses, no fresh ticket arrived —
   * close it (the same security bound the short ticket TTL enforced, now via a
   * bounded re-verify window instead of an immediate disconnect).
   */
  private armReauthGrace(conn: Conn): void {
    if (conn.reauthGraceTimer) clearTimeout(conn.reauthGraceTimer)
    conn.reauthGraceTimer = setTimeout(() => {
      conn.reauthGraceTimer = undefined
      if (conn.auth.pendingReauth === true && conn.socket.readyState === WebSocket.OPEN && this.rooms.get(conn.docId)?.has(conn)) {
        conn.auth = { readAllowed: false, invalidated: false, terminalClose: { code: CLOSE_FORBIDDEN, reason: 'ticket membership expired' } }
        void this.closeConn(conn, CLOSE_FORBIDDEN, 'ticket membership expired')
      }
    }, this.limits.reauthGraceMs)
  }

  /**
   * Handle an in-place `reauth` frame (XIN-1739 P1-3): verify the freshly-minted
   * ticket, consume its jti (single-use), require the SAME uid/docId/documentName
   * as the live connection, then refresh role / role epoch / space-membership and
   * re-arm the share-expiry timer from that fresh authority. On success clear
   * `pendingReauth` and flush the live buffer via the cutover; on any failure —
   * invalid/replayed ticket, identity mismatch, revoked access — fail closed.
   * Enforces the same short-ticket security bound by RE-VERIFYING in place rather
   * than forcing a full reconnect + replay.
   */
  private async handleReauth(conn: Conn, ticket: string): Promise<void> {
    let claims: PptCollabClaims & { jti: string }
    try {
      claims = this.verifyTicket(ticket)
    } catch {
      return this.failReauth(conn, 'invalid reauth ticket')
    }
    // Identity is immutable across a reauth: it may only refresh the SAME
    // connection's authority, never migrate the socket to another user or doc.
    if (claims.uid !== conn.uid || claims.docId !== conn.docId || claims.documentName !== conn.documentName) {
      return this.failReauth(conn, 'reauth identity mismatch')
    }
    let fresh: boolean
    try {
      fresh = await this.ticketStore.consume(claims.jti)
    } catch {
      return this.failReauth(conn, 'ticket store unavailable')
    }
    if (!fresh) return this.failReauth(conn, 'reauth ticket already used')
    // Doc-status gate (XIN-1739 P2): unlike identityGate/guardMutation/refreshReadAuth,
    // reauth previously consulted only the epoch provider. Archiving/soft-deleting a
    // deck bumps NO epoch (see index.ts docStatusProvider), so a reauth on an
    // archived/soft-deleted deck would otherwise succeed and clear a `terminalClose`
    // 4404 — resurrecting a socket the deletion guard had condemned. Re-check
    // doc-status here and fail closed 4404 before adopting any fresh authority.
    if (this.docStatusProvider) {
      let deleted: boolean
      try {
        deleted = (await this.readDocStatus(conn)) === 'deleted'
      } catch {
        deleted = true // fail closed
      }
      if (deleted) {
        if (conn.reauthGraceTimer) {
          clearTimeout(conn.reauthGraceTimer)
          conn.reauthGraceTimer = undefined
        }
        conn.auth = { readAllowed: false, invalidated: false, terminalClose: { code: CLOSE_NOT_FOUND, reason: 'document deleted', refused: 'doc-deleted' } }
        await this.closeConn(conn, CLOSE_NOT_FOUND, 'document deleted')
        return
      }
    }
    // Re-resolve the LIVE role from the fresh authority exactly as connect does:
    // trust the ticket's role at the current epoch, else re-resolve with the fresh
    // `space_member` claim; fail closed to `none` if re-resolution is impossible.
    let liveEpoch: number
    try {
      liveEpoch = await this.epochProvider(conn.documentName)
    } catch {
      return this.failReauth(conn, 'document unavailable')
    }
    const freshSpaceMember = claims.space_member === true
    let role: ResolvedRole = claims.role
    if (claims.permission_epoch !== liveEpoch) {
      if (!this.roleProvider) return this.failReauth(conn, 'stale reauth ticket epoch')
      try {
        role = await this.roleProvider({ uid: conn.uid, docId: conn.docId, documentName: conn.documentName, spaceMember: freshSpaceMember })
      } catch {
        role = 'none'
      }
    }
    if (!roleAtLeast(role, 'reader')) return this.failReauth(conn, 'access revoked')
    if (conn.socket.readyState !== WebSocket.OPEN || !this.rooms.get(conn.docId)?.has(conn)) return
    // Success: adopt the fresh authority in place, re-arm the share-expiry timer
    // from the fresh ticket's expiry, clear pending reauth, and flush via cutover.
    if (conn.reauthGraceTimer) {
      clearTimeout(conn.reauthGraceTimer)
      conn.reauthGraceTimer = undefined
    }
    conn.role = role
    conn.roleEpoch = liveEpoch
    conn.spaceMember = freshSpaceMember
    // Bump the reauth generation so any share-expiry callback still awaiting its
    // roleProvider (armed against the OLD ticket) bails on resume instead of shoving
    // this freshly re-authorized socket back into pendingReauth (XIN-1739 P1-1).
    conn.reauthGeneration++
    if (conn.shareExpiryTimer) {
      clearTimeout(conn.shareExpiryTimer)
      conn.shareExpiryTimer = undefined
    }
    this.armShareExpiry(conn, claims.exp)
    conn.auth = { readAllowed: roleAtLeast(role, 'reader'), invalidated: false }
    if (conn.caughtUp) await this.drainLiveBuffer(conn)
  }

  private failReauth(conn: Conn, reason: string): void {
    if (conn.reauthGraceTimer) {
      clearTimeout(conn.reauthGraceTimer)
      conn.reauthGraceTimer = undefined
    }
    conn.auth = { readAllowed: false, invalidated: false, terminalClose: { code: CLOSE_FORBIDDEN, reason } }
    void this.closeConn(conn, CLOSE_FORBIDDEN, reason)
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
    // A pending re-auth flag is STICKY (XIN-1739 P0-1): a periodic timer refresh
    // or a `hello`/`need`/`p` must NOT silently clear a socket's awaiting-reauth
    // state just because its cached role/epoch still validate — the FROZEN
    // membership claim that put it into pendingReauth is exactly what this path
    // cannot re-verify (a share expiry bumps no epoch, so the downgrade re-resolve
    // is skipped and the stale claim would otherwise sail through). Only a fresh
    // ticket via {@link handleReauth} (or a full epoch re-resolution in
    // {@link applyEpochBump}) may clear it. Preserving it keeps canPushRead and the
    // mutation gates failing closed until then, so the grace-timer deadline is real
    // rather than a no-op the refresh already defused.
    conn.auth = conn.auth.pendingReauth === true
      ? { readAllowed: true, invalidated: false, pendingReauth: true }
      : { readAllowed: true, invalidated: false }
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
    // A drain (`flushDepth > 0`) counts as busy just like an in-flight replay:
    // starting a fresh replay mid-drain could interleave replay ops with the
    // buffered live frames and reorder them (XIN-1739 P1-2). Coalesce to the
    // latest cursor and let the current cutover finish first.
    if (conn.replayInFlight || conn.flushDepth > 0) {
      conn.replayPending = { since, ready }
      return
    }
    conn.replayInFlight = true
    void this.runReplay(conn, since, ready)
  }

  /** Drive one replay, then either run a coalesced pending one or, once none
   * remains, drain the live buffer to empty and mark the connection caught up. */
  private async runReplay(conn: Conn, since: number, ready: boolean): Promise<void> {
    let ok = false
    try {
      ok = await this.replay(conn, since, ready)
    } catch {
      ok = false
    }
    conn.replayInFlight = false
    const pending = this.takePendingReplay(conn)
    if (pending && conn.socket.readyState === WebSocket.OPEN) {
      conn.replayInFlight = true
      void this.runReplay(conn, pending.since, pending.ready)
      return
    }
    // Only a SUCCESSFUL replay establishes the caught-up boundary. A refused
    // replay (e.g. a bogus cursor) leaves the connection buffering so it does not
    // receive live ops with no base state; the client re-hello's with a valid
    // cursor and that replay flushes.
    if (!ok) return
    // Cutover (XIN-1739 P1-2): drain the live buffer to EMPTY before marking the
    // connection caught up. While a drain is in flight (`flushDepth > 0`), `deliver`
    // buffers new broadcasts and `requestReplay` coalesces, so live delivery can
    // never bypass the buffer mid-drain and reorder ops (the `10,12,11` defect).
    // The drain is SERIALIZED through `drainChain` (so a concurrent reauth/epoch
    // drain cannot interleave its sends) and sets `caughtUp` synchronously the
    // instant the buffer empties — no await between — so no broadcast slips in
    // unbuffered.
    await this.chainedDrain(conn, /* markCaughtUp */ true)
    // A replay requested DURING the drain was coalesced (flushing counted as busy);
    // run it now so the freshly caught-up socket does not sit on a stale cursor.
    const next = this.takePendingReplay(conn)
    if (next && conn.socket.readyState === WebSocket.OPEN) {
      conn.replayInFlight = true
      void this.runReplay(conn, next.since, next.ready)
    }
  }

  /** Atomically read and clear the coalesced pending replay request. */
  private takePendingReplay(conn: Conn): { since: number; ready: boolean } | null {
    const pending = conn.replayPending
    conn.replayPending = null
    return pending
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
    // One try/finally around the WHOLE post-acquire body: the replay semaphore
    // permit (and the cursor's store resources) are released in `finally`, so a
    // throw from ANY step — including `cursor.close()` on the early
    // cursor-exceeds-high-water return — can never skip the release and leak a
    // permit that then wedges every join process-wide (XIN-1736 P1-C).
    try {
      try {
        // Bounded wait for a replay slot so a burst of joins queued behind a slow
        // replay is refused retryably rather than blocking unboundedly (P1-H).
        release = await this.replaySemaphore.acquire(this.limits.replayAcquireTimeoutMs)
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
        return false
      }
      const { highWater, snapshot } = cursor
      if (rawSince > highWater) {
        this.refuse(conn, 'protocol-version', { message: 'resume cursor exceeds room high-water' })
        return false
      }
      try {
        // Clamp the replay lower bound to this connection's observed HIGH-WATER.
        // A coalesced re-`hello`/`need` (or a stale client cursor) must not
        // re-stream ops this socket already applied live or in a prior replay —
        // the ins/txt RGA is non-idempotent, so a re-delivered op permanently
        // diverges the doc (XIN-1736 P1-E). Legal gaps below the high-water are
        // holes/snapshot-covered state, not pending ops, so clamping by the
        // high-water (not a contiguous prefix) is safe (XIN-1739 P1-1). The raw
        // cursor is still used above for the `> highWater` protocol check; only op
        // delivery is clamped.
        const effectiveSince = Math.max(rawSince, conn.observedHighWater)
        let fromSeq = effectiveSince
        let readySeq = effectiveSince
        let delivered = conn.observedHighWater
        // Track whether a snapshot was actually DELIVERED to this socket, and at
        // what coverage: it sets the connection's prune-authority floor below
        // (XIN-1739 P0-1/P1). A delivered snapshot means the socket received a full
        // base doc through its `coveredSeq`; without one, everything at or below the
        // clamped `effectiveSince` was TRUSTED from the client's `hello.since` claim,
        // never streamed here.
        let deliveredSnapshotCovered: number | null = null
        // Only send the snapshot to a peer behind it; an already-synced peer is not
        // forced to reapply it (PPT-COLLAB-003).
        if (snapshot && effectiveSince < snapshot.coveredSeq) {
          if (!this.canPushRead(conn)) return false
          await this.gatedSend(conn, { ctl: 'snapshot', snapshotVersion: snapshot.snapshotVersion, doc: snapshot.doc })
          fromSeq = snapshot.coveredSeq
          readySeq = snapshot.coveredSeq
          deliveredSnapshotCovered = snapshot.coveredSeq
          // A snapshot covers all real ops through its coveredSeq; gaps in that
          // interval are legal no-op holes. Advance the high-water to coverage
          // (XIN-1739 P1-1).
          conn.observedHighWater = Math.max(conn.observedHighWater, snapshot.coveredSeq)
          delivered = Math.max(delivered, conn.observedHighWater)
        }
        // Highest op seq ACTUALLY delivered, so `ready.q` reports what the client is
        // truly synced through, not the counter high-water (XIN-1655 C6).
        for (;;) {
          if (!(await this.refreshReadAuth(conn, 'replay-page'))) return false
          const ops = await cursor.nextPage()
          if (ops.length === 0) break
          for (const op of ops) {
            if (op.seq <= fromSeq) continue
            if (!this.canPushRead(conn)) return false
            await this.gatedSend(conn, { ctl: 'op', q: op.seq, frame: op.frame })
            this.markObservedSeq(conn, op.seq)
            delivered = conn.observedHighWater
            readySeq = op.seq
          }
        }
        conn.observedHighWater = Math.max(conn.observedHighWater, delivered)
        // Record this replay's ACTUAL delivery floor (XIN-1739 P0-1/P1): a delivered
        // snapshot means the socket received a full base doc through its coveredSeq;
        // otherwise ops at or below the clamped `effectiveSince` were only CLAIMED by
        // the client's `hello.since`, never streamed. `handleSnap` binds prune
        // authority to this floor so a claimed cursor + one own write can never
        // authorize pruning ops the connection never observed. Latest replay wins:
        // a re-`hello` from a higher claimed cursor re-introduces an un-received gap,
        // while a re-`hello` from `since=0` that streams the whole log lowers it.
        conn.coverageFloor = deliveredSnapshotCovered ?? effectiveSince
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
          if (!this.canPushRead(conn)) return false
          await this.gatedSend(conn, {
            ctl: 'ready',
            q: readySeq,
            snapshotVersion: snapshot?.snapshotVersion ?? 0,
            epoch,
            role: conn.role,
          })
        }
        return true
      } catch (err) {
        const code = isRetryableStorageError(err) ? 'storage-retry' : 'storage-failed'
        this.refuse(conn, code, { message: 'replay failed' })
        if (code === 'storage-failed') await this.closeConn(conn, CLOSE_UNAVAILABLE, 'replay failed')
        return false
      }
    } finally {
      if (cursor) {
        try {
          await cursor.close()
        } catch {
          /* ignore close failure — the permit still releases below */
        }
      }
      release?.()
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
   * The IDENTITY half of the mutation gate, run on EVERY `ops` frame — including
   * the known-duplicate re-ack path — BEFORE any store read (XIN-1736 P1-I).
   *
   * The re-ack path previously ran its ledger lookup + positive `ack` ahead of any
   * authorization, so a revoked/downgraded-to-`none` reader, or a socket on a
   * soft-deleted doc, could harvest a `frameId` and drive an unauthorized store
   * read + a bogus `ack` per frame with no shedding — and round-10's
   * `markObservedSeq` prune watermark now depends on that path. This gate confirms
   * the connection is still a live-doc reader at the current epoch (doc-status
   * live, epoch refresh with downgrade-only role re-resolution, `role >= reader`)
   * so only an authorized reader ever reaches the lookup. It deliberately does NOT
   * enforce the stale-epoch or writer checks — those stay MUTATION-only in
   * {@link guardMutation} — so a genuine idempotent resend from a still-authorized
   * (possibly downgraded-to-reader) connection is still re-acked (round-7 / D3).
   */
  private async identityGate(conn: Conn): Promise<RefusedCode | null> {
    // A socket awaiting in-place re-verification can NEITHER read NOR write until
    // a fresh ticket clears pendingReauth (XIN-1739 P0-1b). `canPushRead` already
    // blocks the push/read path; block the mutation/re-ack path here too so an
    // expired share-derived writer cannot harvest a re-ack (or drive a store read)
    // during the grace window. Gating is otherwise inverted relative to risk.
    if (conn.auth.pendingReauth === true) return 'forbidden-role'
    if (this.docStatusProvider) {
      try {
        if ((await this.readDocStatus(conn)) === 'deleted') return 'doc-deleted'
      } catch {
        return 'doc-deleted'
      }
    }
    let live: number
    try {
      live = await this.epochProvider(conn.documentName)
    } catch {
      // Unconfirmable epoch: fail closed rather than serve an unauthorized read.
      return 'doc-deleted'
    }
    if (conn.roleEpoch !== live) {
      if (await this.refreshRoleDownOnly(conn, live)) return 'forbidden-role'
    }
    if (!roleAtLeast(conn.role, 'reader')) return 'forbidden-role'
    return null
  }

  /**
   * Shared pre-persist validation for `ops`/`snap` (returns a code or null).
   * `maxBytes` is the size gate for THIS frame kind: an op frame uses the small
   * per-frame limit, a snapshot the larger single-blob limit — so the snapshot
   * blob budget actually binds rather than being pre-empted by the op-frame cap.
   */
  private async guardMutation(conn: Conn, frameEpoch: number, rawBytes: number, maxBytes: number): Promise<RefusedCode | null> {
    if (rawBytes > maxBytes) return 'too-large'
    // Awaiting re-verification: no write is authorized until a fresh ticket clears
    // pendingReauth (XIN-1739 P0-1b). Checked before the epoch/role gate so a
    // share-derived writer whose membership claim expired cannot persist during the
    // grace window even if its cached role/epoch still nominally validate.
    if (conn.auth.pendingReauth === true) return 'forbidden-role'
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
    // Preserve a sticky pendingReauth here too (XIN-1739 P0-1): a downgrade-only
    // re-resolve validates the role, not the frozen membership claim, so it must
    // not clear a socket that is still awaiting a fresh ticket.
    conn.auth = conn.auth.pendingReauth === true
      ? { readAllowed: roleAtLeast(conn.role, 'reader'), invalidated: false, pendingReauth: true }
      : { readAllowed: roleAtLeast(conn.role, 'reader'), invalidated: false }
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

  /**
   * Emit the positive `ack` for a pure re-ack of an already-durable DUPLICATE
   * frame (its original ack was lost) at its stored `seq`. Reads the current
   * snapshot version for the ack envelope (a read failure keeps the re-ack — the
   * frame is durable regardless), and echoes `k` with `?? 0` so an omitted counter
   * never lands as `undefined` in the frame (P2-h; parse also refuses a
   * non-integer `k`).
   *
   * MUST NOT advance the observation high-water (XIN-1739 P0-2): a re-ack
   * acknowledges a frame this connection ALREADY WROTE durably — it is NOT evidence
   * the connection OBSERVED the op prefix below that seq. A fresh authored write
   * does advance it, because a caught-up author receives every lower real op in
   * room order before its own ack; a re-ack has no such guarantee (it can arrive on
   * a fresh reconnect that resends a pending frame whose seq was allocated after
   * peers' ops it never received). Advancing on a re-ack would let `replay()` clamp
   * away — and `handleSnap` authorize the prune of — ops the connection never saw.
   * Consumes neither budget nor a rate slot and is not rebroadcast: it only echoes
   * the already-committed seq. Shared by BOTH pre-gate re-ack paths (non-null-hash
   * fast path and the NULL-hash `frame_json`-verified path, XIN-1750).
   */
  private async reackDuplicate(conn: Conn, frame: OpsFrame, seq: number): Promise<void> {
    let snapshotVersion = 0
    try {
      const snap = await this.store.getSnapshot(conn.docId)
      snapshotVersion = snap?.snapshotVersion ?? 0
    } catch {
      /* keep the re-ack: the frame is already durable regardless of this read */
    }
    void this.gatedSend(conn, { ctl: 'ack', k: frame.k ?? 0, q: seq, snapshotVersion })
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
    // Reject an EMPTY ops frame (XIN-1739 P2): `opsAreValid([])` is vacuously true
    // and `k` is optional, so an empty frame would otherwise be durably sequenced
    // and acked as `k:0` — burning a seq and a ledger row for a no-op. A frame that
    // carries no ops is not a mutation; refuse it as a protocol error.
    if (frame.ops.length === 0) {
      this.refuse(conn, 'protocol-version', { k, frameId, message: 'ops frame must contain at least one op' })
      return
    }
    if (frame.ops.length > this.limits.maxOpsPerFrame) {
      this.refuse(conn, 'too-large', { k, frameId, message: 'op count exceeds per-frame limit' })
      return
    }
    // P1-I: the IDENTITY gate runs on EVERY ops frame BEFORE the ledger read, so
    // only a live-doc reader at the current epoch reaches the known-duplicate
    // lookup below. Without it, a revoked/downgraded-to-`none` reader or a socket
    // on a deleted doc could drive an unauthorized store read + a bogus re-`ack`
    // per harvested frameId (and corrupt the markObservedSeq prune watermark). It
    // does NOT enforce the stale-epoch/writer checks — those stay MUTATION-only —
    // so a genuine idempotent resend from a still-authorized (possibly
    // downgraded-to-reader) connection is still re-acked (round-7 / D3).
    const identityCode = await this.identityGate(conn)
    if (identityCode) {
      this.refuse(conn, identityCode, { k, frameId })
      return
    }
    // D3 / idempotent-resend: a KNOWN-DUPLICATE resend (its original ack was lost)
    // must re-ack its stored seq and MUST NOT be refused — never `room-full` /
    // `rate-limited`, and never `stale-epoch` / `forbidden-role` for a still-live
    // reader. A pure re-ack of an already-durable frame is NOT a new mutation, so
    // it runs BEFORE `guardMutation` (the stale-epoch/writer/size gate) and BEFORE
    // the byte/rate accounting: a duplicate must acknowledge the durable original
    // even from a connection that was since downgraded (to reader) or whose epoch
    // advanced, otherwise a resend after a lost ack leaves the client showing
    // unsynced state for a write that actually committed. The lookup is a CURRENT
    // read of the dedup ledger; it consumes neither budget nor a rate slot, does
    // not persist, and is not rebroadcast — it only echoes the already-committed
    // seq. A lookup failure falls through to the normal path (appendOp still
    // dedups authoritatively). A genuinely NEW frame (`known === null`) still hits
    // `guardMutation` below.
    let known: { seq: number; payloadHash: string | null } | null = null
    // Hash the canonical ops payload up front (the dedup identity). Bound the
    // recursion: a pathologically deep-nested payload (~5000 levels, still under
    // every byte cap) would otherwise drive `canonicalStringify` into a native
    // `RangeError: Maximum call stack size exceeded` that escapes this handler and
    // is swallowed by the `runSerialized` chain tail — the client gets NEITHER an
    // `ack` NOR a `refused`, violating the "every frame gets a verdict" contract, and
    // retries without consuming a rate slot. Convert it to a `protocol-version`
    // refusal so the frame is answered (XIN-1739 P2).
    let payloadHash: string
    try {
      payloadHash = canonicalPayloadHash(frame)
    } catch (err) {
      if (isCanonicalDepthError(err)) {
        this.refuse(conn, 'protocol-version', { k, frameId, message: 'ops payload nesting exceeds limit' })
        return
      }
      throw err
    }
    try {
      if (this.store.frameIdentity) {
        known = await this.store.frameIdentity(conn.docId, frameId)
      } else {
        const seq = await this.store.frameSeq(conn.docId, frameId)
        known = seq === null ? null : { seq, payloadHash: null }
      }
    } catch {
      /* fall through: appendOp's ledger PK remains the authoritative dedup */
    }
    if (known !== null && known.payloadHash !== null) {
      // Canonical-ops hashes (XIN-1736 P1-A) are epoch/key-order independent, so
      // an exact match is a genuine idempotent resend (re-ack); a mismatch is a
      // reused frameId carrying DIFFERENT ops and is refused.
      if (known.payloadHash !== payloadHash) {
        this.refuse(conn, 'protocol-version', { k, frameId, message: 'frameId payload mismatch' })
        return
      }
      await this.reackDuplicate(conn, frame, known.seq)
      return
    }
    // A ledger row with a NULL payload_hash (a legacy row, or one nulled by the
    // canonical-ops hash-scheme migration) cannot be verified from the ledger
    // alone — but it is still a pure re-ack of an already-durable write, EXACTLY
    // like the non-null path above, so it must NOT be forced through the mutation
    // gate. `resolveNullHashReack` recomputes the canonical-ops hash from the
    // stored op `frame_json`; on an exact match we re-ack the original seq HERE,
    // BEFORE guardMutation, so a downgraded / epoch-advanced connection resending a
    // committed pre-deploy frame after a lost ack is acknowledged instead of
    // refused `stale-epoch` / `forbidden-role` and left permanently unsynced
    // (XIN-1750). A MISMATCH (a reused frameId carrying DIFFERENT ops) or a PRUNED
    // op row (no frame_json to verify against) does NOT re-ack: it falls through to
    // the mutation gate + appendOp, which correctly gates a genuine new write and
    // fails closed on a pruned frame — so a downgraded socket can never smuggle a
    // DIFFERENT payload through this pre-gate path on frameId alone. The identity /
    // read gate above already bound every frame; this exempts ONLY the pure
    // re-ack-of-own-durable-write from the writer/epoch checks.
    if (known !== null && known.payloadHash === null && this.store.resolveNullHashReack) {
      let resolved: { seq: number; payloadHash: string } | null = null
      try {
        resolved = await this.store.resolveNullHashReack(conn.docId, frameId)
      } catch {
        /* fall through: appendOp's resolveDuplicate remains the authoritative dedup */
      }
      if (resolved !== null && resolved.payloadHash === payloadHash) {
        await this.reackDuplicate(conn, frame, resolved.seq)
        return
      }
    }
    // Not a known duplicate (or a NULL-hash row we could not verify as one): enforce
    // the mutation gate (size / doc-status / epoch / role). Only genuinely new
    // mutations reach here, so a downgraded or stale-epoch connection is refused for
    // any write it has not already committed.
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
      if (isDuplicateFramePayloadError(err)) {
        this.refuse(conn, 'protocol-version', { k, frameId, message: 'frameId payload mismatch' })
        return
      }
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
    // Advance the observation high-water for this authored write ONLY when it is a
    // genuine observation of the room prefix (XIN-1739 P0-1). Three conditions must
    // all hold, else the watermark would be advanced past ops this connection never
    // received — poisoning the replay clamp, the live-buffer dedup, and the snapshot
    // prune gate that all key off it:
    //   · `!duplicate` — a slow-duplicate resend that fell through to `appendOp`
    //     (the ledger fast-path missed it) is a re-ack of an already-durable frame,
    //     NOT evidence the prefix below it was observed (XIN-1739 P0-1b), exactly the
    //     invariant `reackDuplicate` documents for the pre-gate re-ack paths.
    //   · `caughtUp` — a fresh authored write from a not-yet-caught-up socket (a
    //     client that pipelined `hello since=0` with a pending local write) would
    //     otherwise set its own newly-allocated seq as the replay floor and skip the
    //     whole op log (XIN-1739 P0-1a).
    //   · `flushDepth === 0` — a caught-up author writing WHILE a drain is in flight
    //     (an epoch-bump / reauth cutover) would advance past peer ops still sitting
    //     in `liveBuffer`, which `flushLiveBuffer`'s dedup then silently discards
    //     (XIN-1739 P0-1c). During a drain the delivered prefix is in flux, so an own
    //     write is not yet a safe observation.
    // A caught-up author with no drain pending HAS received every lower real op in
    // room order before its own ack, so advancing then is correct and lets it
    // snapshot its own latest write.
    if (!duplicate && conn.caughtUp && conn.flushDepth === 0) this.markObservedSeq(conn, seq)
    void this.gatedSend(conn, { ctl: 'ack', k: frame.k ?? 0, q: seq, snapshotVersion })
    // Broadcast to peers only for a first-seen frame (no echo, no double-apply).
    if (!duplicate) this.broadcast(conn, { ctl: 'op', q: seq, frame })
  }

  private async handleSnap(conn: Conn, frame: SnapFrame, rawBytes: number): Promise<void> {
    const k = typeof frame.k === 'number' ? frame.k : undefined
    if (!conn.caughtUp || conn.replayInFlight || conn.flushDepth > 0) {
      this.refuse(conn, 'snapshot-conflict', { k, message: 'snapshot requires a caught-up connection' })
      return
    }
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
    // A snapshot must cover a real, non-regressing prefix the connection has
    // actually observed (its high-water); global currentSeq alone is not authority
    // for this writer, because an uncaught-up socket could otherwise prune ops it
    // never saw. Contiguity is NOT required: a writer that observed/acked seq 3 may
    // snapshot q=3 even if seq 2 is a burned compatibility hole — prune stays safe
    // because there is no durable op row for the hole and all real ops <= covered
    // were delivered by the single room order before any higher real op (XIN-1739).
    //
    // Prune authority is ALSO bound to the connection's ACTUAL delivery floor
    // (XIN-1739 P0-1/P1): `observedHighWater` alone can be inflated by a caught-up
    // socket's own fresh write even though it reached "caught up" via a CLAIMED
    // `hello.since` cursor and never received the ops below that cursor. Such a
    // prune would delete a durable op prefix no one on this socket ever observed.
    // Refuse unless everything below `coverageFloor` is already subsumed by a
    // DURABLE snapshot (`coverageFloor <= existing.coveredSeq`) — i.e. there are no
    // un-delivered, un-snapshotted ops the prune could destroy. A from-scratch
    // socket that streamed the whole log has `coverageFloor = 0` and passes; a
    // claimed-cursor socket has `coverageFloor = its claimed since` and is refused
    // until it genuinely replays that prefix or a snapshot already covers it.
    const existingCovered = existing?.coveredSeq ?? 0
    if (
      covered < 0 ||
      covered > currentSeq ||
      covered > conn.observedHighWater ||
      (existing && covered < existing.coveredSeq) ||
      conn.coverageFloor > existingCovered
    ) {
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
    void this.gatedSend(conn, { ctl: 'ack', k: frame.k ?? 0, q: covered, snapshotVersion })
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
          conn.auth = { readAllowed: false, invalidated: false, pendingReauth: true }
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
        const downgraded = roleRank(role) < roleRank(conn.role)
        if (downgraded) {
          conn.role = role
        }
        // Record that this connection's role now reflects the live epoch, so
        // guardMutation does not re-resolve it again for the same epoch. Only
        // stamp when we actually have the authoritative epoch — otherwise leave
        // roleEpoch stale so the per-frame guard re-resolves later.
        if (epochOk) conn.roleEpoch = newEpoch
        // Do NOT set a sticky pendingReauth when the epoch read merely FAILED
        // (XIN-1739 P1-3). `recheckRole` above already re-resolved this connection's
        // authority from the live `roleProvider` (fresh share_scope/share_role, and a
        // load-bearing frozen membership claim would have taken the close-membership
        // branch), so a non-`none` outcome means the socket IS currently authorized —
        // only the epoch VERSION stamp is missing. Leaving `roleEpoch` stale (above)
        // makes `guardMutation` / `refreshReadAuth` re-resolve and re-check the epoch
        // per frame once the transient failure clears, so mutations stay fail-closed
        // (a frame at the wrong epoch is `stale-epoch`) WITHOUT permanently disabling
        // an otherwise-authorized socket. The previous `pendingReauth: !epochOk` had
        // NO clearer on this path (refreshReadAuth/refreshRoleDownOnly preserve it,
        // armReauthGrace was never called here, and no client sends `reauth`
        // unprompted), so a single transient epoch-read blip left the socket neither
        // usable (reads suppressed, writes `forbidden-role`) nor closed — forever.
        conn.auth = { readAllowed: roleAtLeast(conn.role, 'reader'), invalidated: false }
        if (downgraded) void this.gatedSend(conn, { ctl: 'role-changed', role: conn.role, epoch: newEpoch })
        if (roleAtLeast(conn.role, 'reader') && conn.caughtUp) void this.drainLiveBuffer(conn)
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
