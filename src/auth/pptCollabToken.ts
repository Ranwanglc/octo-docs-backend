/**
 * PPT relay token + one-time WS ticket sign/verify (§7.1).
 *
 * The `html_ppt` (Bento slide-deck) collaboration path deliberately does NOT
 * reuse the Hocuspocus collab token (see issueCollabToken, which rejects
 * `html_ppt` with `unsupported_document_type`). Instead `POST
 * /api/v1/ppt/docs/collab-token` mints TWO credentials:
 *
 *   1. A short-lived RELAY TOKEN (JWT, `aud:'ppt-relay'`) carrying the trusted
 *      identity/authorization the relay needs: uid, docId, documentName, role,
 *      permission epoch, and trusted display name. Returned to the client
 *      alongside `pptWsUrl`, `snapshotVersion`, `expiresAt`, and `name` so the
 *      client can seed its session without decoding the JWT.
 *   2. A single-use WS TICKET (JWT, `aud:'ppt-relay-ticket'`, unique `jti`) that
 *      is carried in the WS handshake's `Sec-WebSocket-Protocol` header — NEVER a
 *      long-lived credential in the URL (§7.1). The ticket is consumed exactly
 *      once at connect time via the {@link TicketStore}; a replayed ticket is
 *      rejected.
 *
 * Both are HS256-signed with the shared `COLLAB_TOKEN_SECRET`, distinguished by
 * `aud`, so a relay token can never be replayed as a ticket and vice versa.
 * (Production should move to an asymmetric key per §4.5 — same TODO the legacy
 * collab token carries.)
 */
import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'
import { config } from '../config/env.js'
import { getRedis, rkey } from '../db/redis.js'
import type { Role } from '../permission/role.js'

/** JWT audience for the primary relay token. */
export const PPT_RELAY_AUD = 'ppt-relay'
/** JWT audience for the one-time WS handshake ticket. */
export const PPT_RELAY_TICKET_AUD = 'ppt-relay-ticket'

/**
 * The trusted claim set the relay reads off either credential. `docId` is the
 * room key; `documentName` is carried for the epoch cache lookup and audit;
 * `permission_epoch` is the live cutoff the relay enforces at handshake and on
 * every mutating frame.
 */
export interface PptCollabClaims {
  uid: string
  docId: string
  documentName: string
  role: Role
  permission_epoch: number
  /** Server-trusted display name resolved at issuance; absent when unknown. */
  name?: string
  /**
   * The caller's space-membership at issuance (§4.4). Carried so the relay can
   * re-resolve the SAME effective role issuance did — folding in an
   * `anyone_in_space` share grant via `recheckCurrentRole` — without holding the
   * caller's octo session token on the socket. Fail-closed: absent => false.
   */
  space_member?: boolean
  /** JWT expiry seconds since epoch, present on verified JWTs. */
  exp?: number
}

/** Enveloped `data` payload of a successful `collab-token` issuance (§7.1). */
export interface PptCollabTokenResult {
  /** Short-lived relay token (JWT, `aud:'ppt-relay'`). */
  token: string
  /** Single-use handshake ticket (JWT, `aud:'ppt-relay-ticket'`). */
  ticket: string
  /** ISO8601 expiry of `token`. */
  expiresAt: string
  /** ISO8601 expiry of the single-use `ticket` (shorter than the token). */
  ticketExpiresAt: string
  role: Role
  /** Live permission epoch — the client seeds its cutoff without decoding JWTs. */
  epoch: number
  /** The connection room key. */
  docId: string
  documentName: string
  /**
   * Authoritative live snapshot version at issuance. This is a version TAG for
   * snapshot-change detection, NOT the replay cursor: the relay's replay `since`
   * is an OP-SEQUENCE (0 on a fresh join, else the last `ready.q`/`op.q`/`ack.q`
   * the client saw), a different coordinate system (XIN-1655 C5). Feeding this
   * value in as `since` would skip ops whenever the version counter and the
   * covered op-seq diverge.
   */
  snapshotVersion: number
  /** Absolute browser-reachable relay WS origin; omitted when unconfigured. */
  pptWsUrl?: string
  /** Trusted display name; omitted when the directory supplied none. */
  name?: string
}

