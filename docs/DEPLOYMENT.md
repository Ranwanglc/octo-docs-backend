# Deployment Guide — Octo Docs Backend

Operations-oriented guide for building, configuring, running, and rolling back
the Octo Docs collaborative document backend (`@octo/docs-backend`). For local
development and the application architecture see the top-level
[`README.md`](../README.md); this document covers the production/staging
container lifecycle.

The service is a single process that exposes **two** listeners:

| Listener | Default port | Purpose |
| --- | --- | --- |
| Hocuspocus collaborative WS | `1234` (`HOCUSPOCUS_PORT`) | real-time Yjs sync |
| REST metadata API | `3000` (`HTTP_PORT`) | docs CRUD, collab-token, invites, attachments |

> The two listeners are colocated in one process (`src/index.ts`). The REST API
> is stateless and horizontally scalable; the Hocuspocus nodes are stateful and
> documentName-affinity routed. They can be split into separate deployables
> later — this guide assumes the colocated process the image ships today.

---

## 1. Image build

The repository ships a single-stage [`Dockerfile`](../Dockerfile) based on
`node:22-alpine`. It runs `npm ci`, compiles TypeScript with `npm run build`
(emitting `dist/`), sets `NODE_ENV=production`, and starts `node dist/index.js`.
It `EXPOSE`s both `3000` and `1234`.

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
  with a gateway that routes WS upgrades to `1234` and REST to `3000`.

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
| `TRUST_PROXY` | **recommended behind a proxy** (`1`) | Express `trust proxy` value. The REST API sits behind nginx, so this must be set for `req.ip` — and the per-IP rate limiter — to resolve the real client from `X-Forwarded-For` instead of the proxy address. `1` = one nginx hop; use the hop count for deeper chains, a preset/CIDR like `loopback`, or `false` when exposed directly. Do **not** use `true` in prod (permissive: clients can spoof `X-Forwarded-For`). |
| `CORS_ALLOWED_ORIGINS` | **yes when the FE is a different origin** | Comma-separated allowlist of front-end origins permitted to call the REST API and (with the local-hmac driver pointed at this backend origin) the presigned attachment PUT/GET. The browser preflights cross-origin requests with `OPTIONS` and blocks any response whose `Access-Control-Allow-Origin` does not match, so the FE origin **must** be listed or image upload/download fails (XIN-717). Exact origins (`http://192.168.214.189:3010`) or the single value `*` (reflect any origin). Empty (default) allows no cross-origin request. |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | no (`60000` / `300`) | Per-IP throttle window and cap on the REST route chains (human `/api/v1/docs` + bot `/v1/bot/docs`); `/healthz` is never throttled. Keyed on the real client IP, so `TRUST_PROXY` must be correct for the deployment. |
| `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` | recommended | authoritative store connection |
| `MYSQL_CONNECTION_LIMIT` | no (`10`) | pool size |
| `REDIS_HOST` / `REDIS_PORT` | recommended | broadcast bus / cache / registry |
| `REDIS_PREFIX` | no (`octo-docs`) | multi-product key isolation prefix |
| `COLLAB_TOKEN_SECRET` | **yes in prod** | signing secret for the short-lived collab JWT. Use an asymmetric key / KMS-managed secret; the HS256 default `dev-only-change-me` is dev only. |
| `COLLAB_TOKEN_TTL_SECONDS` | no (`300`) | collab JWT TTL (5 min) |
| `COLLAB_TOKEN_PUBLIC_WS_URL` | **yes in prod** | public, browser-reachable collab WS origin returned to clients as `collabWsUrl` (§4.4). Absolute `ws://`/`wss://` only — the Hocuspocus WS server runs on its own `:1234` origin and is **not** reverse-proxied, so a relative path never reaches it. **Fail-fast prod gate:** if `NODE_ENV=production` and this is unset or malformed the process **refuses to start** (clients no longer carry a build-time WS fallback). Optional in local dev only. |
| `OCTO_IDENTITY_MODE` | no (`http`) | `http` (cross-service introspection) or `middleware` |
| `OCTO_SERVER_BASE_URL` | when `http` | octo-server base for token→uid lookups |
| `OCTO_SERVER_TOKEN` | no (default empty) — **set it if you want approver names on access cards** | Backend service token for octo-server, used by the server-side calls the backend makes on its own behalf (no user session available): (a) the add-member uid existence check (anti ghost-member) in `members.ts`, and (b) resolving the **approver's display name** for the access-decision result card (`decisionDisplay.ts`). For (a), leaving it empty is fine — that check falls back to the caller's own session token. For (b) there is no caller token (the card-action callback is a signed webhook), so with this unset `GET /v1/users/:uid` answers 401, the name is omitted, and the card renders octo-server's generic reviewer label instead of the real approver's name (the lookup miss is logged). Collaborator name/avatar display elsewhere is unaffected (the frontend fetches those directly with the logged-in user's token). |
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
| `ATTACHMENT_S3_SIGNING_HOST` | _(empty)_ | SigV4 `host` override — see §3.3 |

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
      - "3000:3000"   # REST
      - "1234:1234"   # Hocuspocus WS
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
| Startup/runtime logs | **0** `ACCESS_DENIED` / no MySQL auth failures | DB credentials are correct (see the 504 trap, §3.1) |

```bash
# liveness
curl -fsS http://localhost:3000/healthz
# auth wired (401 is the success condition here)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/v1/docs   # -> 401
```

A `200` on `/healthz` together with a `401` on `/api/v1/docs` and both
"listening" log lines is the green state. A REST endpoint hanging (no response →
gateway 504) points back to the MySQL credential trap in §3.1.

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
