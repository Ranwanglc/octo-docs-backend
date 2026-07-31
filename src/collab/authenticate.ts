/**
 * onAuthenticate implementation (§4.1).
 *
 * Hot path: local JWT verify (CPU, no IO) + permission_epoch compare
 * (currentEpoch: Redis cache, miss -> DB singleflight) + role from claims.
 * Only the stale branch recheckCurrentRole hits doc_member + owner.
 *
 * Throws to reject the connection. The thrown Error.message encodes the WS
 * close-code semantics for the front-end (§8.2):
 *   'Unauthorized' -> 4401 (refreshable)
 *   'Forbidden'    -> 4403 (permanent no-access)
 */
import { verifyCollabToken } from '../auth/collabToken.js'
import { currentEpoch } from '../permission/epoch.js'
import { recheckCurrentRoleCached } from '../permission/recheck.js'
import { parseDocumentName } from '../permission/documentName.js'
import type { Role } from '../permission/role.js'

/**
 * Auth rejection carrying the WS close-code semantics (§8.2). Hocuspocus reads
 * `.reason` (and `.code` on some paths) from the thrown error.
 *   4401 Unauthorized (refreshable) / 4403 Forbidden (permanent no-access).
 */
export class AuthError extends Error {
  constructor(
    readonly code: 4401 | 4403,
    readonly reason: 'Unauthorized' | 'Forbidden',
  ) {
    super(reason)
    this.name = 'AuthError'
  }
}

const unauthorized = () => new AuthError(4401, 'Unauthorized')
const forbidden = () => new AuthError(4403, 'Forbidden')

export interface AuthContext {
  user: { id: string; name?: string }
  role: Role
  permission_epoch: number
  /**
   * (#64) Was this uid a member of the doc's Space at token issuance? Carried
   * from the collab token's optional `space_member` claim (absent => false,
   * fail-closed). The live-socket write recheck combines this token-carried
   * "who the requester is in the space" fact with a FRESH DB read of the doc's
   * share settings ("what the doc allows"), so a scope narrowing takes effect
   * without a new membership call. See design §5.3 case 2.
   */
  space_member: boolean
  /** 'document' (4-seg key) or 'whiteboard' (5-seg `:wb:` key, M2). */
  kind: 'document' | 'whiteboard'
  space: string
  folder: string
  /** doc id for documents; undefined for whiteboards (see `board`). */
  doc?: string
  /** board id for whiteboards; undefined for documents. */
  board?: string
}

export interface AuthInput {
  token: string
  documentName: string
  connectionConfig: { readOnly?: boolean }
}

export async function authenticate(data: AuthInput): Promise<AuthContext> {
  const { token, documentName, connectionConfig } = data

  // 1. verify collab token: signature + exp. Throws => 4401.
  let claims
  try {
    claims = verifyCollabToken(token)
  } catch {
    throw unauthorized() // 4401
  }

  // 2. token.documentName must match the connection documentName (anti-misuse).
  if (claims.documentName !== documentName) throw forbidden() // 4403

  // 3. permission_epoch check (§4.5). MUST await — number < Promise is always
  //    false and the stale branch would never run (P1-C).
  let epoch: number
  try {
    epoch = await currentEpoch(documentName)
  } catch {
    throw unauthorized() // 4401 — authoritative source unconfirmable, fail-closed
  }
  if (claims.permission_epoch < epoch) {
    let currentRole
    try {
      currentRole = await recheckCurrentRoleCached(
        documentName,
        claims.uid,
        claims.space_member ?? false,
      )
    } catch {
      throw unauthorized() // recheck unconfirmable => fail-closed (4401)
    }
    if (currentRole === 'none') throw forbidden() // 4403: fully revoked
    throw unauthorized() // 4401: refreshable, front-end refreshes token
  }

  // 4. role from claims (no recompute).
  const role = claims.role

  // 5. parse documentName for downstream routing. M2: whiteboard keys are now
  //    SERVED here (no longer rejected) — both document and whiteboard kinds
  //    pass; only malformed keys are forbidden.
  let parsed
  try {
    parsed = parseDocumentName(documentName)
  } catch {
    throw forbidden() // 4403
  }

  // 6. reader/commenter: set readOnly so body writes are rejected BEFORE being
  //    applied (v4). A commenter may comment via the REST API but must not edit
  //    the doc body over the collab connection, so it is read-only here too.
  if (role === 'reader' || role === 'commenter') {
    connectionConfig.readOnly = true
  }

  // 7. inject context for downstream hooks (kind-tagged). The trusted display
  //    name (resolved at issuance, §4.7(b)) rides along so beforeHandleAwareness
  //    can stamp the presence frame's user.name; uid stays the identity.
  const base = {
    user: { id: claims.uid, ...(claims.name ? { name: claims.name } : {}) },
    role,
    permission_epoch: claims.permission_epoch,
    // #64: carry the space-membership claim (absent => false) so the write
    // recheck can honor the anyone_in_space scope on already-connected sockets.
    space_member: claims.space_member ?? false,
    space: parsed.space,
    folder: parsed.folder,
  }
  return parsed.kind === 'whiteboard'
    ? { ...base, kind: 'whiteboard', board: parsed.board }
    : { ...base, kind: 'document', doc: parsed.doc }
}
