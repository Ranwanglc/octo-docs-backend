# Kafka migration notes (doc-index pipeline, plan A) — octo-docs-backend (producer side)

Migrate the document-index signal pipeline from **Redis Stream** to **Kafka**. This repo is the
**producer**: the collab `afterStoreDocument` hook emits a `{documentName,kind,ts}` signal after a
document is persisted, which the standalone `octo-doc-indexer` consumes and writes into OpenSearch.

Delivery semantics are unchanged: best-effort side channel + at-least-once on the consumer +
OpenSearch external-version idempotency. **A send failure must never affect the primary document
write** (the original try/catch semantics are preserved).

## Files changed

| File | Change |
|---|---|
| `src/db/kafka.ts` | **New.** Lazy singleton kafkajs producer (mirrors the `getRedis()` style in `db/redis.ts`): `getKafkaProducer()` constructs + connects on first call, concurrent calls share the same in-flight connect, and a failed connect clears the cache so the next call retries. Uses the Java-compatible `DefaultPartitioner` for consistent key-based partitioning. Also exposes `closeKafkaProducer()`. |
| `src/search/docIndexQueue.ts` | `enqueueDocIndex` replaces `getRedis().xadd(...)` with `producer.send({ topic, acks, messages:[{ key, value }] })`. **key = documentName** (same document to the same partition, ordered); value = the original `{documentName,kind,ts}` JSON. Dropped the MAXLEN logic (Kafka uses topic retention). Still best-effort: a `send` failure only `console.warn`s and returns `false`. `docIndexQueueKey()` → `docIndexTopic()` (returns `config.kafka.topic`). Signature, `isSearchIndexedDoc`/`DocIndexKind`/`DocIndexSignal` are unchanged. |
| `src/config/env.ts` | The `search` group drops `indexStreamKey` (`SEARCH_INDEX_STREAM_KEY`) and `queueMax` (`SEARCH_INDEX_QUEUE_MAX`); it keeps `indexEnabled` (`SEARCH_INDEX_ENABLED`, still the rollout switch). New `kafka` group: `brokers` (`KAFKA_BROKERS`, comma-separated, default `127.0.0.1:9092`), `topic` (`DOCINDEX_KAFKA_TOPIC`, default `octo.docindex.v1`), `acks` (`KAFKA_ACKS`, default `1`). |
| `test/docIndexQueue.test.ts` | Switched from mocking Redis `xadd` to mocking `getKafkaProducer` in `../src/db/kafka.js`; asserts topic / key=documentName / JSON value / acks / returns false without throwing on failure. |
| `package.json` / `package-lock.json` | `npm install kafkajs` (2.2.4). |

**Not changed:** the `ioredis` dependency is **kept** — Redis is still used in this repo for pub/sub,
the permission_epoch cache, the connection registry, etc. (`getRedis`/`closeRedis` untouched); only
the stream usage was removed from the doc-index producer. `posIntMin` (and its standalone unit test)
is kept.

## Environment variable mapping

| Old (Redis stream) | New (Kafka) |
|---|---|
| `SEARCH_INDEX_STREAM_KEY` | `DOCINDEX_KAFKA_TOPIC` (default `octo.docindex.v1`) |
| `SEARCH_INDEX_QUEUE_MAX` | removed (Kafka retention is configured by ops) |
| — | new: `KAFKA_BROKERS`, `KAFKA_ACKS` |
| `SEARCH_INDEX_ENABLED` | unchanged (rollout switch) |

## Verification results

- `npm run typecheck`: **EXIT 0**
- `npm run lint` (eslint): **EXIT 0**
- `npm run test` (vitest): **1478 passed / 3 skipped** (120 files, all green), including the updated `docIndexQueue.test.ts`

## Out of scope (not done in this task)

- **Kafka topics are not created**: `octo.docindex.v1` / `.retry` / `.dlq` are created by ops (partition count, retention, etc.).
- **Not deployed**; no docker / VM run.
- **No git commit / push.**
- Production must set `KAFKA_BROKERS` (the default `127.0.0.1:9092` is local-only); `DOCINDEX_KAFKA_TOPIC` must match the indexer side.
- `ioredis` was not removed (Redis is still used by other subsystems).
