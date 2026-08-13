/**
 * collab token sign / verify (§4.4 / remove-sp §7).
 *
 * Layer-2 of the two-layer token chain: a docs-backend-signed, minute-level
 * short-lived JWT, minimal privilege, scoped to "this documentName + uid +
 * role + epoch". Used ONLY for the WS handshake (never reuse the long-lived
 * octo session token on the WS — §4.4).
 *
 * TWO wire versions coexist during the compat window (remove-sp §7.2):
 *   - legacy v1 (NO `ver` claim): { uid, documentName, role, permission_epoch,
 *     name?, space_member?, exp }. The historical shape; verified with the
 *     documentName + role + permission_epoch binding only.
 *   - v2 (`ver: 2`): camelCase wire schema bound to the doc's identity —
 *     { ver:2, uid, docId, documentName, homeSpaceId, role, permissionEpoch,
 *       name?, spaceMember?, exp }. The WS verifier additionally binds docId /
 *     homeSpaceId / canonical documentName (remove-sp §7.3).
 *
 * Version identification has EXACTLY two legal branches (remove-sp §7.2 step 4):
 *   `ver` absent  => legacy v1 (compat window only);
 *   `ver === 2`   => v2.
 * Any other `ver` (1, 3, a string, a float, …) is rejected outright — the
 * version is never inferred from which other claims are present/absent.
 *
 * The DB stores epoch as snake_case `permission_epoch`; the v2 WIRE claim is
 * camelCase `permissionEpoch`. verifyCollabToken maps a v2 token back to the
 * shared internal `CollabClaims` (snake `permission_epoch`, `space_member`) so
 * every downstream consumer reads one shape regardless of wire version.
 *
 * TODO(§4.4): dev uses an HS256 shared secret. Production should sign with an
 * asymmetric key (issuer/validator same authoritative source) per §4.5.
 */
import jwt from 'jsonwebtoken'
import { config } from '../config/env.js'
import type { Role } from '../permission/role.js'

export const LEGACY_COLLAB_AUD = 'legacy-collab'

export interface CollabClaims {
  uid: string
  documentName: string
  role: Role
  permission_epoch: number
  /**
   * Trusted display name for `uid`, resolved from the octo user directory at
   * issuance (§4.7(b)). Optional: absent when the directory could not supply a
   * name. Carried so the collab/presence layer can stamp the awareness frame's
   * `user.name` with a real name instead of the raw uid a not-yet-resolved
   * client publishes (XIN-694). Never the identity itself — `uid` stays the id.
   */
  name?: string
  /**
   * (#64) Was `uid` a member of the doc's Space at issuance time? Baked in so the
   * hot-path write recheck (beforeHandleMessage) can honor the anyone_in_space
   * share scope without a fresh octo-server membership call. OPTIONAL: a token
   * minted before this change carries no claim and is treated as `false`
   * (fail-closed), exactly like the optional `name` claim. Never client-supplied
   * — derived server-side at issuance from isSpaceMember / the bot's space.
   */
  space_member?: boolean
  /**
   * (remove-sp §7) Wire version. Absent on legacy v1 tokens; `2` on v2. The WS
   * verifier keys the docId/homeSpaceId/canonical-documentName binding on this
   * being exactly 2 — a legacy token skips the new binding (compat window).
   */
  ver?: 2
  /** (v2 only) The doc's business id, bound at issuance (remove-sp §7.1). */
  docId?: string
  /** (v2 only) The doc's home Space id (== doc_meta.space_id), bound at issuance. */
  homeSpaceId?: string
}

/**
 * v2 issuance claim set (remove-sp §7.1). camelCase to match the v2 WIRE schema
 * and the existing `documentName` claim; the issuer resolves every field from
 * the SAME doc_meta row so docId / documentName / homeSpaceId are internally
 * consistent by construction.
 */
export interface CollabClaimsV2 {
  uid: string
  docId: string
  documentName: string
  homeSpaceId: string
  role: Role
  permissionEpoch: number
  name?: string
  spaceMember?: boolean
}

