# Deployment Guide — Octo Docs Backend

Operations-oriented guide for building, configuring, running, and rolling back
the Octo Docs collaborative document backend (`@octo/docs-backend`). For local
development and the application architecture see the top-level
[`README.md`](../README.md); this document covers the production/staging
container lifecycle.

The service is a single process that exposes **two** listeners by default, and
optionally a **third** for the internal service-to-service surface:

| Listener | Default port | Purpose |
| --- | --- | --- |
| Hocuspocus collaborative WS | `1234` (`HOCUSPOCUS_PORT`) | real-time Yjs sync |
| REST metadata API | `3000` (`HTTP_PORT`) | docs CRUD, collab-token, invites, attachments |
| Internal REST API (optional) | `9090` (`INTERNAL_HTTP_PORT`, **off** unless set) | in-network callers only: `/internal/html` (the html service's doc registration) |

> **PPT relay topology for this round is single-replica.** The listeners are
> colocated in one process (`src/index.ts`), and the Bento PPT collaboration relay
> attached to the REST server on `/api/v1/ppt/collab` keeps a process-local room
> registry (live sockets, replay state, per-room sequence and byte-budget state).
> Do not run multiple REST/PPT-relay replicas for the same environment in this
> round. Horizontal REST scaling can be revisited only after the relay has an
> explicit shared transport or affinity design; until then, deploy exactly one
> backend replica for PPT collaboration. The Hocuspocus nodes are stateful and
> documentName-affinity routed. The optional internal listener below is a second
> port of the *same* process, not a separate deployable — it does not change this
> replica count.

### Internal/public surface split (`INTERNAL_HTTP_PORT`)

Leaving `INTERNAL_HTTP_PORT` unset (or `0`) keeps the historical behaviour: the
`HTTP_PORT` listener serves **every** route, exactly as before. Nothing to do for
an existing deployment.

Setting it (`9090` by convention) moves the routes whose **only** caller is
another service inside our own network onto the second listener. Today that is
exactly one prefix — `/internal/html`, which the html service calls with the
shared internal token:

| Route | `HTTP_PORT` (public) | `INTERNAL_HTTP_PORT` (internal) |
| --- | --- | --- |
| `/api/v1/docs/**` (human session token) | ✅ | 404 |
| `/api/v1/ppt/**` (human session token + `X-Space-Id`) | ✅ | 404 |
| signed attachment blob gateway (browser talks to it directly) | ✅ | 404 |
| `/v1/bot/docs/**` (bot token) | ✅ | 404 |
| `/api/v1/card-actions/decide` (HMAC octo-server callback) | ✅ | 404 |
| `/internal/html/**` (shared internal token) | 404 | ✅ |
| `/healthz` | ✅ | ✅ |

The 404s above are per-method for the *protected* methods. CORS runs before the
surface gates, so an `OPTIONS` preflight to an off-surface path still answers
`204` on either port — it reveals nothing and carries no handler, and the real
request that follows still 404s.

**Why only `/internal/html`.** A route may move only when every caller is
provably in-network, because an off-network caller hard-404s the moment the split
is enabled and often cannot be repointed at all:

- `/internal/html` — sole caller is the html service, a sibling container. Safe.
- `/v1/bot/docs/**` — **stays public.** It is published through the public gateway
  today (that is its whole reason for existing: nginx routes `/v1/bot/docs` to
  docs-backend), and its clients are bot-token holders that are not all ours —
  including user-visible `/v1/bot/docs/:docId/export/file` links. `verifyBot`
  remains the authenticator, exactly as today.
- `/api/v1/card-actions/decide` — **stays public.** The caller is octo-server,
  which is not necessarily on our network. The authenticator is the HMAC over the
  raw body plus timestamp freshness plus an idempotency receipt, not network
  position. (The signed canonical covers the **path** only, so changing host/port
  never invalidates a signature — see `src/api/routes/cardActionDecide.ts`.)

So enabling the split needs **no** octo-server change and **no** bot-client
change. If a future service becomes exclusively in-network, move its prefix by
flipping one `servePublic`/`serveInternal` gate in `src/api/app.ts` and updating
the table above.

Rules when it is enabled:

- **Never publish the internal port to the host.** In compose use
  `expose: ["9090"]`, never `ports:` — a published port binds `0.0.0.0` and
  undoes the whole change. `EXPOSE` in the Dockerfile is documentation only.
  Same trap with `network_mode: host`, bare metal, or macvlan: there the bind
  address is the host's, so set `INTERNAL_HTTP_HOST=127.0.0.1`.
- **Never add it to nginx.** The public gateway must keep pointing at `3000`
  only; `9090` may not appear in any `upstream`/`server` block.
- **One caller to repoint, and it needs its own variable.** The html service must
  set a *second*, dedicated variable for the internal endpoint and keep the
  existing one pointed at the public port:

  ```
  DOCS_BACKEND_REGISTER_URL=http://octo-docs-backend:3000/v1/bot/docs
  DOCS_BACKEND_INTERNAL_REGISTER_URL=http://octo-docs-backend:9090/internal/html/register
  ```

  Do **not** simply repoint `DOCS_BACKEND_REGISTER_URL` at `9090`. In
  octo-docs-html that one variable is the base for **three** bot-face calls
  (`POST /v1/bot/docs`, `PATCH`/`DELETE /v1/bot/docs/octo-doc/:slug`) *and* the
  derivation source for the internal endpoint (it strips the `/v1/bot/docs`
  suffix). Moving it to the internal port 404s bot register/rename/delete;
  leaving it alone 404s user-publish registration. The dedicated variable is the
  only configuration that satisfies both. Requires
  Mininglamp-OSS/octo-docs-html#37; with an octo-docs-html build that predates it,
  `INTERNAL_HTTP_PORT` cannot be enabled without breaking one of the two paths.
  Nothing else moves — see the table above.
- **This is not an authentication boundary.** The internal token check stays
  mandatory on the internal port: anything already inside the network (a
  compromised sibling container) can still reach it. The split reduces
  reachability, it does not grant trust.
- Each listener builds its own rate limiters, so the two surfaces no longer share
  one per-IP budget. The internal listener defaults to `trust proxy = false`
  (it is not behind nginx), so an in-network caller cannot spoof
  `X-Forwarded-For` to evade throttling. Note the flip side: with `trust proxy`
  off, all requests from one caller container share a single limiter key, so
  `RATE_LIMIT_MAX` becomes that caller's aggregate budget — check headroom for
  html-registration volume before enabling.
- **Boot fails, loudly, on any port misconfiguration.** `INTERNAL_HTTP_PORT`
  must differ from both `HTTP_PORT` and `HOCUSPOCUS_PORT` (validated before the
  first bind), must be `0` or a real port in `1..65535` (`-9090`, `70000` and
  `nope` abort instead of silently disabling the split), and a bind failure on
  **either** listener exits the process rather than serving a half-split
  container that still answers `/healthz` with `200`.

---

## 1. Image build

The repository ships a single-stage [`Dockerfile`](../Dockerfile) based on
`node:22-alpine`. It runs `npm ci`, compiles TypeScript with `npm run build`
(emitting `dist/`), sets `NODE_ENV=production`, and starts `node dist/index.js`.
It `EXPOSE`s `3000`, `1234` and `9090` (the last one is only bound when
`INTERNAL_HTTP_PORT` is set, and must never be published to the host).

### Build command

```bash
# from the repository root
docker build -t octo-docs-backend:cos-0ce1333 .
```

### `--no-cache` rebuilds

Use `--no-cache` whenever a rebuild must not reuse cached layers — for example
after a base-image security bump, when `npm ci` must re-resolve against an
updated `package-lock.json`, or when you suspect a stale layer is masking a
dependency change:

```bash
docker build --no-cache -t octo-docs-backend:cos-0ce1333 .
```

### Tag convention

**Tag every image with the source commit; never reuse a moving tag.** Reusing a
tag such as `latest` or a branch name silently overwrites the image a running
container was pulled from, so a `--force-recreate` later pulls *different* bytes
than you built and tested. Use an immutable, commit-pinned tag:

```
octo-docs-backend:cos-<short-commit>      # e.g. cos-0ce1333
```

The `cos-` prefix is the convention used in the tsdd environment to mark builds
that carry the custom-domain COS attachment addressing (PR #21). Keep the
previous tag around after deploying a new one — it is your rollback target
(see §7).

### Build args

The `Dockerfile` does not declare any `ARG`s today — all configuration is
supplied at **run** time via environment variables (§3), not baked into the
image. This keeps one image promotable across environments (staging → prod)
without a rebuild. If you later need a build-time pin (e.g. a private registry
mirror for `npm ci`), add an explicit `ARG` to the `Dockerfile` rather than
passing undocumented `--build-arg`s that the build ignores.

---

## 2. Runtime dependencies

| Dependency | Version | Role |
| --- | --- | --- |
| **MySQL** | 8.x | authoritative store (Y.Doc binary + all metadata tables, §3.4) |
| **Redis** | 5+ | pub/sub broadcast bus, permission-epoch cache, connection registry (§5) |
| **Object storage** | MinIO **or** Tencent Cloud COS | attachment blobs via presigned URLs (§3.5) |

Notes:

- MySQL and Redis are **required** for the server to run. The offline unit suite
  mocks them, but a live deployment needs both reachable.
- Object storage is only exercised by the attachment path. With
  `ATTACHMENT_DRIVER=local-hmac` (the default) the backend mints verifiable
  HMAC-signed URLs with no external storage backend — fine for dev/staging.
  Production attachment delivery needs a real S3-compatible backend
  (MinIO or COS), selected with `ATTACHMENT_DRIVER=s3` (see §3.3).
- Exposed ports: **WS `1234`** and **REST `3000`**. Publish both, or front them
  with a gateway that routes WS upgrades to `1234` and REST to `3000`. If you
  enable `INTERNAL_HTTP_PORT`, that port is **in-network only** — do not publish
  it and do not proxy it (see §0).

---

## 3. Environment variables

Configuration is read once at process start through `src/config/env.ts`; nothing
in the codebase reads `process.env` directly. Start from
[`.env.example`](../.env.example) and override per environment. Missing required
vars (those without a fallback) **fail fast at boot** — that is intentional.

### 3.1 Core / secret variables

| Var | Required | Notes |
| --- | --- | --- |
| `HOSTNAME` | no (`octo-docs-local`) | node identity in logs/registry |
| `HOCUSPOCUS_PORT` | no (`1234`) | WS listener |
| `HTTP_PORT` | no (`3000`) | REST listener |
| `INTERNAL_HTTP_PORT` | no (`0` = disabled) | Optional second REST listener serving **only** `/internal/html` (the html service's registration endpoint, whose sole caller is a sibling container); `HTTP_PORT` keeps serving every route that has an out-of-network caller — `/api/v1/docs`, `/api/v1/ppt`, the blob gateway, `/v1/bot/docs` and `/api/v1/card-actions/decide`. Each port 404s the other's routes. `0`/unset = one listener serves everything (unchanged behaviour). When set: `expose` it, never `ports:` it, never put it in nginx. Must be `0` or `1..65535` and must differ from both `HTTP_PORT` and `HOCUSPOCUS_PORT`, or boot fails; a bind failure on either listener exits the process. Reduces attack surface — it is **not** an auth boundary; the internal token check still runs. |
| `INTERNAL_HTTP_HOST` | no (`0.0.0.0`) | Bind address for the internal listener. The default is correct on a compose/k8s bridge network, where an un-published port is only reachable from sibling containers. Set `127.0.0.1` when running with `network_mode: host`, on bare metal, or on macvlan — there `0.0.0.0` makes the internal port host-reachable and the isolation is gone. |
| `TRUST_PROXY` | **recommended behind a proxy** (`1`) | Express `trust proxy` value. The REST API sits behind nginx, so this must be set for `req.ip` — and the per-IP rate limiter — to resolve the real client from `X-Forwarded-For` instead of the proxy address. `1` = one nginx hop; use the hop count for deeper chains, a preset/CIDR like `loopback`, or `false` when exposed directly. Do **not** use `true` in prod (permissive: clients can spoof `X-Forwarded-For`). |
| `CORS_ALLOWED_ORIGINS` | **yes when the FE is a different origin** | Comma-separated allowlist of front-end origins permitted to call the REST API and (with the local-hmac driver pointed at this backend origin) the presigned attachment PUT/GET. The browser preflights cross-origin requests with `OPTIONS` and blocks any response whose `Access-Control-Allow-Origin` does not match, so the FE origin **must** be listed or image upload/download fails (XIN-717). Exact origins (`http://192.168.214.189:3010`) or the single value `*` (reflect any origin). Empty (default) allows no cross-origin request. |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | no (`60000` / `300`) | Per-IP throttle window and cap on the REST route chains (human `/api/v1/docs` + bot `/v1/bot/docs`); `/healthz` is never throttled. Keyed on the real client IP, so `TRUST_PROXY` must be correct for the deployment. |
| `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` | recommended | authoritative store connection |
| `MYSQL_CONNECTION_LIMIT` | no (`10`) | pool size. PPT replay cursors reserve up to `PPT_RELAY_MAX_IN_FLIGHT_REPLAYS` connections while they stream pages; keep this high enough for ordinary REST traffic plus replay headroom. |
| `REDIS_HOST` / `REDIS_PORT` | recommended | broadcast bus / cache / registry |
| `REDIS_PREFIX` | no (`octo-docs`) | multi-product key isolation prefix |
| `COLLAB_TOKEN_SECRET` | **yes in prod** | signing secret for the short-lived collab JWT. Use an asymmetric key / KMS-managed secret; the HS256 default `dev-only-change-me` is dev only. |
| `COLLAB_TOKEN_TTL_SECONDS` | no (`300`) | collab JWT TTL (5 min) |
| `COLLAB_TOKEN_PUBLIC_WS_URL` | **yes in prod** | public, browser-reachable collab WS origin returned to clients as `collabWsUrl` (§4.4). Absolute `ws://`/`wss://` only — the Hocuspocus WS server runs on its own `:1234` origin and is **not** reverse-proxied, so a relative path never reaches it. **Fail-fast prod gate:** if `NODE_ENV=production` and this is unset or malformed the process **refuses to start** (clients no longer carry a build-time WS fallback). Optional in local dev only. |
| `PPT_RELAY_ENABLED` | no (`false`) | **Master on/off switch for the PPT collab relay. Default OFF.** When false the relay is NOT attached to the REST server and the collab-token issuance route is NOT mounted, so `/api/v1/ppt/collab` is entirely absent. The relay currently ships as **Half A** (durable transport + snapshotting + the server-only room-relative clock bound); the op-metadata trust boundary that ties an op's actor to the authenticated uid and enforces per-actor sequence continuity is **deferred to Half B** (paired with the R4-F1 client). While that boundary is absent, an authenticated writer could submit ops under an arbitrary `a`/`s` (actor impersonation) — so **leave this OFF in production until Half B lands.** Accepts `true`/`false`/`1`/`0` only; any other value fails startup. See "PPT relay op-metadata trust model" below. |
| `PPT_RELAY_PUBLIC_WS_URL` | **yes in prod _when the relay is enabled_** | public, browser-reachable origin of the Bento PPT collab relay, returned to clients as `pptWsUrl` in the collab-token response (§7.1). Absolute `ws://`/`wss://` only. The relay is hosted **inside the REST server** on the `/api/v1/ppt/collab` upgrade path (unlike the Hocuspocus WS server), so this normally points at the REST origin. **Fail-fast prod gate — gated behind `PPT_RELAY_ENABLED`:** when the relay is enabled and `NODE_ENV=production`, an unset or malformed value makes the process **refuse to start**. When the relay is **off** (the default) its validation is **skipped entirely** — the value is neither required nor consulted, so a disabled relay never fails startup on this knob (XIN-1825). Optional in local dev. Only consulted when `PPT_RELAY_ENABLED=true`. |
| `PPT_RELAY_SYNC_PV` | no (`2`) | Bento CRDT sync protocol version the relay speaks; a frame whose `pv` differs is refused `protocol-version` before any decode. Keep in step with `ppt_doc_state.bento_sync_pv`. |
| `PPT_RELAY_TICKET_TTL_SECONDS` | no (`30`) | one-time WS handshake ticket TTL. Short by design; the ticket is single-use across relay nodes (Redis-backed store), so a leaked/replayed ticket is useless quickly. |
| `PPT_RELAY_MAX_FRAME_BYTES` / `PPT_RELAY_MAX_OPS_PER_FRAME` | no (`1900000` / `512`) | per-op-frame wire-byte cap and op-count cap (both `too-large`, permanent). |
| `PPT_RELAY_MAX_FRAMES_PER_WINDOW` / `PPT_RELAY_RATE_WINDOW_MS` | no (`200` / `10000`) | sliding-window rate limit on persisted frames (`rate-limited`, a retryable refusal). `PPT_RELAY_MAX_FRAMES_PER_WINDOW` **also** governs the SEPARATE ephemeral-frame window (`hello`/`need`/`p`), so a presence/handshake flood is rate-limited without draining the op budget. |
| `PPT_RELAY_MAX_SINGLE_BLOB_BYTES` | no (`8388608`) | per-snapshot blob cap; larger than the op-frame cap so a legitimate snapshot is not pre-empted by it (`too-large`, permanent). Also the WS `maxPayload`. |
| `PPT_RELAY_MAX_ROOM_FRAME_BYTES` | no (`100663296`) | per-room durable frame-byte budget (`room-full`, permanent). Seeded from durable state on first join, so a restart does not reset it. |
| `PPT_RELAY_MAX_EPHEMERAL_FRAME_BYTES` | no (`65536`) | byte cap for the ephemeral frames (`hello`/`need`/`p`/`bye`), which carry only a small resume cursor or presence payload — far tighter than the op/blob caps (`too-large`, permanent). |
| `PPT_RELAY_MAX_LIVE_BUFFER_FRAMES` / `PPT_RELAY_MAX_LIVE_BUFFER_BYTES` | no (`4096` / `8388608`) | live frames buffered while a connection is replaying. Overflow closes the socket with `4410 resync required`; no overflowing frame is sent and no silent drop occurs. |
| `PPT_RELAY_MAX_IN_FLIGHT_REPLAYS` | no (`max(1,min(2,floor(MYSQL_CONNECTION_LIMIT/4)))`) | process-wide replay cursor semaphore. Must be strictly lower than `MYSQL_CONNECTION_LIMIT`, so replay transactions cannot consume the full MySQL pool. |
| `PPT_RELAY_REPLAY_PAGE_SIZE` / `PPT_RELAY_REPLAY_PAGE_BYTES` | no (`1000` / `4194304`) | max op rows and persisted JSON bytes read per replay page. The relay sends one page and waits for outbound progress before fetching the next page. |
| `PPT_RELAY_SEND_HIGH_WATER_BYTES` | no (`4194304`) | socket `bufferedAmount` (bytes) above which replay pauses before sending its next frame, so one slow/greedy consumer cannot make the relay accumulate an unbounded send backlog. |
| `PPT_RELAY_SEND_DRAIN_TIMEOUT_MS` | no (`5000`) | max wait for a congested socket to drain before the relay closes it instead of enqueueing more frames. |
| `PPT_RELAY_AUTH_REFRESH_MS` | no (`5000`) | jittered per-connection read-auth refresh interval for live relay sockets. |
| `PPT_RELAY_DOC_STATUS_CACHE_TTL_MS` | no (`2000`) | short doc-status cache TTL used to bound repeated status provider calls; local status-changing REST paths must invalidate by publishing the existing epoch/status bump. |
| `PPT_RELAY_REAUTH_GRACE_MS` | no (`10000`) | grace window for a share-derived socket whose ticket membership claim just expired to present a fresh ticket via an in-place `reauth` frame before the relay fails closed. Keep it above `PPT_RELAY_AUTH_REFRESH_MS` so a read-auth refresh fires inside the window without clearing the sticky pending-reauth state. |
| `PPT_RELAY_MAX_INBOUND_QUEUE` | no (`256`) | depth cap for a connection's inbound ordering chain; beyond it further frames are shed `rate-limited`. |
| `PPT_RELAY_MAX_INBOUND_QUEUE_BYTES` | no (`67108864`) | BYTE cap for a connection's inbound ordering chain (XIN-1840 P1-3). The depth cap above bounds only frame COUNT, so a burst of near-`PPT_RELAY_MAX_FRAME_BYTES` frames could retain ~`MAX_INBOUND_QUEUE × MAX_FRAME_BYTES` in-process before the socket drains; beyond EITHER cap the frame is shed `rate-limited`. |
| `PPT_RELAY_MAX_OPS_ADMISSION_PER_WINDOW` | no (`5000`) | coarse per-connection ceiling for ALL `ops` frames per `PPT_RELAY_RATE_WINDOW_MS`, checked BEFORE the identity gate / payload hash / dedup-ledger read (XIN-1840 P1-2), so a reader looping one harvested-valid frameId is O(1)-shed (silently dropped, never `refused`) before paying that work. Sized far above the `PPT_RELAY_MAX_FRAMES_PER_WINDOW` mutation budget and any idempotent resend, so a genuine frame is never shed. |
| `PPT_RELAY_MAX_BUFFERED_OP_LAG` | no (`4096`) | seq-lag cap after which the snapshotter ages out a permanently-buffered op to unfreeze GC. Now operator-tunable: lower it so a room whose average frame is above `PPT_RELAY_MAX_ROOM_FRAME_BYTES / lagCap` bytes forces the reclaim on seq lag before the byte-budget (`room-full`) trigger fires. Each aged-op drop emits the `ppt_relay_aged_op_drop` alert (§6.1). |
| `PPT_RELAY_LEDGER_RETENTION_FRAMES` | no (`262144`) | retention window (room seqs) for the `ppt_collab_frame` dedup ledger. The ledger outlives the pruned op log so a resend after a lost ack re-acks its original seq; without retention it grew forever. Ledger rows are reclaimed only once they fall this many seqs behind the covered watermark, bounding the table to ~this many rows per doc. An idempotent resend happens within seconds — far inside the window — so recent frames are always preserved; a resend older than the window is re-minted and rebroadcast but the reducer drops it as a duplicate (inert). |
| `OCTO_IDENTITY_MODE` | no (`http`) | `http` (cross-service introspection) or `middleware` |
| `OCTO_SERVER_BASE_URL` | when `http` | octo-server base for token→uid lookups |
| `OCTO_SERVER_TOKEN` | no (default empty) — **set it if you want approver names on access cards** | Backend service token for octo-server, used by the server-side calls the backend makes on its own behalf (no user session available): (a) the add-member uid existence check (anti ghost-member) in `members.ts`, and (b) resolving the **approver's display name** for the access-decision result card (`decisionDisplay.ts`). For (a), leaving it empty is fine — that check falls back to the caller's own session token. For (b) there is no caller token (the card-action callback is a signed webhook), so with this unset `GET /v1/users/:uid` answers 401, the name is omitted, and the card renders octo-server's generic reviewer label instead of the real approver's name (the lookup miss is logged). Collaborator name/avatar display elsewhere is unaffected (the frontend fetches those directly with the logged-in user's token). |
| `OCTO_DOCS_HTML_REGISTRATION_TOKEN` | yes for docs-html; empty disables access | Dedicated shared token. It must exactly match the token docs-html sends as `X-Internal-Token` to `POST /internal/html/register`. This rate-limited internal boundary authenticates docs-html, not the end user: docs-html authenticates the user and delegates that identity in `owner`; docs-backend enforces owner/space/slug scoping. Never expose this route to browsers or reuse a browser/session token. |
| `CARD_DISPLAY_TIME_ZONE` | no (`Asia/Shanghai`) | IANA zone used to render timestamps into user-visible card copy (e.g. the access-decision time). Pinned explicitly rather than following the container's `TZ`, which the image does not set (compose defaults it to UTC) — otherwise zh-CN card copy would show a time hours off. **Validated at startup:** an unrecognised zone (`Asia/Shangai`, `UTC+8`, …) fails the process at boot rather than throwing later on the decision path. |
| `MAX_DOC_BYTES` | no (`10485760`) | single-doc Yjs state hard cap (~10MB) |

> **⚠️ The `MYSQL_PASSWORD` / 504 trap.** When promoting config from a
> known-good container, **dump the full environment of that container and edit
> the values into your stored env file as a block** — do not hand-retype a
> subset. A deployment that boots without `MYSQL_PASSWORD` (or with a stale one)
> connects to a MySQL that rejects it; the REST API then hangs on the first
> query and the gateway returns **504**. The fix is always to restore the
> complete, correct env, not to retry the request. Treat every secret
> (`MYSQL_PASSWORD`, `COLLAB_TOKEN_SECRET`, the attachment keys below) as part
> of one atomic env block, never passed piecemeal.

### 3.2 Attachment storage — two modes

The presign driver is selected by `ATTACHMENT_DRIVER`:

- **`local-hmac` (default, dev/staging).** Mints real, TTL-bounded HMAC-signed
  URLs using Node's built-in crypto — no cloud credentials, no SDK. The signing
  key is `ATTACHMENT_SIGNING_SECRET` (dev fallback `dev-only-change-me`).
- **`s3` / `minio` (production object storage).** Signs real AWS SigV4 presigned
  URLs against an S3-compatible endpoint (MinIO or Tencent COS) behind the same
  interface.

> **⚠️ `ATTACHMENT_SIGNING_SECRET` is a fail-fast prod gate for *every* driver.**
> `requireSafeSigningSecret` runs **unconditionally at config load**
> (`src/config/env.ts`), independent of `ATTACHMENT_DRIVER`. If
> `NODE_ENV=production` and `ATTACHMENT_SIGNING_SECRET` is still the dev default
> `dev-only-change-me`, the process **refuses to start** — and this fires even
> under `s3`/`minio`, where the HMAC secret is never actually used to sign URLs.
> So in production you must set a non-default `ATTACHMENT_SIGNING_SECRET`
> regardless of which driver you run; it is not a `local-hmac`-only concern.

Shared attachment vars:

| Var | Default | Notes |
| --- | --- | --- |
| `ATTACHMENT_DRIVER` | `local-hmac` | `local-hmac` \| `s3` \| `minio` |
| `ATTACHMENT_BUCKET` | `octo-docs-attachments` | target bucket |
| `ATTACHMENT_KEY_PREFIX` | _(empty)_ | object-key prefix so several apps share one bucket without colliding (e.g. a COS bucket shared with octo-server). Part of the signed key. |
| `ATTACHMENT_LOCAL_DIR` | _(empty → `<os.tmpdir()>/octo-docs-attachments`)_ | filesystem directory the self-hosted **local-hmac blob gateway** stores/serves uploaded bytes from (XIN-717). Used only when `ATTACHMENT_DRIVER=local-hmac` **and** `ATTACHMENT_PUBLIC_BASE_URL` points at this backend origin — then the browser PUTs/GETs the binary directly here and this process persists it. Ignored by the `s3`/`minio` drivers (they upload straight to object storage). Dev / single-node self-hosted only. |
| `ATTACHMENT_SIGNING_SECRET` | `dev-only-change-me` | HMAC key for `local-hmac`; **must** be overridden in prod |
| `ATTACHMENT_UPLOAD_URL_TTL_SECONDS` | `300` | presigned PUT TTL |
| `ATTACHMENT_READ_URL_TTL_SECONDS` | `600` | re-issued signed GET TTL |
| `ATTACHMENT_MAX_RESOLVE_BATCH` | `200` | hard cap on the batch resolve endpoint |
| `ATTACHMENT_MAX_IMAGE_SIZE_BYTES` | `10485760` | image tier hard cap (10MB) |
| `ATTACHMENT_MAX_FILE_SIZE_BYTES` | `52428800` | file tier hard cap (50MB) |
| `ATTACHMENT_ALLOWED_MIME_PREFIXES` | see `.env.example` | allow list; trailing `/` = prefix match |
| `ATTACHMENT_BLOCKED_MIMES` | see `.env.example` | denylist (wins over allow list); blocks SVG/HTML/script/executables |

S3/MinIO/COS-only vars (used when `ATTACHMENT_DRIVER=s3|minio`):

| Var | Default | Notes |
| --- | --- | --- |
| `ATTACHMENT_S3_ENDPOINT` | `http://localhost:9000` | **public, browser-reachable** origin baked into the signed URL host — never a docker-internal alias |
| `ATTACHMENT_S3_REGION` | `us-east-1` | SigV4 region |
| `ATTACHMENT_S3_ACCESS_KEY` | _(empty)_ | supply at runtime; never commit |
| `ATTACHMENT_S3_SECRET_KEY` | _(empty)_ | supply at runtime; never commit |
| `ATTACHMENT_S3_FORCE_PATH_STYLE` | `true` | addressing mode — see §3.3 |
| `ATTACHMENT_S3_SIGNING_HOST` | _(empty)_ | SigV4 `host` override for the public/browser path — see §3.3 |
| `ATTACHMENT_S3_INTERNAL_ENDPOINT` | _(empty)_ | container-network origin for **server-side** PUT/GET/DELETE (DOCX import, Excalidraw import, SVG upload, copy, markdown ingest, delete). See §3.4 |

### 3.3 Tencent Cloud COS via a custom CDN domain — the three switches

This is the configuration introduced by PR #21 and is the one most likely to be
mis-set. When attachments are served through a **Tencent COS custom/CDN domain**
that origin-pulls to the bucket, three switches must agree:

```bash
ATTACHMENT_DRIVER=s3
# 1. Custom-domain addressing: the host is already bound to the bucket, so the
#    URL is <endpoint>/<key> and the SigV4 canonicalUri DROPS the bucket segment.
ATTACHMENT_S3_FORCE_PATH_STYLE=false
# 2. The public endpoint the browser hits — your CDN / custom domain.
ATTACHMENT_S3_ENDPOINT=https://<cdn-custom-domain>
# 3. The host COS actually validates the signature against — the bucket ORIGIN.
ATTACHMENT_S3_SIGNING_HOST=<bucket>.cos.<region>.myqcloud.com

ATTACHMENT_S3_REGION=<region>          # e.g. ap-guangzhou
ATTACHMENT_BUCKET=<bucket>             # e.g. mybucket-1250000000
ATTACHMENT_KEY_PREFIX=<prefix>         # optional, if sharing the bucket
ATTACHMENT_S3_ACCESS_KEY=<SecretId>
ATTACHMENT_S3_SECRET_KEY=<SecretKey>
```

**Why all three are needed.** The browser hits the CDN custom domain
(`ATTACHMENT_S3_ENDPOINT`). The CDN origin-pulls to COS and **rewrites the
`Host` header to the bucket origin** (`<bucket>.cos.<region>.myqcloud.com`). COS
then validates the SigV4 signature **against that origin host**, not against the
custom domain the URL points at. So we sign `ATTACHMENT_S3_SIGNING_HOST` (the
origin) while the URL still points at the custom domain, and we set
`ATTACHMENT_S3_FORCE_PATH_STYLE=false` so the canonicalUri omits the bucket
(the host already resolves to it) — otherwise COS computes a different
canonicalUri and the signature mismatches.

**Diagnosing it from the error:**

- **`403 SignatureDoesNotMatch`** → the signed host / addressing is wrong. The
  three switches above are not aligned (commonly `SIGNING_HOST` unset, or
  `FORCE_PATH_STYLE` still `true`). The request never authenticated.
- **`404 NoSuchKey`** → **the signature verified.** COS authenticated the
  request and only then found no object at that key. This is the *expected*
  response for a not-yet-uploaded key and confirms the three switches are
  correct — it is a key/lifecycle issue, not a signing issue.

Treat the 403→404 transition as the signal that COS signing is configured
correctly.

### 3.4 Container deployments — setting `ATTACHMENT_S3_INTERNAL_ENDPOINT`

When the backend runs inside a container (docker, k8s) and
`ATTACHMENT_S3_ENDPOINT` points at a host-only reverse proxy (e.g.
`http://127.0.0.1:28090` — an nginx bound to the docker-host loopback that
forwards to MinIO), that address is **unreachable from inside the backend
container** (127.0.0.1 inside the container is the container itself). All
server-side attachment operations (DOCX embedded images, Excalidraw import,
SVG inline upload, copy/relocate, markdown image ingest, delete) would
otherwise fail with `ECONNREFUSED` at TCP connect time. Browser uploads are
unaffected because the browser runs on the host.

Set `ATTACHMENT_S3_INTERNAL_ENDPOINT` to the **in-cluster / container-network
address** of your object store so server-side operations stay on the
container network:

```bash
# Public endpoint (browser-facing, signed into presign URLs):
ATTACHMENT_S3_ENDPOINT=http://127.0.0.1:28090
# Internal endpoint (server-side direct SigV4 PUT/GET/DELETE, container DNS):
ATTACHMENT_S3_INTERNAL_ENDPOINT=http://minio:9000
```

For the **COS-behind-CDN** configuration described in §3.3, leave
`ATTACHMENT_S3_INTERNAL_ENDPOINT` **unset only if** the CDN is reachable from
the server; otherwise set it to the COS bucket origin directly so that
server-side requests bypass the CDN and its Host rewrite:

```bash
ATTACHMENT_S3_ENDPOINT=https://<cdn-custom-domain>
ATTACHMENT_S3_SIGNING_HOST=<bucket>.cos.<region>.myqcloud.com
# Server-side requests go straight to COS, avoiding the CDN Host-rewrite path:
ATTACHMENT_S3_INTERNAL_ENDPOINT=https://<bucket>.cos.<region>.myqcloud.com
```

When `ATTACHMENT_S3_INTERNAL_ENDPOINT` is empty (default) all operations fall
back to `ATTACHMENT_S3_ENDPOINT`, which is correct for single-network/dev
deployments where both browser and server share the same network.

---

## 4. Database migrations

There are two paths; choose by whether the database already exists.

### Fresh install

Apply the full schema once. `migrations/schema.sql` holds the complete
`CREATE TABLE` DDLs from the frozen contract (§3.4):

```bash
mysql -u <user> -p <database> < migrations/schema.sql
```

`schema.sql` is a **fresh-install-only** script. Its ten `CREATE TABLE`
statements are bare — none use `IF NOT EXISTS` — so **re-running it against a
database that already holds these tables fails immediately**: MySQL aborts on
the very first `CREATE TABLE` with error **1050 (`Table '...' already exists`)**.
It does not gracefully skip the tables that are already there. On an existing
database, never re-run `schema.sql`; apply the incremental
`migrations/upgrades/` files (below) instead.

### Existing deployment

Build the project, then run the migration ledger runner:

```bash
npm run build
npm run migrate
```

`npm run migrate` applies `migrations/upgrades/*.sql` in filename (date) order,
records `(filename, checksum, executed_at)` in `schema_migrations`, skips files
already applied with the same checksum, and fails fast if an already-applied SQL
file has been modified. It also takes a MySQL advisory lock so two deploy jobs
do not run migrations concurrently.

When adopting this runner on a database that was previously migrated manually,
the first run has an empty `schema_migrations` ledger. It will therefore execute
the existing upgrade files once to populate the ledger. The shipped upgrades are
written to be idempotent/re-runnable for that exact bootstrap path.

**Authoring new upgrade files — they MUST be idempotent.** The runner applies a
file and records it in the ledger as two separate steps; MySQL auto-commits DDL,
so they cannot be one atomic transaction. If a deploy dies between them, or on
the bootstrap re-run above, the file is executed again. Every upgrade file must
therefore be safely re-runnable: guard DDL with `information_schema` checks or
`IF NOT EXISTS`, and gate DML on a predicate a re-run no longer matches (a bare
`INSERT ... SELECT` or unguarded `ALTER` will corrupt or error on the second
run). The shipped files under `migrations/upgrades/` are the reference pattern.

> Run migrations as a discrete deploy step **before** rolling the new image, so
> the running (old) code tolerates the additive schema and the new code finds
> the columns it expects. In Kubernetes/ArgoCD/Helm, run the same command from a
> Job / PreSync hook / release hook. Adding new upgrade files? Keep the
> `YYYY-MM-DD-<desc>.sql` naming so date order = apply order.

Manual SQL execution remains a low-level fallback for break-glass operations:

```bash
mysql -u <user> -p <database> < migrations/upgrades/2026-06-23-add-doc-attachment-file-name.sql
```

---

## 5. Orchestration (docker compose)

A minimal compose fragment for the backend plus its dependencies. The backend
reads its config from a deploy-managed `env_file` (the atomic env block from
§3.1 — never inline secrets here):

```yaml
services:
  octo-docs-backend:
    image: octo-docs-backend:cos-0ce1333
    env_file: ./octo-docs-backend.env
    ports:
      - "3000:3000"   # REST (public surface, behind nginx)
      - "1234:1234"   # Hocuspocus WS
    # Internal s2s surface (only when INTERNAL_HTTP_PORT=9090 is in the env file).
    # `expose` publishes NOTHING to the host: it is reachable only from sibling
    # containers on this network, as http://octo-docs-backend:9090. Moving this
    # line into `ports:` would bind 0.0.0.0 and defeat the split — as would
    # `network_mode: host` (there, set INTERNAL_HTTP_HOST=127.0.0.1).
    expose:
      - "9090"
    depends_on:
      - mysql
      - redis
    restart: unless-stopped

  mysql:
    image: mysql:8
    environment:
      MYSQL_DATABASE: octo_docs
      MYSQL_USER: octo_docs
      MYSQL_PASSWORD: ${MYSQL_PASSWORD}
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD}
    volumes:
      - mysql-data:/var/lib/mysql

  redis:
    image: redis:7-alpine
    restart: unless-stopped

volumes:
  mysql-data:
```

### Recreating only this service

In a shared stack (e.g. one that also runs `octo-server`) you almost never want
to recreate the whole stack. Rebuild/redeploy **only** the docs backend and
leave its dependencies and sibling services untouched:

```bash
docker compose up -d --no-deps --force-recreate octo-docs-backend
```

- `--no-deps` — do not touch `mysql` / `redis` / `octo-server`; only this
  service is recreated.
- `--force-recreate` — recreate the container even if compose thinks the spec is
  unchanged (this is how a new immutable image tag, or an edited `env_file`,
  actually takes effect).

If COS-related env changed, you typically only need to recreate this one
service; nothing else in the stack reads those variables.

---

## 6. Health checks

After `--force-recreate`, verify the service is genuinely up — not just that the
container is running:

| Check | Expected | Meaning |
| --- | --- | --- |
| `GET /healthz` | **`200`** `{"ok":true}` | REST process is serving (no-auth liveness) |
| `GET /api/v1/docs` (no token) | **`401`** `{"error":"unauthorized"}` | auth middleware is wired — a 401 here is **healthy**, not an error |
| Startup logs | `Hocuspocus listening on :1234` **and** `REST API listening on :3000` | both listeners came up |
| Startup logs (only with `INTERNAL_HTTP_PORT` set) | `Internal API listening on 0.0.0.0:9090` | the internal surface came up. This line cannot be missing while the process serves: a bind failure on either listener now exits the process, so absence means the container is not running (check for `refusing to serve` in the logs) |
| Startup/runtime logs | **0** `ACCESS_DENIED` / no MySQL auth failures | DB credentials are correct (see the 504 trap, §3.1) |

```bash
# liveness
curl -fsS http://localhost:3000/healthz
# auth wired (401 is the success condition here)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/v1/docs   # -> 401
```

With `INTERNAL_HTTP_PORT=9090` enabled, also verify the split actually holds —
run these from **inside** a sibling container (the internal port is not reachable
from the host by design):

```bash
# the html registration surface moved off the public port
curl -s -o /dev/null -w '%{http_code}\n' http://octo-docs-backend:3000/internal/html/register \
  -X POST -H 'content-type: application/json' -H 'x-internal-token: wrong' -d '{}'   # -> 404
# and answers on the internal one (401 = the token guard ran, i.e. mounted + still guarded)
curl -s -o /dev/null -w '%{http_code}\n' http://octo-docs-backend:9090/internal/html/register \
  -X POST -H 'content-type: application/json' -H 'x-internal-token: wrong' -d '{}'   # -> 401
# the human surface is NOT on the internal port
curl -s -o /dev/null -w '%{http_code}\n' http://octo-docs-backend:9090/api/v1/docs  # -> 404
# the bot surface and the card-action callback did NOT move: still on the public port
curl -s -o /dev/null -w '%{http_code}\n' http://octo-docs-backend:3000/v1/bot/docs  # -> 401
curl -s -o /dev/null -w '%{http_code}\n' http://octo-docs-backend:3000/api/v1/card-actions/decide \
  -X POST -H 'content-type: application/json' -d '{}'                               # -> 401
```

The `401`-vs-`404` distinction is the whole assertion: `401` means the route is
mounted **and** its guard ran; `404` means the route is not mounted on that
listener at all.

From the host, `curl http://localhost:9090/healthz` must **fail to connect** — if
it answers, the port was published and the isolation is gone.

A `200` on `/healthz` together with a `401` on `/api/v1/docs` and both
"listening" log lines is the green state. A REST endpoint hanging (no response →
gateway 504) points back to the MySQL credential trap in §3.1.

### 6.1 PPT relay — operator obligation: aged-op drop alert (XIN-1807 P1-2)

The server-side snapshotter may, to unfreeze GC, drop a permanently-buffered op whose
cross-actor dependency never became durable. This is bounded and strictly better than
bricking the room, but the dropped op **may still exist on live peers**, so the drop is a
potential server↔peer divergence with no other in-band signal. Production emits a
structured **`console.error`** line carrying the stable event tag `ppt_relay_aged_op_drop`
plus the dropped `(actor, s)` pairs.

**You MUST wire a log-based alert on `ppt_relay_aged_op_drop`.** It should fire rarely or
never in a healthy deployment; each occurrence is a data-integrity event to investigate.
The logged `dropped` array (each `{a, s}`) is the record for reconciliation — capture it
from your log pipeline. Example line:

```
[ppt-relay] aged-op drop (data-integrity divergence risk; alert + reconcile) {"event":"ppt_relay_aged_op_drop","docId":"…","targetSeq":42,"bufferedLag":5000,"lagCap":4096,"droppedCount":1,"dropped":[{"a":"…","s":7}]}
```

### 6.2 PPT relay — op-metadata trust model (Half A / Half B split, XIN-1821)

The PPT collab relay currently ships as **Half A**: durable transport, the dedup ledger,
seq counter, replay, backpressure, room byte limits, the server-side snapshotter, the
materialization proof, and the aged-op escalation above. **The relay is disabled by
default (`PPT_RELAY_ENABLED=false`) and must stay off in production until Half B lands.**

What Half A **does** enforce on op metadata (no client half required):

- **Wire shape / charset.** Each op's actor `a` is charset-restricted (`[a-z0-9-]{1,64}`)
  and the reserved reducer namespace (`@…`) is refused, and node ids / `set` keys naming ANY
  `Object.prototype` member (`__proto__`/`constructor`/`prototype` **and** `valueOf`/
  `toString`/`hasOwnProperty`/… — XIN-1840 P0-1) or a DocShape container (`slides`/`elements`)
  are rejected, `del`/`ord` ids are shape-checked per `kind` (bare slide id vs composite
  element key), and a `txt` op is limited to one insert group — so a wire op can neither mint
  the reducer actor nor crash/pollute/silently-drop-through the reduction.
- **Room-relative clock bound.** An op's `l` (and a `txt` op's seed generation `sd[0]`) is
  refused when it exceeds the room's live Lamport clock by more than a generous slack, so a
  single wire-legal value cannot pin the clock at a ceiling and permanently refuse every
  legitimate successor.
- **Snapshot column guard.** A snapshot whose serialized `doc_json`/`state_json` would
  exceed the 16 MiB `MEDIUMTEXT` ceiling fails closed **before** the write, so the op log is
  never pruned behind a truncated document. If you see this, the deck's materialized state
  has outgrown the column and needs a schema/segmentation change — it is a hard capacity
  limit, surfaced to the client as a permanent `room-full`.

What Half A **does NOT** enforce (deferred to **Half B**, paired with the R4-F1 client):

- **Actor↔uid binding.** An op's `a` is NOT tied to the authenticated uid, so an
  authenticated writer could author under another collaborator's actor (impersonation /
  co-editor censorship). This needs the client to send a `clientSessionId` so the server can
  mint and bind the actor.
- **Per-actor `s` continuity.** A non-contiguous per-actor sequence is not refused at the
  boundary (it can still park a buffered op that the aged-op path in §6.1 eventually drops).

Because those two gates are absent, **the relay must not be exposed in production yet.**
`PPT_RELAY_ENABLED=false` keeps `/api/v1/ppt/collab` unmounted and the collab-token route
absent, so no ticket is issued and the endpoint cannot be reached. Turn it on only once
Half B binds the actor to the authenticated identity.

### 6.3 PPT relay — quarantined frame is a manual-intervention event (XIN-1835 P0-1 / XIN-1840)

The wire validator is the primary guard against a frame the reducer cannot apply, but the
snapshotter has a defense-in-depth backstop: if a frame still **throws** inside
`engine.apply`, it is **quarantined** — the snapshotter freezes the proven watermark at the
last clean boundary strictly below it and NEVER prunes the poison frame or anything after
it, so the room degrades to **read-only from that seq** rather than bricking. Production
logs it as `[ppt-relay] doc <id>: quarantined a throwing frame at seq <n>` (watermark frozen,
frame not pruned).

**A quarantined frame is a manual-intervention event, not self-healing.** The room stops
advancing its snapshot and its op log grows unpruned until an operator acts; a validator that
accepts a frame the reducer rejects is a bug to fix at the wire, not a runtime condition the
relay recovers from on its own. On seeing this log line: capture the offending `(docId, seq)`
and the frame, treat it as a validator/reducer accept-set escape (the class the wire-grammar
fuzz gate in `test/pptOpValidationFuzz.test.ts` is meant to prevent), and file it for a wire
fix. An automated operator escape hatch (e.g. surgically dropping the quarantined frame) is
out of scope this round.

---

## 7. Rollback

Rollback is fast because images are commit-tagged (§1) and config is an atomic
env block (§3.1). Two things must be reversible: the **image** and the **env**.

1. **Keep the previous image.** Never prune the prior `cos-<commit>` tag until
   the new one has soaked. To roll back, point the compose `image:` back at the
   previous tag and recreate only this service:

   ```bash
   docker compose up -d --no-deps --force-recreate octo-docs-backend
   ```

2. **Back up compose + env before every change** with a timestamped `.bak` so a
   bad edit is a one-command restore:

   ```bash
   cp docker-compose.yml docker-compose.yml.bak.$(date +%Y%m%d-%H%M%S)
   cp octo-docs-backend.env octo-docs-backend.env.bak.$(date +%Y%m%d-%H%M%S)
   ```

   To roll back config, copy the last-good `.bak` back over the live file and
   `--force-recreate` the service.

3. **Migrations.** The shipped upgrades are additive and idempotent, so rolling
   the image back generally needs no DB rollback (old code ignores the new
   column). Only author a down-migration when a future change is destructive;
   never assume a schema rollback is automatic.

After any rollback, re-run the §6 health checks before declaring the service
recovered.
