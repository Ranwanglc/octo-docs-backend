/**
 * Centralized environment configuration (§2.1 / §3.4 / §4.4 / §4.7 / §9.5).
 *
 * All process.env access is funneled through here so the rest of the codebase
 * reads a typed, validated config object.
 */

function str(name: string, fallback?: string): string {
  const v = process.env[name]
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback
    throw new Error(`Missing required env var: ${name}`)
  }
  return v
}

function num(name: string, fallback: number): number {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be a number, got: ${v}`)
  return n
}

function numMin(name: string, fallback: number, min: number): number {
  const n = num(name, fallback)
  return Math.max(min, n)
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  return v === '1' || v.toLowerCase() === 'true'
}

/**
 * Strict boolean env parser. Unlike bool(), this rejects anything that is not
 * exactly true|false|1|0 (case-insensitive, trimmed) rather than treating every
 * unrecognized value as false. Use this for flags whose SAFE value is `true`
 * (e.g. TLS cert verification), where bool()'s "unknown => false" fallback would
 * silently flip the flag to its UNSAFE side on an operator typo (=treu, =yes,
 * =on, =TRUE␣). Mirrors num(), which already throws on a non-number.
 */
function strictBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const v = raw.trim().toLowerCase()
  if (v === 'true' || v === '1') return true
  if (v === 'false' || v === '0') return false
  throw new Error(`Env var ${name} must be one of true|false|1|0, got: ${raw}`)
}

/**
 * Parse the comma-separated `CORS_ALLOWED_ORIGINS` allowlist into trimmed,
 * non-empty entries (XIN-717). Lives here (not in api/cors.ts) so the config
 * module stays the single leaf that reads env, with no import cycle back from
 * api/cors.ts. The single value `*` (reflect any origin) is preserved verbatim.
 */
export function parseAllowedOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o !== '')
}

export type OctoIdentityMode = 'http' | 'middleware'

/**
 * Parse the Express `trust proxy` setting from env (§8.4). The REST API runs
 * behind nginx (see app.ts), so `req.ip` must be derived from the
 * X-Forwarded-For chain, not the socket peer — otherwise every client collapses
 * to the proxy address and the per-IP rate limiter shares one bucket across all
 * traffic. Accepted forms:
 *   - unset / '' -> 1 (trust exactly one proxy hop: the standard single-nginx
 *     topology this service documents)
 *   - 'true' / 'false' -> boolean (avoid 'true' in prod: it is permissive and
 *     lets clients spoof X-Forwarded-For)
 *   - an integer -> number of trusted hops in front of the app
 *   - anything else -> passed through verbatim (a preset like 'loopback' or a
 *     subnet/CIDR list Express understands)
 */
export function parseTrustProxy(raw: string): boolean | number | string {
  const v = raw.trim()
  if (v === '') return 1
  if (v.toLowerCase() === 'true') return true
  if (v.toLowerCase() === 'false') return false
  if (/^\d+$/.test(v)) return Number(v)
  return v
}

/** Dev-only fallback secret; must never reach production (see requireSafeSigningSecret). */
const DEV_SIGNING_SECRET = 'dev-only-change-me'

/**
 * Fail-fast guard: in production the attachment signing secret must be a real
 * override, never the dev default. Returning the secret keeps the typed-config
 * pattern (call site stays a single expression) while throwing at config load
 * if prod is misconfigured. NODE_ENV is read here so the rest of the codebase
 * still never touches process.env directly.
 */
export function requireSafeSigningSecret(secret: string): string {
  if (secret === DEV_SIGNING_SECRET && process.env.NODE_ENV === 'production') {
    throw new Error(
      'ATTACHMENT_SIGNING_SECRET must be overridden in production (refusing to run with the dev default)',
    )
  }
  return secret
}

/**
 * Resolve the public, browser-reachable collab WS URL that collab-token responses
 * hand back as `collabWsUrl` (§4.4). The Hocuspocus WS server lives on its own
 * origin (default :1234) with nginx NOT reverse-proxying it, so this MUST be an
 * absolute `ws://`/`wss://` URL — a relative path would resolve against the REST
 * API origin and never reach the WS port.
 *
 * Production fail-fast (mirrors requireSafeSigningSecret's production-gated
 * contract): the compat window is over — the frontend has dropped its build-time
 * WS fallback, so an unset or malformed value leaves clients with no way to reach
 * the collab WS and no one would notice. In production (`NODE_ENV=production`)
 * that config is fatal: the process refuses to start with a clear error. Outside
 * production the value stays soft (warn, normalise to '') so local dev and the
 * test suite still boot without the var. Returns '' to mean "omit the field";
 * callers must not emit an empty or malformed URL.
 */
export function resolveCollabPublicWsUrl(raw: string): string {
  const value = raw.trim()
  if (value === '') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'COLLAB_TOKEN_PUBLIC_WS_URL must be set in production (refusing to run: clients cannot reach the collab WS without it)',
      )
    }
    // eslint-disable-next-line no-console
    console.warn(
      '[config] COLLAB_TOKEN_PUBLIC_WS_URL is not set; collab-token responses will omit collabWsUrl. ' +
        'This is fatal in production — set an absolute ws:// or wss:// URL there.',
    )
    return ''
  }
  if (!/^wss?:\/\//i.test(value)) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        `COLLAB_TOKEN_PUBLIC_WS_URL must be an absolute ws:// or wss:// URL, got: ${value} (refusing to run)`,
      )
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[config] COLLAB_TOKEN_PUBLIC_WS_URL must be an absolute ws:// or wss:// URL, got: ${value}. ` +
        'Ignoring it; collabWsUrl will be omitted. This is fatal in production.',
    )
    return ''
  }
  return value
}