export interface CollabTokenResult {
  token: string
  expiresAt: string // ISO8601
  role: Role
  // Current permission epoch for the doc (§4.5). Mirrors the signed claim so the
  // client can seed its epoch without decoding the JWT (previously absent, which
  // forced the frontend to default to 0 — XIN-210/211).
  permission_epoch: number
  // Absolute public WS origin for the collab handshake (§4.4). Present only when
  // the backend has COLLAB_TOKEN_PUBLIC_WS_URL configured; omitted otherwise so
  // the client falls back to its build-time env during the compat phase.
  collabWsUrl?: string
  // Trusted display name resolved at issuance (§4.7(b)). Surfaced so the client
  // can seed its own presence name without a separate directory round-trip;
  // omitted when the directory supplied none (XIN-694).
  name?: string
}

/**
 * Assemble the common CollabTokenResult envelope (expiresAt / collabWsUrl /
 * name) shared by the v1 and v2 signers. Both surface the SAME response shape —
 * the wire version differs only inside the JWT, never in this envelope.
 */
function buildTokenResult(token: string, role: Role, permissionEpoch: number, name?: string): CollabTokenResult {
  const expiresAt = new Date((Math.floor(Date.now() / 1000) + config.collabToken.ttlSeconds) * 1000).toISOString()
  const result: CollabTokenResult = { token, expiresAt, role, permission_epoch: permissionEpoch }
  // Only surface an absolute, configured WS origin; never emit an empty/relative
  // one (resolveCollabPublicWsUrl already normalised unset/malformed to '').
  if (config.collabToken.publicWsUrl !== '') {
    result.collabWsUrl = config.collabToken.publicWsUrl
  }
  if (name !== undefined) {
    result.name = name
  }
  return result
}

/**
 * Sign a legacy v1 collab token (§4.4). NO `ver` claim — the verifier treats an
 * absent `ver` as legacy v1 during the compat window (remove-sp §7.2). New
 * doc-addressed issuance uses {@link signCollabTokenV2}; this signer stays for
 * the documentName-addressed legacy `POST /collab-token` compat entry.
 */
export function signCollabToken(claims: CollabClaims): CollabTokenResult {
  const ttl = config.collabToken.ttlSeconds
  // Only sign a name claim when the directory actually supplied one; an empty
  // string carries no information and would just bloat every frame.
  const name = typeof claims.name === 'string' && claims.name !== '' ? claims.name : undefined
  const token = jwt.sign(
    {
      uid: claims.uid,
      documentName: claims.documentName,
      role: claims.role,
      permission_epoch: claims.permission_epoch,
      ...(name !== undefined ? { name } : {}),
      // Only stamp the claim when the requester IS a space member; absence is the
      // canonical "false" so an old token (no claim) and a non-member both
      // fail-closed on the share path (design §5.2f / O1).
      ...(claims.space_member === true ? { space_member: true } : {}),
    },
    config.collabToken.secret,
    { algorithm: 'HS256', audience: LEGACY_COLLAB_AUD, expiresIn: ttl },
  )
  return buildTokenResult(token, claims.role, claims.permission_epoch, name)
}

/**
 * Sign a v2 collab token (remove-sp §7.1): camelCase wire schema bound to the
 * doc's identity (docId + homeSpaceId + canonical documentName + permissionEpoch).
 * Minted by the docId-first issuance path; the WS verifier enforces the full
 * binding for `ver === 2`.
 */
export function signCollabTokenV2(claims: CollabClaimsV2): CollabTokenResult {
  const ttl = config.collabToken.ttlSeconds
  const name = typeof claims.name === 'string' && claims.name !== '' ? claims.name : undefined
  const token = jwt.sign(
    {
      ver: 2,
      uid: claims.uid,
      docId: claims.docId,
      documentName: claims.documentName,
      homeSpaceId: claims.homeSpaceId,
      role: claims.role,
      permissionEpoch: claims.permissionEpoch,
      ...(name !== undefined ? { name } : {}),
      ...(claims.spaceMember === true ? { spaceMember: true } : {}),
    },
    config.collabToken.secret,
    { algorithm: 'HS256', expiresIn: ttl },
  )
  return buildTokenResult(token, claims.role, claims.permissionEpoch, name)
}

/**
 * Verify a collab token: signature + not-expired (§4.1 step 1). Throws on
 * invalid/expired signature (caller maps to 4401). Returns the parsed claims in
 * the shared internal shape (snake `permission_epoch` / `space_member`),
 * regardless of wire version.
 *
 * Version dispatch (remove-sp §7.2): EXACTLY two legal branches —
 *   - `ver` absent  => legacy v1 (compat window);
 *   - `ver === 2`   => v2 (camelCase wire; mapped back to the shared shape,
 *     carrying `ver`/`docId`/`homeSpaceId` for the WS binding).
 * Any other `ver` value is rejected (throws). The version is NEVER inferred
 * from which other claims happen to be present.
 */
