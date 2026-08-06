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

export interface PptRelayDeps {
  /** Durable op/snapshot store. */
  store: PptRelayStore
  /** Verify the ticket string -> claims (throws on invalid/expired). */
  verifyTicket?: (ticket: string) => PptCollabClaims & { jti: string }
  /** Single-use consume of a verified ticket's jti (false => already used). */
  ticketStore?: TicketStore
  /** Authoritative live epoch for a documentName (fail-closed: throw => reject). */
  epochProvider: (documentName: string) => Promise<number>
  /** Re-resolve a connection's role on an epoch bump (default: none => close). */
  roleProvider?: (uid: string, docId: string) => Promise<ResolvedRole>
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
  private readonly roleProvider?: (uid: string, docId: string) => Promise<ResolvedRole>
  private readonly docStatusProvider?: (docId: string) => Promise<'live' | 'deleted'>
  private readonly pv: number
  private readonly limits: RelayLimits
  private readonly rooms = new Map<string, Set<Conn>>()
  /** Cumulative persisted frame bytes per room (room-full guard). */
  private readonly roomBytes = new Map<string, number>()

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
    const fresh = await this.ticketStore.consume(claims.jti)
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
    if (claims.permission_epoch !== liveEpoch) {
      if (!this.roleProvider) {
        socket.close(CLOSE_UNAUTHORIZED, 'stale ticket epoch')
        return
      }
      try {
        role = await this.roleProvider(claims.uid, claims.docId)
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
    if (room.size === 0) this.rooms.delete(conn.docId)
  }

  private broadcast(conn: Conn, frame: ServerFrame): void {
    const room = this.rooms.get(conn.docId)
    if (!room) return
    for (const peer of room) {
      if (peer === conn) continue // sender never echoes its own op
      send(peer.socket, frame)
    }
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
        await this.handleOps(conn, frame as OpsFrame, raw.length)
        return
      case 'snap':
        await this.handleSnap(conn, frame as SnapFrame, raw.length)
        return
      default:
        this.refuse(conn, 'protocol-version', { message: 'unhandled frame type' })
    }
  }

  /** Replay `snapshot -> ops since q -> ready` (§7.3). `need` omits the ready. */
  private async replay(conn: Conn, since: number, ready = true): Promise<void> {
    const snap = await this.store.getSnapshot(conn.docId)
    let fromSeq = since
    // Only send the snapshot to a peer behind it; an already-synced peer is not
    // forced to reapply it (PPT-COLLAB-003).
    if (snap && since < snap.coveredSeq) {
      send(conn.socket, { ctl: 'snapshot', snapshotVersion: snap.snapshotVersion, doc: snap.doc })
      fromSeq = snap.coveredSeq
    }
    const ops = await this.store.opsSince(conn.docId, fromSeq)
    for (const op of ops) {
      send(conn.socket, { ctl: 'op', q: op.seq, frame: op.frame })
    }
    if (ready) {
      const q = await this.store.currentSeq(conn.docId)
      let epoch = snap?.snapshotVersion ?? 0
      try {
        epoch = await this.epochProvider(conn.documentName)
      } catch {
        /* keep replay usable; a mutating frame will re-check epoch */
      }
      send(conn.socket, {
        ctl: 'ready',
        q,
        snapshotVersion: snap?.snapshotVersion ?? 0,
        epoch,
        role: conn.role,
      })
    }
  }

  /** Shared pre-persist validation for `ops`/`snap` (returns a code or null). */
  private async guardMutation(conn: Conn, frameEpoch: number, rawBytes: number): Promise<RefusedCode | null> {
    if (rawBytes > this.limits.maxFrameBytes) return 'too-large'
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
        resolved = await this.roleProvider(conn.uid, conn.docId)
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
    const guardCode = await this.guardMutation(conn, typeof frame.epoch === 'number' ? frame.epoch : -1, rawBytes)
    if (guardCode) {
      this.refuse(conn, guardCode, { k, frameId })
      return
    }
    // Room-full: a room whose durable frame bytes would exceed the cap refuses
    // further persisted frames (permanent).
    const roomUsed = this.roomBytes.get(conn.docId) ?? 0
    if (roomUsed + rawBytes > this.limits.maxRoomFrameBytes) {
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
    if (!duplicate) this.roomBytes.set(conn.docId, roomUsed + rawBytes)

    const snap = await this.store.getSnapshot(conn.docId)
    const snapshotVersion = snap?.snapshotVersion ?? 0
    // Ack the sender ONLY after the durable write.
    send(conn.socket, { ctl: 'ack', k: frame.k, q: seq, snapshotVersion })
    // Broadcast to peers only for a first-seen frame (no echo, no double-apply).
    if (!duplicate) this.broadcast(conn, { ctl: 'op', q: seq, frame })
  }

  private async handleSnap(conn: Conn, frame: SnapFrame, rawBytes: number): Promise<void> {
    const k = typeof frame.k === 'number' ? frame.k : undefined
    if (rawBytes > this.limits.maxSingleBlobBytes) {
      this.refuse(conn, 'too-large', { k, message: 'snapshot exceeds single-blob limit' })
      return
    }
    const guardCode = await this.guardMutation(conn, typeof frame.epoch === 'number' ? frame.epoch : -1, rawBytes)
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
    // GC only AFTER the snapshot is durable (§7.3).
    await this.store.pruneOpsThrough(conn.docId, covered)
    send(conn.socket, { ctl: 'ack', k: frame.k ?? 0, q: covered, snapshotVersion })
  }

  /**
   * React to a permission-epoch bump on a room (§7.4). Re-resolves each
   * connection's role and applies ONLY the safe direction on the live socket:
   *   · `none`      → close the socket (4403); access revoked.
   *   · a DOWNGRADE → lower `conn.role` and notify `role-changed` so the client
   *                   disables editing; old-epoch frames in flight are refused.
   *   · an UPGRADE  → deliberately NOT applied to the live socket. Elevated
   *                   authority requires a FRESH token/ticket (PPT-EPOCH-003), so
   *                   the old socket stays non-mutating until the client
   *                   reconnects. We do not raise privileges mid-connection.
   * No-op when no `roleProvider` was injected.
   */
  async applyEpochBump(documentName: string): Promise<void> {
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
          role = await this.roleProvider(conn.uid, conn.docId)
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