export interface IssuePptCollabInput {
  uid: string
  docId: string
  documentName: string
  role: Role
  permission_epoch: number
  snapshotVersion: number
  name?: string
  /** Caller's space-membership at issuance (fold-in for share-derived re-resolve). */
  spaceMember?: boolean
}

/**
 * Mint the relay token + one-time ticket for an authorized caller. The relay
 * token TTL reuses `collabToken.ttlSeconds`; the ticket TTL is the shorter
 * `ppt.relay.ticketTtlSeconds` (a handshake credential should not outlive the
 * few seconds between issuance and connect).
 */
export function issuePptCollabToken(input: IssuePptCollabInput): PptCollabTokenResult {
  const name = typeof input.name === 'string' && input.name !== '' ? input.name : undefined
  const claims = {
    uid: input.uid,
    docId: input.docId,
    documentName: input.documentName,
    role: input.role,
    permission_epoch: input.permission_epoch,
    ...(name !== undefined ? { name } : {}),
    ...(input.spaceMember !== undefined ? { space_member: input.spaceMember } : {}),
  }

  const tokenTtl = config.collabToken.ttlSeconds
  const ticketTtl = config.ppt.relay.ticketTtlSeconds

  const token = jwt.sign(claims, config.collabToken.secret, {
    algorithm: 'HS256',
    audience: PPT_RELAY_AUD,
    expiresIn: tokenTtl,
  })
  const ticket = jwt.sign({ ...claims, jti: randomUUID() }, config.collabToken.secret, {
    algorithm: 'HS256',
    audience: PPT_RELAY_TICKET_AUD,
    expiresIn: ticketTtl,
  })

  const now = Math.floor(Date.now() / 1000)
  const result: PptCollabTokenResult = {
    token,
    ticket,
    expiresAt: new Date((now + tokenTtl) * 1000).toISOString(),
    ticketExpiresAt: new Date((now + ticketTtl) * 1000).toISOString(),
    role: input.role,
    epoch: input.permission_epoch,
    docId: input.docId,
    documentName: input.documentName,
    snapshotVersion: input.snapshotVersion,
  }
  if (config.ppt.relay.publicWsUrl !== '') result.pptWsUrl = config.ppt.relay.publicWsUrl
  if (name !== undefined) result.name = name
  return result
}

function parseClaims(decoded: unknown): PptCollabClaims & { jti?: string } {
  if (typeof decoded !== 'object' || decoded === null) {
    throw new Error('invalid ppt collab token payload')
  }
  const d = decoded as Record<string, unknown>
  const { uid, docId, documentName, role, permission_epoch: epoch, name, jti, space_member: spaceMember, exp } = d
  if (
    typeof uid !== 'string' ||
    typeof docId !== 'string' ||
    typeof documentName !== 'string' ||
    (role !== 'reader' && role !== 'commenter' && role !== 'writer' && role !== 'admin') ||
    typeof epoch !== 'number'
  ) {
    throw new Error('invalid ppt collab token claims')
  }
  return {
    uid,
    docId,
    documentName,
    role,
    permission_epoch: epoch,
    ...(typeof name === 'string' && name !== '' ? { name } : {}),
    ...(typeof spaceMember === 'boolean' ? { space_member: spaceMember } : {}),
    ...(typeof jti === 'string' ? { jti } : {}),
    ...(typeof exp === 'number' ? { exp } : {}),
  }
}

/** Verify a relay token (signature + `aud:'ppt-relay'` + not-expired). */
export function verifyPptRelayToken(token: string): PptCollabClaims {
  const decoded = jwt.verify(token, config.collabToken.secret, {
    algorithms: ['HS256'],
    audience: PPT_RELAY_AUD,
  })
  return parseClaims(decoded)
}

