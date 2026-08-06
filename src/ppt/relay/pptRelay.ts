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
 *    is not rebroadcast;
 *  - a `snap` advances the snapshot version atomically, then prunes covered ops;
 *  - refusals classify retry: ONLY `rate-limited` is retryable; every permanent
 *    refusal is surfaced (the client shows unsynced state, never a silent drop);
 *  - permission epoch is the live cutoff: stale-epoch mutations are refused, and
 *    a downgrade to `none` / a deleted doc closes the socket (4403 / 4404).
 */
import type { IncomingMessage } from 'node:http'
import type { Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { config } from '../../config/env.js'
import { roleAtLeast, roleRank, type ResolvedRole } from '../../permission/role.js'
import { isBentoDoc, type BentoDoc } from '../bentoDoc.js'
import {
  parseClientFrame,
  opsAreValid,
  isRetryable,
  type OpsFrame,
  type SnapFrame,
  type RefusedCode,
  type ServerFrame,
} from './frames.js'
import type { PptRelayStore } from './store.js'
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
/** WS internal-error close (RFC 6455 1011): a store failure we cannot recover. */
export const CLOSE_UNAVAILABLE = 1011

export interface RelayLimits {
  maxFrameBytes: number
  maxOpsPerFrame: number
  maxFramesPerWindow: number
  rateWindowMs: number
  maxSingleBlobBytes: number
  maxRoomFrameBytes: number
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
  }
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
}

