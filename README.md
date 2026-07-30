# Octo Docs — Collaborative Document Backend

Real-time collaborative document subsystem for **Octo Docs**, built on
**Hocuspocus + Yjs**, implementing the FROZEN backend design contract
(`docs/contract/backend-design.md`, v3 candidate).

This backend is a focused, stateful **CRDT real-time sync service**: it handles
WebSocket sync (Yjs), authoritative binary persistence to MySQL, document-
autonomous authorization (`doc_member` + owner), short-lived collab-token
issuance, link invites, and a no-DOM Agent conversion path. It does **not** do
anything whiteboard/Excalidraw related (deferred by the contract).

> ⚠️ **Status: runnable scaffold + core paths.** Some integration glue is
> stubbed and clearly marked with `TODO(§...)`. See [Known gaps](#known-gaps).

---

## Architecture overview

```
 Tiptap front-end ──ws──▶  Hocuspocus WS server (:1234)
                            ├─ onAuthenticate  (verify collab JWT, epoch, role)
                            ├─ extension-database  → MySQL (Y.Doc binary, §3.2)
                            ├─ extension-redis     → Redis pub/sub bus (§5.1)
                            └─ beforeHandleMessage (per-principal write recheck)

 Front-end / octo-web ──REST──▶  Meta API (:3000)  /api/v1/docs/*
                                  ├─ collab-token issuance (§4.4)
                                  ├─ docs CRUD / members / invites (§8.4)
                                  └─ invite accept flow (§4.6)

 Authoritative store: MySQL   |   Broadcast bus + epoch cache + registry: Redis
 Identity: octo (token→uid, uid→profile, §4.7)   |   Attachments: object storage (§3.5, stub)
```

Key design invariants (from the contract):

- **Authoritative state is the Y.Doc binary**, not JSON (§3.1). Single-row
  merged-state model with **merge-on-write + diffUpdate bypass** (§3.2/§3.3).
- **Document-autonomous permissions**: `resolveRole = doc_member + owner`, no
  group inheritance (§4.2).
- **Two-layer token chain**: octo session token → `POST /collab-token` →
  short-lived collab JWT → WS handshake (§4.4). The long-lived octo token is
  never put on the WS.
- **`permission_epoch`** is authoritative in DB, cached in Redis, with
  singleflight DB fallback; revocation/downgrade is real-time (§4.5).
- **documentName** = `octo:{space}:{folder}:{doc}` (4 segments); whiteboard keys
  are 5 segments with `parts[3]==='wb'` and are rejected here (§4.1/§8.1).

---

## Prerequisites

- **Node.js ≥ 20** (developed on v22), npm.
- **MySQL 8** (authoritative store).
- **Redis 5+** (pub/sub broadcast bus, epoch cache, connection registry).
- **`typst` binary** (only for PDF export) — a single static Rust binary; see
  [PDF export (Typst)](#pdf-export-typst).

MySQL and Redis are only needed to **run the server** and for integration
flows. The **unit test suite runs fully offline** (mocks / in-memory).

---

## Environment variables

Copy `.env.example` to `.env` and adjust. Summary:

| Var | Purpose | Contract |
| --- | --- | --- |
| `HOCUSPOCUS_PORT` / `HTTP_PORT` | WS / REST ports | §2.1 / §8.4 |
| `MYSQL_*` | authoritative store connection | §3.4 |
| `REDIS_*` (incl. `REDIS_PREFIX`) | broadcast bus / cache / registry | §5 |
| `COLLAB_TOKEN_SECRET` / `COLLAB_TOKEN_TTL_SECONDS` | collab JWT signing + TTL (5 min) | §4.4 |
| `OCTO_IDENTITY_MODE` (`http`/`middleware`) / `OCTO_SERVER_BASE_URL` | octo identity integration | §4.7 |
| `OCTO_SERVER_TOKEN` | service token for octo-server lookups on the human path (optional). The bot path (`/v1/bot/docs`) resolves the anti ghost-member existence check via the bot's own token against the bot user-info route, so this service token is no longer required for bot member-add or forward-grant | §4.7 / v4.3 bot API |
| `MAX_DOC_BYTES` | single-doc size hard cap (~10MB) | §9.5 |
| `SEARCH_ENABLED` / `SEARCH_PAGE_SIZE_MAX` / `SEARCH_MAX_VISIBLE_TERMS` | full-text doc search: feature switch, per-page hit cap, and the OpenSearch `doc_id IN` down-push bound (over bound ⇒ 503 `terms_limit_exceeded`) | search |
| `OPENSEARCH_NODE` / `OPENSEARCH_USERNAME` / `OPENSEARCH_PASSWORD` | read-only OpenSearch client for the `octo-doc` index | search |
| `OPENSEARCH_TLS_REJECT_UNAUTHORIZED` | verify the OpenSearch TLS cert (`true`/`false`/`1`/`0`, default `true`); set `false` only for a trusted internal self-signed https node — emits a one-time warning when disabled | search |
| `KAFKA_BROKERS` / `KAFKA_ACKS` / `DOCINDEX_KAFKA_TOPIC` | doc-index signal producer: broker list, producer acks, and the topic the external indexer consumes (must match its `DOCINDEX_KAFKA_TOPIC`) | search / indexer |
| `ATTACHMENT_BUCKET` | object-storage bucket (presign stub) | §3.5 |
| `TYPST_EXPORT_BINARY` | path to the `typst` binary (empty ⇒ resolved from `PATH`) | PDF export |
| `TYPST_EXPORT_MAX_CONCURRENT` / `TYPST_EXPORT_MAX_QUEUE` | compile concurrency + queue bound (over queue ⇒ 503) | PDF export |
| `TYPST_EXPORT_COMPILE_TIMEOUT_MS` | hard per-compile timeout (child killed on expiry) | PDF export |
| `TYPST_EXPORT_MAX_IMAGE_BYTES` | per-attachment image download cap for embedding | PDF export |
| `TYPST_EXPORT_MAX_IMAGE_COUNT` | max images embedded per export (count bound) | PDF export |
| `TYPST_EXPORT_MAX_IMAGE_TOTAL_BYTES` | aggregate byte budget across embedded images per export | PDF export |

---

## Setup & run

```bash
# 1. install
npm install

# 2. create the schema (fresh install only)
#    FRESH INSTALL ONLY — schema.sql holds the full CREATE TABLE DDLs and is
#    applied once. Re-running it on an existing DB does nothing for tables that
#    already exist, so it does NOT add columns introduced after the initial
#    install — use the upgrade migrations below for that.
mysql -u <user> -p <database> < migrations/schema.sql

# 2b. EXISTING DEPLOYMENTS — build, then run the migration ledger runner.
#     It applies migrations/upgrades/*.sql in filename order, records filename
#     + checksum in schema_migrations, and safely skips already-applied files.
npm run build
npm run migrate

# 3. dev server (tsx watch) — starts both WS (:1234) and REST (:3000)
npm run dev

# build + run compiled output
npm run build
npm start
```

For local development before building, `npm run migrate:dev` runs the same
runner directly from TypeScript. Plain `mysql < migrations/upgrades/...` remains
valid as a low-level fallback, but production deploys should use `npm run
migrate` as an explicit step before starting the new server version.
When adopting the runner on a database previously migrated by hand, its first
run will re-run the idempotent upgrade files once to populate the
`schema_migrations` ledger.

## PDF export (Typst)

Documents are exported to PDF server-side by rendering the persisted document to
[Typst](https://typst.app) source and compiling it with the standalone `typst`
binary:

```
POST /api/v1/docs/:docId/export/pdf   (reader role)  →  application/pdf
```

The request pipeline is: authorise (reader) → load the authoritative persisted
Y.Doc → convert to ProseMirror JSON → render to Typst source (`src/export/
renderTypst.ts`) → compile with a short-lived `typst` child process
(`src/export/typstService.ts`). Typst has **no resident process** and **no
network access** at compile time, so image bytes are pre-downloaded
(size-bounded) into a per-compile sandbox root that `typst --root` cannot escape.

### Installing the `typst` binary

Typst is a single static Rust binary (~30MB) with no browser or LaTeX
dependency. Install it on the machine that runs this backend:

```bash
# macOS
brew install typst

# Linux (musl static release; pick your arch)
curl -fsSL https://github.com/typst/typst/releases/download/v0.13.1/typst-x86_64-unknown-linux-musl.tar.xz \
  | tar -xJ -C /tmp \
  && sudo install -m 0755 /tmp/typst-x86_64-unknown-linux-musl/typst /usr/local/bin/typst

typst --version   # verify
```

The bundled `Dockerfile` already installs the pinned `typst` binary plus the
Noto CJK and emoji fonts. If you run the backend **outside** the image (e.g.
directly on a host), install `typst` as above and make sure the host has CJK and
emoji fonts (`Noto Sans CJK` / `Noto Color Emoji`, or the platform equivalents
like PingFang / Apple Color Emoji on macOS) — Typst resolves fonts from the
system font book, so glyph coverage follows the host's installed fonts.

Set `TYPST_EXPORT_BINARY` if the binary is not on `PATH`; tune
`TYPST_EXPORT_MAX_CONCURRENT` / `TYPST_EXPORT_MAX_QUEUE` /
`TYPST_EXPORT_COMPILE_TIMEOUT_MS` / `TYPST_EXPORT_MAX_IMAGE_BYTES` /
`TYPST_EXPORT_MAX_IMAGE_COUNT` / `TYPST_EXPORT_MAX_IMAGE_TOTAL_BYTES` as needed.

## Sheet size dimensions (read payload vs storage)

A spreadsheet (`doc_type = 'sheet'`) is bounded by **two independent byte
dimensions**. They measure different serializations of the same sheet, use
different caps, and are NOT comparable — mixing them up is the source of the
apparent "dead zone" myth, so they are documented together here.

| Dimension | What it measures | How | Cap (env) | Where enforced |
| --- | --- | --- | --- | --- |
| **Read payload** | The JSON body a `GET /:docId/sheet` returns | `Buffer.byteLength(JSON.stringify({ sheetCells, sheetDims }))` | `SHEET_READ_MAX_CELL_BYTES` (default **1 MB**) → `config.sheetRead.maxCellBytes` | Read gate `docSheet.ts` → **413 `sheet_too_large`**; write gate `editDocSheet.ts` measures it the SAME way and pre-rejects a write that would exceed it |
| **Storage** | The persisted Y.Doc binary update | `Y.encodeStateAsUpdate(doc).length` | `MAX_DOC_BYTES` (default **10 MB**) → `config.maxDocBytes` | `persistence.store`; write gate `editDocSheet.ts` → **413 `doc_too_large`** |

Key points:

- **The write cap is aligned to the read cap.** `editDocSheet` rejects a write
  whose post-edit *read payload* would exceed `maxCellBytes` (`sheet_too_large`)
  *before* it touches the live Y.Doc. This guarantees **every sheet written
  through the REST/PATCH path is whole-read-readable** — there is no
  write-but-not-readable state reachable via normal writes.

- **The two dimensions are different sizes for the same sheet.** The storage
  binary carries CRDT metadata (client IDs, clocks, deletion tombstones from
  edited/deleted cells) that the decoded `{sheetCells, sheetDims}` read payload
  does not. So a sheet whose *storage* is, say, 1.05 MB can still have a *read
  payload* well under 1 MB and therefore **whole-reads 200, not 413**. That is
  correct behaviour, not a gap: the read 413 is governed only by the read-payload
  dimension, never by storage bytes.

- **Whole-read 413 is not a dead end.** A sheet whose read payload exceeds
  `maxCellBytes` (only reachable by seeding the live Y.Doc *outside* the write
  gate — e.g. a version-restore of a historic oversized snapshot, or an import)
  returns 413 `sheet_too_large` on a whole read, but the **paginated read
  (`?limit=`/`?cursor=`) retrieves it page by page**, each page bounded by
  `maxCellBytes`. No cell is unreachable.

- **413 observability.** Both size-413 bodies name the dimension they measured so
  a caller sees at a glance which cap tripped and how far past it the payload sits:
  - `sheet_too_large` (read gate and write gate) → `{ error, payloadBytes, limit }`
    (read-payload dimension; the read gate also adds a `hint` to paginate).
  - `doc_too_large` (write gate) → `{ error, docBytes, limit }` (storage dimension).

  A caller that sees `sheet_too_large` therefore knows to switch to a paginated
  read; one that sees `doc_too_large` knows the sheet has hit the hard storage
  cap and must be trimmed.

## Tests

```bash
npm test          # vitest run (offline unit tests)
npm run test:watch
```

The unit suite (52 tests) covers the critical contract paths and needs **no
MySQL/Redis**. Anything requiring live infra is mocked. Integration tests
against real MySQL/Redis are a future round (gate them behind env if added).

---

## Project structure

```
backend/
├─ migrations/
│  ├─ schema.sql                # §3.4 — the 8 DDLs, copied verbatim (fresh install)
│  └─ upgrades/                 # idempotent incremental migrations for existing DBs
├─ src/
│  ├─ config/env.ts             # typed env config
│  ├─ db/
│  │  ├─ pool.ts                # mysql2 pool + query/transaction helpers
│  │  ├─ redis.ts               # ioredis client + key namespacing
│  │  └─ repos/                 # doc_meta, doc_member, doc_invite,
│  │                            #   doc_invite_redemption, yjs_document
│  ├─ schema/index.ts           # buildSchema() + COLLAB_FIELD (local stand-in)
│  ├─ permission/
│  │  ├─ documentName.ts        # parse/build + validation matrix
│  │  ├─ role.ts                # Role <-> number, ranking
│  │  ├─ resolveRole.ts         # resolveRole / recheckCurrentRole
│  │  ├─ recheck.ts             # recheck + singleflight + short-TTL cache
│  │  ├─ epoch.ts               # permission_epoch read/bump (DB+Redis+SF)
│  │  └─ connectionRegistry.ts  # cross-node connection registry
│  ├─ auth/
│  │  ├─ collabToken.ts         # sign/verify collab JWT
│  │  ├─ issueCollabToken.ts    # §4.4 issuance service
│  │  └─ octoIdentity.ts        # OctoIdentity interface + HTTP/middleware impls
│  ├─ collab/
│  │  ├─ persistence.ts         # fetch/store merge-on-write (§3.2)
│  │  ├─ authenticate.ts        # onAuthenticate logic (§4.1)
│  │  └─ server.ts              # Hocuspocus Server wiring
│  ├─ agent/conversion.ts       # no-DOM ProseMirror <-> Y.Doc (§7.1)
│  ├─ api/
│  │  ├─ app.ts                 # Express app, mounts /api/v1/docs/*
│  │  ├─ middleware/auth.ts     # AuthMiddleware (octo token -> uid)
│  │  ├─ guard.ts               # requireDocRole
│  │  ├─ routes/                # docs, collabToken, members, invites, attachments
│  │  └─ services/              # acceptInvite + acceptDecision (pure §4.6)
│  └─ index.ts                  # process entry (WS + REST + epoch sub + shutdown)
└─ test/                        # vitest unit tests
```

---

## CONTRACT-MAPPING

Which module implements which contract section:

| Contract section | Implementation |
| --- | --- |
| §2.1 Server config, §2.2 lifecycle hooks | `src/collab/server.ts` |
| §3.1–3.3 Y.Doc binary authoritative, merge-on-write + diffUpdate bypass | `src/collab/persistence.ts` (`computeFinalState`) |
| §3.4 the 8 table DDLs | `migrations/schema.sql` |
| §3.4 repos | `src/db/repos/*` |
| §3.5 attachment presign | `src/api/routes/attachments.ts` (stub) |
| §4.1 onAuthenticate (verify, epoch, recheck, readOnly, parse) | `src/collab/authenticate.ts` |
| §4.1/§8.1/appendix B documentName validation matrix | `src/permission/documentName.ts` |
| §4.2 resolveRole (doc_member + owner) | `src/permission/resolveRole.ts` |
| §4.4 collab-token issuance + two-layer chain | `src/auth/issueCollabToken.ts`, `src/auth/collabToken.ts` |
| §4.5 permission_epoch (DB authoritative, Redis cache, singleflight) | `src/permission/epoch.ts` |
| §4.5 connection registry | `src/permission/connectionRegistry.ts` |
| §4.5 step 4 per-principal write recheck | `src/collab/server.ts` (`beforeHandleMessage`) |
| §4.6 link invite accept flow (branches a–d) | `src/api/services/acceptDecision.ts` (pure) + `acceptInvite.ts` (IO) |
| §4.7 octo identity (token→uid, uid→profile) | `src/auth/octoIdentity.ts` |
| §5.1 extension-redis multi-instance | `src/collab/server.ts` (Redis extension) |
| §7.1 no-DOM ProseMirror <-> Y.Doc | `src/agent/conversion.ts`, `src/schema/index.ts` |
| §8.1 handshake / documentName | `src/permission/documentName.ts`, collab-token route |
| §8.2 close codes (4401/4403) | `src/collab/authenticate.ts` (`AuthError`) |
| §8.3.1 awareness identity/field validation | `src/collab/server.ts` (`onAwarenessUpdate`) |
| §8.4 REST metadata API | `src/api/routes/*`, `src/api/app.ts` |
| §9.4 graceful shutdown flush | `src/index.ts` (SIGTERM) |
| §9.5 single-doc size cap | `src/collab/persistence.ts` (`store`) |
| §10.1 exact dependency versions | `package.json` |

---

## Known gaps

Honest accounting of what is **stubbed / deferred** for the next round:

- **Object-storage presign (§3.5)** — `attachments.ts` returns a non-signed
  stub URL; no COS/S3 SDK, no `doc_attachment` registration / read re-signing.
- **`@octo/docs-schema` shared package (§7.1)** — `src/schema/index.ts` is a
  local minimal ProseMirror schema stand-in. It MUST be replaced by the frozen
  shared package so the server schema is byte-identical to the Tiptap front-end.
- **octo same-process mount (§4.7(a))** — `MiddlewareOctoIdentity` delegates to
  the HTTP introspection endpoint; the real in-process `AuthMiddleware` /
  `c.GetLoginUID()` bridge requires running inside octo-server.
- **octo batch profile (§4.7(b))** — `getUsers` fans out per-uid calls; the thin
  `POST /v1/users/batch` is the one octo-side addition the contract calls out.
- **Epoch invalidation → live connection action (§4.5 step 3)** — the Redis
  subscriber refreshes the per-node epoch watermark + caches; locating and
  closing/flipping individual live connections is TODO. The `beforeHandleMessage`
  per-principal recheck is the backstop in the meantime.
- **Document lock / single-writer election (§5.3)** — `extension-redis` provides
  the lock primitive; explicit lock TTL/renew/release-on-destroy
  (`releaseAllDocumentLocks`) and documentName affinity routing are deployment/
  gateway concerns not wired here.
- **Agent `/internal/agent/docs/*` write endpoints (§7.2/§7.3)** — the no-DOM
  conversion util exists; the owner-node-routed `openDirectConnection` write
  endpoints are not yet built.
- **Incremental-log persistence model (§3.3 alternative)** — DDLs for
  `yjs_snapshot` / `yjs_update_log` are in `schema.sql` but the model is the
  default-off alternative; not implemented.
- **Integration tests** — only offline unit tests this round. No live
  MySQL/Redis integration suite yet.