/**
 * Validate the card display timezone at config load.
 *
 * `Intl.DateTimeFormat` throws `RangeError` for anything that is not a
 * recognised IANA zone (`Asia/Shangai`, `UTC+8`, a trailing space …). Card
 * timestamps are rendered on the access-decision callback path, so an unvalidated
 * typo would surface as a permanent 503 loop *after* the grant has committed —
 * the receipt never finalizes, the cards never terminalize, and the same typo
 * silently kills the notification paths that swallow their errors. A cosmetic
 * field must not be able to wedge a functional path, so fail loudly at boot
 * instead (same convention as the signing-secret / collab-WS guards above).
 */
export function resolveCardDisplayTimeZone(raw: string): string {
  const value = raw.trim()
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value })
  } catch {
    throw new Error(
      `CARD_DISPLAY_TIME_ZONE must be a valid IANA time zone (e.g. Asia/Shanghai, UTC), got: ${JSON.stringify(raw)} (refusing to run)`,
    )
  }
  return value
}

export const config = {
  hostname: str('HOSTNAME', 'octo-docs-local'),
  hocuspocusPort: num('HOCUSPOCUS_PORT', 1234),
  httpPort: num('HTTP_PORT', 3000),

  // Express `trust proxy` value. The REST API sits behind nginx, so this must be
  // set for req.ip (and thus the per-IP rate limiter) to see the real client
  // rather than the proxy. Defaults to 1 (one nginx hop); see parseTrustProxy.
  trustProxy: parseTrustProxy(str('TRUST_PROXY', '')),

  mysql: {
    host: str('MYSQL_HOST', '127.0.0.1'),
    port: num('MYSQL_PORT', 3306),
    user: str('MYSQL_USER', 'octo_docs'),
    password: str('MYSQL_PASSWORD', 'octo_docs'),
    database: str('MYSQL_DATABASE', 'octo_docs'),
    connectionLimit: num('MYSQL_CONNECTION_LIMIT', 10),
  },

  redis: {
    host: str('REDIS_HOST', '127.0.0.1'),
    port: num('REDIS_PORT', 6379),
    prefix: str('REDIS_PREFIX', 'octo-docs'),
  },

  // Full-text search (P4). OpenSearch holds the doc/sheet/board body index
  // (`octo-doc`, written by the independent octo-doc-indexer); the backend only
  // READS it. MySQL computes the visibility constraint (private doc_id set +
  // isSpaceMember), which is pushed down into the OS query as a filter so OS
  // returns only hits the caller may see and paginates them. No permissions live
  // in OS. Disabled by default (gray release): with SEARCH_ENABLED=false the POST
  // /docs/search route returns 503 and never connects to OpenSearch.
  search: {
    // Master switch. false => POST /docs/search returns 503 (search unavailable).
    enabled: bool('SEARCH_ENABLED', false),
    // OpenSearch node URL(s). Accepts a single URL or a comma-separated list for
    // a multi-node cluster (the SDK round-robins across them and fails over on
    // per-request errors). Same cluster the indexer writes to.
    opensearchNode: str('OPENSEARCH_NODE', 'http://127.0.0.1:9200'),
    // Index the indexer writes doc bodies to.
    opensearchIndex: str('OPENSEARCH_INDEX', 'octo-doc'),
    // Optional basic-auth credentials. Empty (default) => no auth header.
    opensearchUsername: str('OPENSEARCH_USERNAME', ''),
    opensearchPassword: str('OPENSEARCH_PASSWORD', ''),
    // TLS escape hatch for an https node with an untrusted (e.g. self-signed)
    // cert. Default true = verify against the system trust store (self-signed is
    // rejected). Set to false ONLY for a trusted internal https endpoint you
    // can't otherwise validate; ignored for http nodes.
    opensearchTlsRejectUnauthorized: strictBool('OPENSEARCH_TLS_REJECT_UNAUTHORIZED', true),
    // Upper bound a caller's pageSize is clamped to. Must be >= 1: numMin rejects
    // 0/negative/fractional/Infinity (SEARCH_PAGE_SIZE_MAX=0 would make every
    // search return an empty page while total reports a positive count).
    pageSizeMax: numMin('SEARCH_PAGE_SIZE_MAX', 50, 1),
    // Upper bound on the size of the visibleDocIds set pushed down as an OS
    // `terms doc_id` filter. Guards against exceeding OpenSearch's
    // `index.max_terms_count` (default 65536): an oversized terms clause is
    // rejected by OS with an opaque error, so we bound it here and return a
    // deterministic 503 instead. Keep this <= the index's configured
    // max_terms_count. Must be >= 1: numMin rejects 0/negative (0 would trip
    // VisibleTermsTooLargeError on every non-empty set → search 503s permanently).
    maxVisibleTerms: numMin('SEARCH_MAX_VISIBLE_TERMS', 65536, 1),
    // --- Producer side: the afterStoreDocument hook sends a tiny
    // {documentName,kind,ts} signal to a Kafka topic (config.kafka.topic) for a
    // separate indexer (consumer group) to consume. Default OFF (gray release):
    // while disabled the hook is inert, so nothing is produced before a consumer
    // exists.
    indexEnabled: bool('SEARCH_INDEX_ENABLED', false),
  },

  // Kafka producer for the search doc-index signal channel (see
  // search/docIndexQueue.ts). Only the doc-index producer uses Kafka; the
  // consumer/retry/DLQ topics live in the separate octo-doc-indexer service.
  kafka: {
    // Comma-separated broker list (host:port,host:port). Default is a single
    // local broker; set per environment at deploy time.
    brokers: str('KAFKA_BROKERS', '127.0.0.1:9092')
      .split(',')
      .map((b) => b.trim())
      .filter((b) => b !== ''),
    // Topic the doc-index signal is produced to. MUST match the indexer's
    // DOCINDEX_KAFKA_TOPIC. Change only in lockstep with the indexer deployment.
    topic: str('DOCINDEX_KAFKA_TOPIC', 'octo.docindex.v1'),
    // Produce ack level: 1 = leader ack (default, best-effort side channel), 0 =
    // fire-and-forget, -1 = all in-sync replicas. Kept low since the signal is
    // best-effort and the consumer re-reads authoritative data by key anyway.
    acks: num('KAFKA_ACKS', 1),
  },

  // Per-IP request throttle applied to the REST route chains (§8.4). Guards the
  // authenticated/authorizing metadata endpoints on both the human (/api/v1/docs)
  // and bot (/v1/bot/docs) mounts against abuse. Keyed on the real client IP,
  // which requires `trustProxy` above to be set correctly for the deployment.
  // Defaults are generous enough not to affect normal interactive/bot usage;
  // tune down only if abuse is observed. The /healthz probe is mounted ahead of
  // the limiter and stays unthrottled.
  rateLimit: {
    // Rolling window length.
    windowMs: num('RATE_LIMIT_WINDOW_MS', 60_000),
    // Max requests per IP per window before a 429 is returned.
    max: num('RATE_LIMIT_MAX', 300),
  },

  collabToken: {
    secret: str('COLLAB_TOKEN_SECRET', 'dev-only-change-me'),
    ttlSeconds: num('COLLAB_TOKEN_TTL_SECONDS', 300),
    // Public, browser-reachable collab WS origin surfaced to clients as
    // `collabWsUrl` in the collab-token response (§4.4). Absolute ws://|wss://
    // only (WS runs on its own :1234 origin, not reverse-proxied). REQUIRED in
    // production: unset/malformed is fatal (fail-fast, refuses to start). Soft
    // (warn => omit) outside production only — see resolveCollabPublicWsUrl.
    publicWsUrl: resolveCollabPublicWsUrl(str('COLLAB_TOKEN_PUBLIC_WS_URL', '')),
  },

  // Cross-Origin Resource Sharing (XIN-717). The front-end runs on its own
  // origin and calls the REST API — and, with the local-hmac driver pointed at
  // the docs-backend origin, the presigned attachment PUT/GET — cross-origin, so
  // the browser preflights with OPTIONS and blocks any response without a
  // matching Access-Control-Allow-Origin. Configure the allowed FE origin(s)
  // here (comma-separated exact origins, e.g. `http://192.168.214.189:3010`, or
  // the single value `*` to reflect any origin). Empty (default) allows no
  // cross-origin request — set it per environment at deploy time. See src/api/cors.ts.
  cors: {
    allowedOrigins: parseAllowedOrigins(str('CORS_ALLOWED_ORIGINS', '')),
  },

  // Public, browser-facing octo-web origin used to mint absolute doc share
  // links (the `shareUrl` field on doc lifecycle responses). A caller — a bot
  // via octo-cli, the OpenClaw octo plugin, or any integration — can pass this
  // URL straight through to chat instead of hand-assembling a link (which
  // produced broken links). The minted URL mirrors octo-web's authoritative
  // buildDocLink: `<webOrigin>/d/<docId>?sp=<spaceId>`. Set it to the origin the
  // end-user browser loads octo-web from, e.g. `http://192.168.214.189:3010`.
  // Empty (default) safely degrades: shareUrl becomes an origin-relative,
  // path-only `/d/<docId>?sp=<spaceId>` rather than baking in a wrong host.
  // See src/util/docShareLink.ts.
  webOrigin: str('OCTO_WEB_ORIGIN', ''),

  octoIdentity: {
    mode: str('OCTO_IDENTITY_MODE', 'http') as OctoIdentityMode,
    serverBaseUrl: str('OCTO_SERVER_BASE_URL', 'http://127.0.0.1:8080'),
    // Service token sent as the `token` header on octo-server lookups (e.g.
    // GET /v1/users/:uid, which requires auth) on the HUMAN path. Empty = not
    // configured; callers then fall back to the authenticated user's own session
    // token. OPTIONAL for the human path (/api/v1/docs). No longer required for
    // the bot path (/v1/bot/docs): the bot resolves the target user with its own
    // bearer token via GET /v1/bot/user/info (see octoIdentity.getUserAsBot), so
    // the anti ghost-member existence check in members/forwardGrant works with
    // OCTO_SERVER_TOKEN empty.
    serviceToken: str('OCTO_SERVER_TOKEN', ''),
    // Space-membership check cache TTL (#64). isSpaceMember(uid, spaceId, token)
    // is resolved server-side by reusing POST /v1/auth/verify?include=context
    // (the caller's own session token -> its server-validated `spaces` list) only
    // for anyone_in_space docs; results are coalesced + cached per {uid, spaceId}
    // for this many seconds to bound the extra octo-server QPS on hot shared
    // docs while keeping membership-grant latency low. A membership REVOCATION
    // is not epoch-bounded on the live socket (design §5.3 case 3); this cache
    // only affects fresh REST/issuance checks. Default 30 s.
    membershipCacheTtlSeconds: num('SPACE_MEMBERSHIP_CACHE_TTL_SECONDS', 30),
  },

  // Outbound IM notification via octo-server's internal notify API (docs-notify
  // producer, octo-server PR #584 / docs-notify-contract.md). When a doc event
  // fires (currently: an access request is submitted) we POST a structured
  // `docs_card` to octo-server, which server-templates an octo/v1 card and
  // delivers it as a DM from the shared notification bot. This is the ONLY
  // outbound IM path docs-backend has; it augments — never replaces — the
  // pull-based pending list. See api/services/docsNotify.ts.
  notify: {
    // Docs-specific ingress token for POST /v1/internal/notify (docs_card). Sent
    // as `X-Internal-Token`; must equal octo-server's `OCTO_DOCS_NOTIFY_TOKEN`
    // (which is required to DIFFER from NOTIFY_INTERNAL_TOKEN). Empty here =
    // outbound docs notifications disabled (best-effort no-op). Never logged.
    docsToken: str('OCTO_DOCS_NOTIFY_TOKEN', ''),
    // `service` label echoed on every notify request (octo-server logs/metrics).
    service: str('NOTIFY_SERVICE_NAME', 'docs-service'),
    // HMAC-SHA256 secret (≥32 bytes) octo-server signs card-action callbacks
    // with; must equal the route's `secret_env` value in OCTO_CARD_ACTION_ROUTES.
    // Empty = the decide endpoint rejects all callbacks (fail-closed). Never logged.
    cardActionSecret: str('OCTO_DOCS_CARD_ACTION_SECRET', ''),
  },

  // IANA zone used to render user-visible card timestamps. Card copy is zh-CN
  // while the container image sets no TZ (the deployment compose defaults it to
  // UTC), so formatting in the process-local zone would render decision times
  // hours off. Pinning it here keeps card output deployment-independent and lets
  // tests assert a fixed literal. VALIDATED at load: an invalid zone would make
  // Intl.DateTimeFormat throw on the decision path, so it must fail at boot.
  cardDisplayTimeZone: resolveCardDisplayTimeZone(str('CARD_DISPLAY_TIME_ZONE', 'Asia/Shanghai')),

  attachments: {
    bucket: str('ATTACHMENT_BUCKET', 'octo-docs-attachments'),
    // Object-storage presign driver (§3.5). 'local-hmac' mints real, verifiable
    // HMAC-signed URLs with Node's built-in crypto (no cloud creds/SDK needed);
    // 's3'/'minio' signs real AWS SigV4 presigned URLs against an S3-compatible
    // endpoint, behind the same ObjectStore interface.
    driver: str('ATTACHMENT_DRIVER', 'local-hmac'),
    // Optional object-key prefix prepended to every put/get key before signing,
    // so multiple apps can share one bucket without colliding (e.g. Tencent COS
    // shared with octo-server). Empty (default) keeps keys unprefixed — no
    // change for existing MinIO/local-hmac deployments. Leading/trailing slashes
    // are normalised; the prefix is part of the signed key (see objectStore.ts).
    keyPrefix: str('ATTACHMENT_KEY_PREFIX', ''),
    // Public, browser-reachable base URL the 'local-hmac' driver bakes into the
    // signed PUT/GET URL host (§3.5). The front-end issues the presigned PUT (and
    // later GET) directly, so this host MUST resolve from the end-user browser.
    // The historical default baked a fixed `https://<bucket>.object-store.local`
    // origin into every signed URL — an internal placeholder alias the browser
    // cannot resolve (ERR_NAME_NOT_RESOLVED), so the direct PUT never lands and
    // collaborators see no image (XIN-713). Set this to a host the browser can
    // actually reach — e.g. the docs-backend origin that fronts object storage
    // (`http://<host>:<httpPort>`), or a real object-store endpoint — and the
    // signed URL becomes `<publicBaseUrl>/<key>?X-...`. An optional path segment
    // (e.g. `.../attachments`) is supported and stripped before signature
    // verification, so the signed key stays the pure object key. Empty (default)
    // preserves the legacy object-store.local host for back-compat.
    publicBaseUrl: str('ATTACHMENT_PUBLIC_BASE_URL', ''),
    // Filesystem directory the self-hosted local-hmac blob gateway stores and
    // serves uploaded bytes from (XIN-717). Only used when driver is
    // 'local-hmac' AND publicBaseUrl points at this backend origin — then the
    // browser PUTs/GETs the binary directly here and the gateway persists it
    // under this directory. Empty (default) falls back to
    // `<os.tmpdir()>/octo-docs-attachments`. Not used by the s3/minio drivers
    // (those upload straight to object storage).
    localDir: str('ATTACHMENT_LOCAL_DIR', ''),
    // S3-compatible (MinIO/S3/COS) driver settings. Used only when driver is
    // 's3'/'minio'. The endpoint is the PUBLIC, browser-reachable origin baked
    // into the signed URL host (never a docker-internal alias). Credentials come
    // from env — never hardcoded/logged.
    s3: {
      endpoint: str('ATTACHMENT_S3_ENDPOINT', 'http://localhost:9000'),
      region: str('ATTACHMENT_S3_REGION', 'us-east-1'),
      accessKeyId: str('ATTACHMENT_S3_ACCESS_KEY', ''),
      secretAccessKey: str('ATTACHMENT_S3_SECRET_KEY', ''),
      // Path-style (`<endpoint>/<bucket>/<key>`, canonicalUri carries the bucket)
      // is the default and what MinIO needs. Set false for virtual-hosted /
      // custom-domain addressing where the host is already bound to the bucket
      // (e.g. a Tencent COS CDN domain): the URL becomes `<endpoint>/<key>` and
      // the canonicalUri drops the bucket segment so SigV4 verifies COS-side.
      forcePathStyle: bool('ATTACHMENT_S3_FORCE_PATH_STYLE', true),
      // Host used in the signed SigV4 `host` header, when it must differ from
      // the public endpoint host. A Tencent COS CDN/custom domain (the endpoint
      // the browser hits) origin-pulls to COS with the Host rewritten to the
      // bucket origin (`<bucket>.cos.<region>.myqcloud.com`), and COS validates
      // the signature against THAT host — so we sign the origin host while the
      // URL still points at the custom domain. Empty (default) signs the
      // endpoint host itself, which is correct for MinIO/S3 and COS accessed
      // directly on its origin endpoint.
      signingHost: str('ATTACHMENT_S3_SIGNING_HOST', ''),
      // Internal (container-network) endpoint for server-side PUT/DELETE/GET.
      // In containerised deployments the public browser-reachable endpoint
      // (e.g. http://127.0.0.1:28090) is not reachable from inside the
      // backend container; set this to the in-cluster S3/MinIO address
      // (e.g. http://minio:9000) so server-side media operations stay on
      // the container network. Browser-facing presignPut/presignGet URLs
      // always use the public endpoint above. Empty (default) falls back
      // to the public endpoint for all operations (single-network/dev).
      internalEndpoint: str('ATTACHMENT_S3_INTERNAL_ENDPOINT', ''),
    },
    // Secret keying the HMAC signature over (objectKey + expiry). Dev fallback;
    // MUST be overridden in production (enforced via requireSafeSigningSecret).
    signingSecret: requireSafeSigningSecret(str('ATTACHMENT_SIGNING_SECRET', DEV_SIGNING_SECRET)),
    // TTL for presigned PUT (upload) URLs.
    uploadUrlTtlSeconds: num('ATTACHMENT_UPLOAD_URL_TTL_SECONDS', 300),
    // TTL for re-issued signed GET (read) URLs (§3.5 step 5).
    readUrlTtlSeconds: num('ATTACHMENT_READ_URL_TTL_SECONDS', 600),
    // Hard cap on the batch resolve endpoint (§3.3 RES-1). A reader can request
    // a fresh signed URL for every attachId in one call; the cap bounds the
    // presign abuse surface. Over-cap requests are rejected, never truncated.
    maxResolveBatch: num('ATTACHMENT_MAX_RESOLVE_BATCH', 200),
    // Size caps are tiered by MIME (§3.5). The tier is chosen by the backend
    // from the 'image/' prefix — never trusted from the client — and both tiers
    // hard-cap. The split exists because images render inline (kept small for
    // collab/load), while pdf/office/zip files are routinely larger.
    maxImageSizeBytes: num('ATTACHMENT_MAX_IMAGE_SIZE_BYTES', 10 * 1024 * 1024),
    maxFileSizeBytes: num('ATTACHMENT_MAX_FILE_SIZE_BYTES', 50 * 1024 * 1024),
    // Comma-separated allowed MIME list. An entry ending in '/' is a PREFIX
    // match (e.g. 'image/' matches image/png); an entry without a trailing
    // slash is an EXACT match (e.g. 'text/plain' must equal the base mime, so
    // forged 'text/plaintext' is rejected — see attachments.ts:mimeAllowed).
    allowedMimePrefixes: str(
      'ATTACHMENT_ALLOWED_MIME_PREFIXES',
      [
        'image/',
        'application/pdf',
        'text/plain',
        'application/zip',
        'application/x-zip-compressed',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ].join(','),
    ),
    // Comma-separated MIME denylist that takes precedence over the allowed list.
    // SVG is accepted only by the dedicated sanitize-and-upload endpoint. It
    // remains blocked from the generic direct-to-storage presign path because
    // that path cannot inspect active XML before it is persisted. The rest are
    // HTML/script/executable types that must never be served inline (§3.5).
    blockedMimes: str(
      'ATTACHMENT_BLOCKED_MIMES',
      [
        'image/svg+xml',
        'text/html',
        'application/xhtml+xml',
        'application/x-msdownload',
        'application/x-msdos-program',
        'application/x-executable',
        'application/vnd.microsoft.portable-executable',
        'application/x-sh',
        'application/x-csh',
        'text/javascript',
        'application/javascript',
        'application/x-httpd-php',
        'application/java-archive',
      ].join(','),
    ),
  },

  // §3.5 (⑰) link-card OG fetch. All outbound fetching is SSRF-guarded; these
  // bound the request (timeout/size) and the result cache. UA is fixed so target
  // sites can identify the bot.
  og: {
    fetchTimeoutMs: num('OG_FETCH_TIMEOUT_MS', 5000),
    maxResponseBytes: num('OG_MAX_RESPONSE_BYTES', 512 * 1024),
    maxRedirects: num('OG_MAX_REDIRECTS', 3),
    userAgent: str('OG_USER_AGENT', 'octo-docs-linkcard/1.0 (+bot)'),
    // Comma-separated port allowlist; anything else is treated as ssrf_blocked.
    allowedPorts: str('OG_ALLOWED_PORTS', '80,443'),
    cacheSuccessTtlSeconds: num('OG_CACHE_SUCCESS_TTL_SECONDS', 24 * 60 * 60),
    cacheFailureTtlSeconds: num('OG_CACHE_FAILURE_TTL_SECONDS', 300),
  },

  // §9.5 single-document Yjs state hard cap.
  maxDocBytes: num('MAX_DOC_BYTES', 10 * 1024 * 1024),

  // Bot incremental doc-body edit request-shape bounds (PATCH /:docId/content).
  // These fail fast at the route shape gate, BEFORE the no-lock op resolution +
  // PMNode.fromJSON + Y.Doc hydration in editDocBody, so an oversized batch is
  // rejected without spending that CPU/memory. The global express.json 1mb cap
  // and the post-apply maxDocBytes gate remain; these close the gap in between.
  docBodyEdit: {
    // Upper bound on ops per PATCH batch. Well above any realistic single edit
    // (a document restructure touches a handful of blocks), low enough that a
    // scripted bot cannot fan out unbounded resolution work under the 1mb cap.
    maxOps: num('DOC_BODY_EDIT_MAX_OPS', 500),
    // Upper bound on a single op's serialized `content` payload. Keeps one op
    // from carrying most of the 1mb body as nodes that must each be parsed.
    maxOpContentBytes: num('DOC_BODY_EDIT_MAX_OP_CONTENT_BYTES', 256 * 1024),
    // Upper bound on a block-path length. Real ProseMirror nesting (doc > list >
    // listItem > paragraph > ...) stays in single digits; 32 is generous while
    // capping the per-index descent work resolveBlockPath does per anchor.
    maxPathDepth: num('DOC_BODY_EDIT_MAX_PATH_DEPTH', 32),
  },

  // Bot/human sheet content read (GET /:docId/sheet). maxCellBytes bounds a
  // single response body: the whole-sheet read returns 413 sheet_too_large above
  // it, and — since Stage3 — it also caps each page of a paginated read, so no
  // one page can exceed it either. Paginated reads (query ?limit= / ?cursor=)
  // lift the whole-sheet 413 wall for opted-in callers by slicing an oversized
  // grid into byte-bounded pages; a caller passing neither param keeps the exact
  // Stage1 whole-sheet behavior (backward compatible). The live Y.Doc is already
  // capped at maxDocBytes, so every decode + measure below is bounded.
  sheetRead: {
    maxCellBytes: num('SHEET_READ_MAX_CELL_BYTES', 1024 * 1024),
    // Cells per page when a caller opts into pagination without an explicit
    // ?limit. The byte cap above is the hard bound; this is the count default.
    defaultPageLimit: num('SHEET_READ_DEFAULT_PAGE_LIMIT', 1000),
    // Upper bound a caller's ?limit is clamped to, so a large limit can never
    // force an unbounded per-page slice (the byte cap still governs regardless).
    maxPageLimit: num('SHEET_READ_MAX_PAGE_LIMIT', 10000),
  },

  // Bot/human sheet content write (PATCH /:docId/sheet). Request-shape bounds
  // that fail fast at the route gate, BEFORE the no-lock batch validation and
  // the live write, so an oversized cell batch is rejected without spending that
  // work. Mirrors docBodyEdit's bounds for the flat-cell write surface; the
  // global express.json 1mb cap and the post-write maxDocBytes gate remain.
  sheetWrite: {
    // Upper bound on cells per PATCH batch (set + delete combined). Well above a
    // realistic single edit, low enough that a scripted client cannot fan out
    // unbounded validate/set work under the 1mb body cap.
    maxCells: num('SHEET_WRITE_MAX_CELLS', 5000),
    // Upper bound on a single cell's serialized {v,f,s} payload — keeps one cell
    // (chiefly its opaque style object) from carrying most of the 1mb body.
    maxCellContentBytes: num('SHEET_WRITE_MAX_CELL_CONTENT_BYTES', 64 * 1024),
  },

  // Bot board-scene write (PATCH /:docId/scene). Request-shape bounds that fail
  // fast at the route gate, BEFORE the no-lock batch validation and the live
  // write, so an oversized element batch is rejected without spending that work.
  // Mirrors docBodyEdit / sheetWrite for the whiteboard element surface; the
  // global express.json 1mb cap and the post-write maxDocBytes gate remain.
  boardSceneWrite: {
    // Upper bound on the number of scene ops per PATCH batch — upsert elements +
    // deleted ids + file entries combined. Well above a realistic single edit,
    // low enough that a scripted client cannot fan out unbounded validate/apply
    // work under the 1mb body cap.
    maxElements: num('BOARD_SCENE_WRITE_MAX_ELEMENTS', 5000),
    // Upper bound on a single element's / file ref's serialized payload — keeps
    // one element (chiefly a freedraw `points` array) from carrying most of the
    // 1mb body as a single object that must be normalized.
    maxElementContentBytes: num('BOARD_SCENE_WRITE_MAX_ELEMENT_CONTENT_BYTES', 128 * 1024),
  },

  // Typst-based PDF export. The document's persisted state is rendered to Typst
  // source (renderTypst.ts) and compiled to PDF by spawning the standalone
  // `typst` binary (typstService.ts). No resident process; each compile is a
  // short-lived sandboxed child. These bounds cap concurrency, queueing, compile
  // time and per-image download size.
  typstExport: {
    // Path to the `typst` binary; empty => resolved from PATH.
    binaryPath: str('TYPST_EXPORT_BINARY', ''),
    // Directory of embedded OSS CJK fonts (Noto Sans/Serif CJK SC == Source Han
    // Sans/Serif, SIL OFL) passed to typst as `--font-path`. Empty => typst uses
    // only its system font book. Set it so CJK faces the document maps to are
    // found deterministically regardless of the host's installed fonts; typst
    // subset-embeds just the used glyphs into the PDF. The Dockerfile points
    // this at the image's font dir.
    fontPath: str('TYPST_EXPORT_FONT_PATH', ''),
    // Max concurrent typst compiles; the rest queue.
    maxConcurrent: num('TYPST_EXPORT_MAX_CONCURRENT', 2),
    // Max compiles allowed to WAIT; over this the route returns 503.
    maxQueue: num('TYPST_EXPORT_MAX_QUEUE', 10),
    // Hard per-compile timeout; on expiry the child process is killed.
    compileTimeoutMs: num('TYPST_EXPORT_COMPILE_TIMEOUT_MS', 20_000),
    // Max image bytes downloaded per attachment for embedding (DoS bound).
    maxImageBytes: num('TYPST_EXPORT_MAX_IMAGE_BYTES', 10 * 1024 * 1024),
    // Max number of images embedded in one export (count bound). Prevents a doc
    // with many image attachments from forcing count x maxImageBytes downloads.
    maxImageCount: num('TYPST_EXPORT_MAX_IMAGE_COUNT', 50),
    // Aggregate byte budget across all embedded images in one export. Once the
    // running total would exceed this, remaining images are dropped.
    maxImageTotalBytes: num('TYPST_EXPORT_MAX_IMAGE_TOTAL_BYTES', 50 * 1024 * 1024),
    // Per-formula fallback bound: after a whole-document compile failure the
    // route probes individual formulas (one `typst` compile each) to isolate
    // the broken one. Cap how many formulas may be probed and the total wall
    // clock spent probing, so a doc with thousands of formulas can't hold a
    // scarce compile slot indefinitely. When the budget is spent the route
    // skips straight to the whole-document verbatim fallback.
    maxFormulaProbes: num('TYPST_EXPORT_MAX_FORMULA_PROBES', 40),
    formulaProbeBudgetMs: num('TYPST_EXPORT_FORMULA_PROBE_BUDGET_MS', 15_000),
  },

  // W3 server-side whiteboard image export. The decoded Excalidraw scene is
  // serialized to SVG in-process (whiteboard/exportScene.ts) and, for PNG,
  // rasterized with @napi-rs/canvas (Skia; prebuilt musl binary, no browser, no
  // resident process). Embedded image elements have their bytes pre-downloaded
  // (size-bounded, best-effort) like the Typst path and composited onto the PNG
  // canvas directly. These bounds cap the work one export can force.
  boardExport: {
    // Max image bytes downloaded per image element for embedding (DoS bound).
    maxImageBytes: num('BOARD_EXPORT_MAX_IMAGE_BYTES', 10 * 1024 * 1024),
    // Max number of image elements whose bytes are embedded in one export.
    maxImageCount: num('BOARD_EXPORT_MAX_IMAGE_COUNT', 50),
    // Aggregate byte budget across all embedded images in one export.
    maxImageTotalBytes: num('BOARD_EXPORT_MAX_IMAGE_TOTAL_BYTES', 50 * 1024 * 1024),
    // Target raster width (px) for PNG output; the SVG is scaled to fit this.
    // 0 => render at the scene's natural pixel size.
    pngWidth: num('BOARD_EXPORT_PNG_WIDTH', 2000),
    // Max SVG canvas dimension (px, each axis). The scene bounding box is
    // attacker-controlled, so clamp the emitted width/height to keep a
    // pathological/overflowing scene from producing a giant (or Infinity) canvas.
    maxSvgDimension: num('BOARD_EXPORT_MAX_SVG_DIMENSION', 12_000),
    // Max PNG output pixel area (width*height). Bounds the rasterized bitmap so a
    // single reader GET cannot force a multi-GB allocation (OOM); oversize scenes
    // are downscaled uniformly to fit. ~40M px ≈ 160MB RGBA peak.
    maxPngPixels: num('BOARD_EXPORT_MAX_PNG_PIXELS', 40_000_000),
    // Max DECODED pixel area (width*height) of a source image element before the
    // PNG compositor decodes it. maxImageBytes caps only the *compressed* source,
    // so a highly compressed bomb (e.g. 30000x30000 PNG < 10MB) would decode to a
    // multi-GB bitmap and OOM the process on loadImage. The intrinsic size is read
    // from the header before decoding; an oversize source degrades to a
    // placeholder (best-effort). ~40M px ≈ 160MB RGBA peak per image.
    maxSourceImagePixels: num('BOARD_EXPORT_MAX_SOURCE_IMAGE_PIXELS', 40_000_000),
    // Concurrency gate for the PNG raster path (CPU/memory-heavy, synchronous
    // Skia compositing). At most maxConcurrent PNG rasters run at once; up to
    // maxQueue more wait, and further requests get 503 export_busy — so a burst
    // of `?format=png` GETs can't saturate CPU/RAM and cascade into an OOM.
    maxConcurrentPngExports: num('BOARD_EXPORT_MAX_CONCURRENT_PNG', 4),
    maxQueuedPngExports: num('BOARD_EXPORT_MAX_QUEUED_PNG', 16),
  },

  // docx-import untrusted-zip extraction limits. The extractor walks the zip
  // WITHOUT touching the filesystem (entries stay in memory) and enforces these
  // ceilings before any XML/media is handed downstream.
  docxImport: {
    // Max size of the uploaded .docx itself (compressed). Over this the route
    // rejects before reading a byte of zip content.
    maxUploadBytes: numMin('DOCX_IMPORT_MAX_UPLOAD_BYTES', 25 * 1024 * 1024, 1),
    // Max TOTAL uncompressed bytes across all entries. The primary zip-bomb
    // ceiling (a 1MB zip can inflate to gigabytes). Sum is tracked as entries
    // inflate; the extractor aborts the instant this is crossed.
    maxTotalUncompressedBytes: numMin('DOCX_IMPORT_MAX_TOTAL_UNCOMPRESSED_BYTES', 200 * 1024 * 1024, 1),
    // Max uncompressed bytes for any SINGLE entry (word/document.xml can be big;
    // this stops one crafted member from exhausting memory on its own).
    maxEntryUncompressedBytes: numMin('DOCX_IMPORT_MAX_ENTRY_UNCOMPRESSED_BYTES', 100 * 1024 * 1024, 1),
    // Max per-entry compression ratio (uncompressed/compressed). A ratio far
    // above what real DEFLATE achieves on office XML flags a zip bomb early,
    // before the absolute size ceilings are even reached.
    maxCompressionRatio: numMin('DOCX_IMPORT_MAX_COMPRESSION_RATIO', 200, 1),
    // Max number of entries in the archive (defends the entry-count DoS where a
    // zip packs millions of tiny members).
    maxEntries: numMin('DOCX_IMPORT_MAX_ENTRIES', 4096, 1),
    // Max number of embedded media files (word/media/*) we will accept + upload.
    maxMediaFiles: numMin('DOCX_IMPORT_MAX_MEDIA_FILES', 256, 0),
    // Hard wall-clock ceiling for the WHOLE extract+parse. zip bombs and
    // pathological XML burn CPU/time, not just bytes; on expiry the import is
    // aborted regardless of how much has been read.
    timeoutMs: numMin('DOCX_IMPORT_TIMEOUT_MS', 30_000, 1_000),
    // Max concurrent imports (each holds an inflated document in memory); the
    // rest queue. Mirrors the pdfExport back-pressure discipline.
    maxConcurrent: numMin('DOCX_IMPORT_MAX_CONCURRENT', 2, 1),
    // Max imports allowed to WAIT in the queue; over this the route returns 503.
    maxQueue: numMin('DOCX_IMPORT_MAX_QUEUE', 10, 1),
  },

  // §5.7 A4 auto-save version history. Backend-autonomous KIND_AUTO snapshots
  // triggered off the Hocuspocus store path (idle timer + min-interval fallback
  // + unload flush). Shipped behind a default-OFF gate (gray release); when
  // disabled the hooks are inert. Thresholds are env-injectable for load tuning.
  autoSnapshot: {
    // Master switch (§5.7). false => no auto snapshots, hooks do nothing.
    enabled: bool('AUTO_SNAPSHOT_ENABLED', false),
    // "stopped typing" idle window before a clean restore point is taken, and
    // the idle dedup-lock TTL.
    idleMs: num('AUTO_IDLE_MS', 15_000),
    // minimum spacing between two auto snapshots = min-interval dedup-lock TTL,
    // the fallback so continuous editing still snapshots periodically.
    minIntervalMs: num('AUTO_MIN_INTERVAL_MS', 60_000),
    // retention: keep at most the most-recent N auto rows per doc.
    retainCount: num('AUTO_RETAIN_COUNT', 50),
    // retention: drop auto rows older than this many days.
    retainDays: num('AUTO_RETAIN_DAYS', 7),
  },

  // FEAT-B recent-view retention. doc_view_history rows are pruned synchronously
  // (piggyback) inside the same transaction as each ingest UPSERT, per uid, so a
  // returned ingest leaves the window already trimmed (deterministic for tests).
  // Pruning is capacity maintenance ONLY — query-time visibility filtering
  // (status=1 + permission predicate) is what makes revoked/deleted docs vanish;
  // correctness never depends on pruning. Test envs can lower these to build a
  // prune scenario without inserting hundreds of rows.
  docView: {
    // retention: keep at most the most-recent N view rows per user (0 = unbounded).
    retainCount: num('DOC_VIEW_RETAIN_COUNT', 200),
    // retention: drop view rows older than this many days (0 = unbounded).
    retainDays: num('DOC_VIEW_RETAIN_DAYS', 90),
  },
} as const