/**
 * Verify a one-time ticket (signature + `aud:'ppt-relay-ticket'` + not-expired).
 * Returns the claims PLUS the `jti` the caller MUST consume exactly once through
 * a {@link TicketStore} — signature validity alone does not make it single-use.
 */
export function verifyPptRelayTicket(ticket: string): PptCollabClaims & { jti: string } {
  const decoded = jwt.verify(ticket, config.collabToken.secret, {
    algorithms: ['HS256'],
    audience: PPT_RELAY_TICKET_AUD,
  })
  const claims = parseClaims(decoded)
  if (typeof claims.jti !== 'string' || claims.jti === '') {
    throw new Error('ppt relay ticket missing jti')
  }
  return claims as PptCollabClaims & { jti: string }
}

/**
 * Single-use guard for handshake tickets. `consume(jti)` returns `true` the FIRST
 * time a jti is seen and `false` on every replay, so the relay can reject a
 * reused ticket even though its signature is still valid. The default is an
 * in-process store bounded by the ticket TTL; production wires a Redis-backed
 * store so single-use holds across relay nodes.
 */
export interface TicketStore {
  /** Returns true if this jti was unused (now consumed); false if already used. */
  consume(jti: string): Promise<boolean>
}

/**
 * In-memory single-use ticket store. Records consumed jtis with an expiry equal
 * to the ticket TTL and lazily evicts expired entries, so memory is bounded by
 * the number of tickets issued within one TTL window. Adequate for a single
 * relay node / tests; a multi-node deployment must inject a shared store.
 */
export class InMemoryTicketStore implements TicketStore {
  private readonly used = new Map<string, number>()
  private readonly ttlMs: number

  constructor(ttlSeconds = config.ppt.relay.ticketTtlSeconds) {
    // Retain a consumed jti a little past its own expiry so a replay inside the
    // validity window still hits the store (clock skew slack).
    this.ttlMs = (ttlSeconds + 5) * 1000
  }

  async consume(jti: string): Promise<boolean> {
    const now = Date.now()
    this.sweep(now)
    if (this.used.has(jti)) return false
    this.used.set(jti, now + this.ttlMs)
    return true
  }

  private sweep(now: number): void {
    for (const [jti, exp] of this.used) {
      if (exp <= now) this.used.delete(jti)
    }
  }
}

/**
 * Redis-backed single-use ticket store, so the single-use contract holds ACROSS
 * relay nodes (the whole point of the ticket — an `InMemoryTicketStore` only
 * guards replay within one process, which a horizontally-scaled relay violates).
 *
 * `consume(jti)` is a single atomic `SET <key> 1 NX EX <ttl>`: it returns `true`
 * only for the node that first sets the key and `false` for every replay on any
 * node while the key lives. The key auto-expires at the ticket TTL (plus a small
 * clock-skew slack), so consumed jtis do not accumulate.
 *
 * FAIL-CLOSED on a Redis error: a ticket that cannot be atomically consumed is
 * rejected rather than admitted, matching the epoch reader's posture (a store we
 * cannot confirm must not silently drop replay protection). This is a security
 * control; availability of the shared store is a hard dependency of the relay,
 * which already needs Redis/DB for the epoch cutoff.
 */
export class RedisTicketStore implements TicketStore {
  private readonly ttlSeconds: number

  constructor(ttlSeconds = config.ppt.relay.ticketTtlSeconds) {
    // Retain a consumed jti a little past its own expiry so a replay inside the
    // validity window still hits the store (clock skew slack).
    this.ttlSeconds = Math.max(1, Math.floor(ttlSeconds + 5))
  }

  async consume(jti: string): Promise<boolean> {
    const key = rkey('ppt-ticket', jti)
    const res = await getRedis().set(key, '1', 'EX', this.ttlSeconds, 'NX')
    return res === 'OK'
  }
}
