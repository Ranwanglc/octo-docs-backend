/**
 * PPT bootstrap payload assembly (R3-B1, XIN-1495 §3.3 / §8 / §9).
 *
 * The `format=bootstrap` source response is the payload the frontend hands to
 * the same-origin Bento editor/viewer container via an ORIGIN-CHECKED
 * `postMessage` (§3.3). It carries:
 *   · the bento/slides deck to hydrate,
 *   · the Bento compatibility triple (format / FORMAT_VERSION / SYNC_V),
 *   · SHORT-LIVED SIGNED asset GET URLs — never a long-lived token in the URL
 *     (§9 / PPT-SEC-001 / PPT-ASSET-001),
 *   · the exact `targetOrigin` the parent must postMessage into (never `*`), and
 *   · `collab: false` — preview/editor/present in this round must NOT request a
 *     Hocuspocus/relay token (§3.3, out-of-scope R4).
 *
 * Signing reuses the existing object-store presigner (`getObjectStore`), which
 * mints TTL-bounded HMAC (local-hmac) or SigV4 (s3/minio) GET URLs — the same
 * short-lived authorized-render pattern C uses for assets. No new signing key or
 * URL scheme is introduced here.
 */
import { config } from '../config/env.js'
import { getObjectStore } from '../storage/objectStore.js'
import type { Role } from '../permission/role.js'
import {
  PPT_BENTO_COMPAT,
  type PptAssetRef,
  type PptSourceContent,
  type PptSourceMode,
} from './source.js'

/** One signed asset entry in a bootstrap payload. */
export interface PptSignedAsset {
  /** Stable id the deck references the asset by. */
  id: string
  /** SHA-256 content address / object key of the blob (diagnostic; NOT a secret). */
  sha: string
  /** Registered mime the signed GET is bound to serve with. */
  mime: string
  /** Short-lived signed GET URL — expires at `expiresAt`; carries no bearer token. */
  url: string
  /** ISO-8601 expiry of `url`, so the client can pre-empt a refresh. */
  expiresAt: string
  /** Blob size in bytes, when known. */
  sizeBytes?: number
}

/** The `data` payload of a `format=bootstrap` source response. */
export interface PptBootstrapPayload {
  docId: string
  documentName: string
  /** Which source this is (published/live/draft) — echoed so the client can label it. */
  mode: PptSourceMode
  format: 'bootstrap'
  /** The caller's effective role on this doc (drives client-side edit affordances). */
  role: Role
  /** Whether this source is editable by the caller (writer/admin on draft/live). */
  editable: boolean
  /** Immutable published version sequence, or null for draft/live. */
  versionSeq: number | null
  /** Source revision (draft_revision or version_seq). */
  revision: number
  /** Stable content hash of the deck (the comment-anchor basis). */
  contentHash: string
  /** Bento compatibility triple the runtime validates before hydrating. */
  bento: typeof PPT_BENTO_COMPAT
  /** The bento/slides deck to hydrate. */
  deck: PptSourceContent['deck']
  /** Signed, short-lived asset GET URLs the deck's media resolves through. */
  assets: PptSignedAsset[]
  /** TTL (seconds) the asset URLs were signed for — the client refreshes before it. */
  assetUrlTtlSeconds: number
  /**
   * The EXACT origin the parent MUST use as the `postMessage` targetOrigin when
   * transferring this payload into the Bento container — never `*`. Empty only
   * when no origin could be resolved (misconfiguration); the client must then
   * fall back to its own `window.location.origin`, never `*`.
   */
  targetOrigin: string
  /**
   * Collaboration is OFF for preview/editor/present source in this round: the
   * frontend must not request a Hocuspocus/relay token (§3.3). R4 flips this on
   * through a separate collab-token endpoint, not the source route.
   */
  collab: false
}

/**
 * Sign one asset ref into a short-lived GET URL. `nowSec` is injectable so the
 * expiry stamp is deterministic in tests. The URL is bound to serve the
 * registered mime (`responseContentType`) so a stored blob can never be replayed
 * as an attacker-chosen content type (stored-XSS defence, XIN-726 parity).
 */
export function signPptAsset(
  ref: PptAssetRef,
  ttlSeconds: number,
  nowSec: () => number = () => Math.floor(Date.now() / 1000),
): PptSignedAsset {
  const url = getObjectStore().presignGet(ref.objectKey, ttlSeconds, {
    responseContentType: ref.mime,
  })
  const expiresAt = new Date((nowSec() + ttlSeconds) * 1000).toISOString()
  return {
    id: ref.id,
    sha: ref.objectKey,
    mime: ref.mime,
    url,
    expiresAt,
    ...(ref.sizeBytes !== undefined ? { sizeBytes: ref.sizeBytes } : {}),
  }
}

export interface BuildBootstrapInput {
  docId: string
  documentName: string
  mode: PptSourceMode
  role: Role
  editable: boolean
  content: PptSourceContent
  targetOrigin: string
  /** Injectable clock for deterministic asset-expiry stamps in tests. */
  nowSec?: () => number
}

/**
 * Assemble the full bootstrap payload from resolved source content: sign every
 * asset with the configured short-lived TTL, attach the compatibility triple and
 * the origin-checked target origin, and pin `collab: false`.
 */
export function buildPptBootstrap(input: BuildBootstrapInput): PptBootstrapPayload {
  const ttl = config.ppt.assetUrlTtlSeconds
  const assets = input.content.assets.map((ref) => signPptAsset(ref, ttl, input.nowSec))
  return {
    docId: input.docId,
    documentName: input.documentName,
    mode: input.mode,
    format: 'bootstrap',
    role: input.role,
    editable: input.editable,
    versionSeq: input.content.versionSeq ?? null,
    revision: input.content.revision,
    contentHash: input.content.contentHash,
    bento: PPT_BENTO_COMPAT,
    deck: input.content.deck,
    assets,
    assetUrlTtlSeconds: ttl,
    targetOrigin: input.targetOrigin,
    collab: false,
  }
}