export function verifyCollabToken(token: string): CollabClaims {
  const decoded = jwt.verify(token, config.collabToken.secret, { algorithms: ['HS256'] })
  if (typeof decoded !== 'object' || decoded === null) {
    throw new Error('invalid collab token payload')
  }
  const d = decoded as Record<string, unknown>
  // Audience scoping (R4-B1): a collab token minted for a different audience
  // (e.g. the PPT relay) must never verify on this path. Absent `aud` is
  // tolerated for the compat window; a present-but-foreign audience is rejected.
  // Enforced before version dispatch so it applies to every wire version.
  const aud = d.aud
  if (aud !== undefined && aud !== LEGACY_COLLAB_AUD) {
    throw new Error('invalid collab token audience')
  }
  // PPT collab credentials are never valid on this endpoint (the PPT relay uses
  // its own token + ticket over the durable Bento transport, R4-B1). Reject
  // defensively before version dispatch, regardless of wire version — such a
  // token is never minted here, so this only fires on a forged/misrouted one.
  const docName = d.documentName
  if (d.kind === 'html_ppt' || (typeof docName === 'string' && docName.includes(':ppt:'))) {
    throw new Error('ppt collab credentials are not valid on the legacy collab endpoint')
  }
  const ver = d.ver

  if (ver === undefined) return verifyLegacyV1(d)
  if (ver === 2) return verifyV2(d)
  // ver present but not exactly 2 (1, 3, "2", 2.5, …) — never loosely coerce.
  throw new Error(`unsupported collab token version: ${String(ver)}`)
}

function isRole(v: unknown): v is Role {
  return v === 'reader' || v === 'commenter' || v === 'writer' || v === 'admin'
}

/** Parse a legacy v1 token (no `ver`). Byte-for-byte the pre-remove-sp shape. */
function verifyLegacyV1(d: Record<string, unknown>): CollabClaims {
  const uid = d.uid
  const documentName = d.documentName
  const role = d.role
  const permission_epoch = d.permission_epoch
  if (typeof uid !== 'string' || typeof documentName !== 'string' || !isRole(role) || typeof permission_epoch !== 'number') {
    throw new Error('invalid collab token claims')
  }
  // name is optional and cosmetic — a non-string or empty claim is simply
  // dropped (never a rejection reason), so an old token minted before the
  // name claim existed verifies exactly as before.
  const name = d.name
  // space_member is optional (#64): absent / non-boolean => false (fail-closed),
  // so a token minted before this claim existed grants no share-derived access
  // but keeps its direct `role` (design §5.2f / O1).
  const spaceMember = d.space_member === true
  return {
    uid,
    documentName,
    role,
    permission_epoch,
    ...(typeof name === 'string' && name !== '' ? { name } : {}),
    ...(spaceMember ? { space_member: true } : {}),
  }
}

/**
 * Parse a v2 token (`ver === 2`). Maps the camelCase wire schema back to the
 * shared internal shape and carries the identity binding (docId / homeSpaceId)
 * so the WS handshake can enforce it (remove-sp §7.3). Fails closed on any
 * missing/mistyped required claim.
 */
function verifyV2(d: Record<string, unknown>): CollabClaims {
  const uid = d.uid
  const docId = d.docId
  const documentName = d.documentName
  const homeSpaceId = d.homeSpaceId
  const role = d.role
  const permissionEpoch = d.permissionEpoch
  if (
    typeof uid !== 'string' ||
    typeof docId !== 'string' ||
    typeof documentName !== 'string' ||
    typeof homeSpaceId !== 'string' ||
    !isRole(role) ||
    typeof permissionEpoch !== 'number'
  ) {
    throw new Error('invalid collab token claims (v2)')
  }
  const name = d.name
  const spaceMember = d.spaceMember === true
  return {
    uid,
    documentName,
    role,
    permission_epoch: permissionEpoch,
    ver: 2,
    docId,
    homeSpaceId,
    ...(typeof name === 'string' && name !== '' ? { name } : {}),
    ...(spaceMember ? { space_member: true } : {}),
  }
}