function send(socket: WebSocket, frame: ServerFrame): void {
  try {
    socket.send(JSON.stringify(frame))
  } catch {
    /* peer closed mid-broadcast; the close handler prunes it */
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

  constructor(deps: PptRelayDeps) {
    this.store = deps.store
    this.verifyTicket = deps.verifyTicket ?? verifyPptRelayTicket
    this.ticketStore = deps.ticketStore ?? new InMemoryTicketStore()
    this.epochProvider = deps.epochProvider
    this.roleProvider = deps.roleProvider
    this.docStatusProvider = deps.docStatusProvider
    this.pv = deps.protocolVersion ?? config.ppt.relay.protocolVersion
    this.limits = { ...defaultLimits(), ...(deps.limits ?? {}) }
    // noServer: the relay owns no listener of its own — it is attached to B's
    // existing HTTP server (no second service).
    this.wss = new WebSocketServer({ noServer: true })
  }

  /** Attach to an existing HTTP server, handling upgrades on `/api/v1/ppt/collab`. */
  attach(server: HttpServer, path = '/api/v1/ppt/collab'): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      let pathname: string
      try {
        pathname = new URL(req.url ?? '', 'http://localhost').pathname
      } catch {
        return
      }
      if (pathname !== path) return // let other upgrade handlers (Hocuspocus) win
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

    const conn: Conn = {
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
    }
    this.addToRoom(conn)

    socket.on('message', (data: unknown) => {
      const raw = typeof data === 'string' ? data : String(data)
      void this.onMessage(conn, raw)
    })
    socket.on('close', () => this.removeFromRoom(conn))
    socket.on('error', () => this.removeFromRoom(conn))
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
      send(peer.socket, frame)
    }
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
    const run = prev.then(task, task).catch(() => {})
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
    send(conn.socket, {
      ctl: 'refused',
      code,
      retryable,
      ...(retryable && opts.retryInMs !== undefined ? { retryInMs: opts.retryInMs } : {}),
      ...(opts.k !== undefined ? { k: opts.k } : {}),
      ...(opts.frameId !== undefined ? { frameId: opts.frameId } : {}),
      ...(opts.message !== undefined ? { message: opts.message } : {}),
    })
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
        await this.replay(conn, typeof frame.since === 'number' ? frame.since : 0)
        return
      case 'need':
        await this.replay(conn, typeof frame.since === 'number' ? frame.since : 0, /* ready */ false)
        return
      case 'p':
        this.broadcast(conn, { ctl: 'presence', uid: conn.uid, ...(conn.name ? { name: conn.name } : {}), presence: (frame as { presence?: unknown }).presence })
        return
      case 'bye':
        this.broadcast(conn, { ctl: 'presence', uid: conn.uid, ...(conn.name ? { name: conn.name } : {}), presence: undefined })
        conn.socket.close(1000, 'bye')
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
   * Replay `snapshot -> ops since q -> ready` (§7.3). `need` omits the ready.
   *
   * `since` is an OP-SEQUENCE cursor, NOT a snapshot version (XIN-1655 C5): the
   * client resumes from the highest op seq it has already applied — 0 on a fresh
   * join, or the last `ready.q`/`op.q`/`ack.q` it saw on a reconnect. The
   * `snapshotVersion` the collab-token hands the client is a version TAG for
   * change detection, never a replay cursor; conflating the two would skip ops
   * whenever the version counter and the covered op-seq diverge.
   *
   * A store failure here must never leave the client hanging with neither `ready`
   * nor `refused` (§7.3 "never a silent drop"): the whole replay is wrapped so a
   * failure surfaces a permanent `storage-failed` refusal and closes the socket
   * (XIN-1655 C4).
   */
  private async replay(conn: Conn, since: number, ready = true): Promise<void> {
    try {
      const snap = await this.store.getSnapshot(conn.docId)
      let fromSeq = since
      // Only send the snapshot to a peer behind it; an already-synced peer is not
      // forced to reapply it (PPT-COLLAB-003).
      if (snap && since < snap.coveredSeq) {
        send(conn.socket, { ctl: 'snapshot', snapshotVersion: snap.snapshotVersion, doc: snap.doc })
        fromSeq = snap.coveredSeq
      }
      const ops = await this.store.opsSince(conn.docId, fromSeq)
      // Track the highest op seq ACTUALLY delivered in this replay so `ready.q`
      // reports what the client is truly synced through — not the counter
      // high-water (XIN-1655 C6). The floor is `fromSeq`: after a snapshot the
      // client is synced through `coveredSeq` even when no tail op follows; on a
      // plain resume it is already synced through `since`.
      let delivered = fromSeq
      for (const op of ops) {
        send(conn.socket, { ctl: 'op', q: op.seq, frame: op.frame })
        delivered = op.seq
      }
      if (ready) {
        // Fallback is the connection's last-known LIVE epoch (validated at
        // handshake), NOT the snapshot version — stamping a snapshot counter as an
        // epoch would make every subsequent mutation fail `stale-epoch` with no
        // recovery. If the provider is momentarily down we surface the last real
        // epoch; a mutating frame re-checks the live epoch anyway.
        let epoch = conn.roleEpoch
        try {
          epoch = await this.epochProvider(conn.documentName)
        } catch {
          /* keep replay usable with the last-known epoch; mutation re-checks */
        }
        send(conn.socket, {
          ctl: 'ready',
          q: delivered,
          snapshotVersion: snap?.snapshotVersion ?? 0,
          epoch,
          role: conn.role,
        })
      }
    } catch {
      // A store failure on replay is a permanent refusal, surfaced then closed —
      // never a silent hang (XIN-1655 C4). The client re-mints a ticket and
      // reconnects to retry replay.
      this.refuse(conn, 'storage-failed', { message: 'replay failed' })
      conn.socket.close(CLOSE_UNAVAILABLE, 'replay failed')
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
        if ((await this.docStatusProvider(conn.docId)) === 'deleted') return 'doc-deleted'
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
      await this.refreshRoleDownOnly(conn, live)
    }
    // Only writer/admin may persist; a reader/commenter (or a downgraded socket
    // at the current epoch) is refused `forbidden-role`.
    if (!roleAtLeast(conn.role, 'writer')) return 'forbidden-role'
    return null
  }

  /**
   * Re-resolve `conn.role` against the current `live` epoch, applying ONLY a
   * downgrade (elevated authority needs a fresh ticket per PPT-EPOCH-003). Fails
   * closed to `none` when no roleProvider is wired or the lookup throws, so a
   * mutation can never ride a role that predates the live epoch. Stamps
   * `roleEpoch = live` so a settled connection re-resolves at most once per epoch
   * change rather than on every frame.
   */
  private async refreshRoleDownOnly(conn: Conn, live: number): Promise<void> {
    let resolved: ResolvedRole = 'none'
    if (this.roleProvider) {
      try {
        resolved = await this.roleProvider({
          uid: conn.uid,
          docId: conn.docId,
          documentName: conn.documentName,
          spaceMember: conn.spaceMember,
        })
      } catch {
        resolved = 'none'
      }
    }
    if (roleRank(resolved) < roleRank(conn.role)) conn.role = resolved
    conn.roleEpoch = live
  }

  /** Sliding-window rate limit; returns retry delay ms when the frame is over. */
  private rateLimited(conn: Conn): number | null {
    const now = Date.now()
    const windowStart = now - this.limits.rateWindowMs
    conn.frameTimes = conn.frameTimes.filter((t) => t > windowStart)
    if (conn.frameTimes.length >= this.limits.maxFramesPerWindow) {
      const oldest = conn.frameTimes[0] ?? now
      return Math.max(1, oldest + this.limits.rateWindowMs - now)
    }
    conn.frameTimes.push(now)
    return null
  }

  /**
   * Return the room's current persisted-byte budget usage, seeding it once from
   * durable state. The counter is process-local, so on a fresh process (restart,
   * or another node) it would otherwise start at 0 and ignore already-persisted
   * ops; seeding from the store's `roomBytes` makes the first frame per room
   * account for the durable backlog. A seed failure leaves the room unseeded so a
   * later frame retries rather than pinning a wrong 0.
   */
  private async ensureRoomBudget(docId: string): Promise<number> {
    if (!this.roomBytesSeeded.has(docId)) {
      try {
        const durable = await this.store.roomBytes(docId)
        // Do not clobber bytes counted by frames that landed during the seed read.
        this.roomBytes.set(docId, Math.max(durable, this.roomBytes.get(docId) ?? 0))
        this.roomBytesSeeded.add(docId)
      } catch {
        /* leave unseeded; retry on the next frame */
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
    const roomUsed = await this.ensureRoomBudget(conn.docId)
    if (roomUsed + frameBytes > this.limits.maxRoomFrameBytes) {
      this.refuse(conn, 'room-full', { k, frameId, message: 'room frame budget exhausted' })
      return
    }
    const retryInMs = this.rateLimited(conn)
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
    } catch {
      this.refuse(conn, 'storage-failed', { k, frameId, message: 'durable persistence failed' })
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
    send(conn.socket, { ctl: 'ack', k: frame.k, q: seq, snapshotVersion })
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
    const currentSeq = await this.store.currentSeq(conn.docId)
    const existing = await this.store.getSnapshot(conn.docId)
    // A snapshot must cover a real, non-regressing prefix of the op log.
    if (covered < 0 || covered > currentSeq || (existing && covered < existing.coveredSeq)) {
      this.refuse(conn, 'snapshot-conflict', { k, message: 'snapshot covered seq conflicts with the op log' })
      return
    }
    let snapshotVersion: number
    try {
      const res = await this.store.saveSnapshot({ docId: conn.docId, coveredSeq: covered, doc: frame.doc as BentoDoc })
      snapshotVersion = res.snapshotVersion
    } catch {
      this.refuse(conn, 'storage-failed', { k, message: 'snapshot persistence failed' })
      return
    }
    // GC only AFTER the snapshot is durable (§7.3). The snapshot is already
    // committed, so a prune failure must NOT swallow the ack (the pruned ops are
    // subsumed by the durable snapshot; leaving them just defers GC). Reclaim the
    // freed bytes from the room budget so it does not monotonically grow.
    try {
      const freed = await this.store.pruneOpsThrough(conn.docId, covered)
      if (this.roomBytesSeeded.has(conn.docId)) {
        const used = this.roomBytes.get(conn.docId) ?? 0
        this.roomBytes.set(conn.docId, Math.max(0, used - freed))
      }
    } catch {
      /* keep the ack: the snapshot is durable; prune is best-effort GC */
    }
    send(conn.socket, { ctl: 'ack', k: frame.k ?? 0, q: covered, snapshotVersion })
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
        let role: ResolvedRole
        try {
          role = await this.roleProvider({
            uid: conn.uid,
            docId: conn.docId,
            documentName: conn.documentName,
            spaceMember: conn.spaceMember,
          })
        } catch {
          role = 'none'
        }
        if (role === 'none') {
          conn.socket.close(CLOSE_FORBIDDEN, 'access revoked')
          this.removeFromRoom(conn)
          continue
        }
        // Only a downgrade takes effect live; an upgrade needs fresh authority.
        if (roleRank(role) < roleRank(conn.role)) {
          conn.role = role
          send(conn.socket, { ctl: 'role-changed', role, epoch: newEpoch })
        }
        // Record that this connection's role now reflects the live epoch, so
        // guardMutation does not re-resolve it again for the same epoch. Only
        // stamp when we actually have the authoritative epoch — otherwise leave
        // roleEpoch stale so the per-frame guard re-resolves later.
        if (epochOk) conn.roleEpoch = newEpoch
      }
    }
  }

  /** Close every socket in a deleted doc's room with 4404 (§6.4 / EPOCH-002). */
  closeRoomForDeleted(docId: string): void {
    const room = this.rooms.get(docId)
    if (!room) return
    for (const conn of [...room]) {
      conn.socket.close(CLOSE_NOT_FOUND, 'document deleted')
      this.removeFromRoom(conn)
    }
  }

  /** Current live connection count for a room (observability / tests). */
  roomSize(docId: string): number {
    return this.rooms.get(docId)?.size ?? 0
  }

  close(): void {
    for (const room of this.rooms.values()) {
      for (const conn of [...room]) conn.socket.close(1001, 'relay shutting down')
    }
    this.rooms.clear()
    this.wss.close()
  }
}
