/**
 * Full-text search index queue — PRODUCER side only.
 *
 * When a document's authoritative state is persisted (collab afterStoreDocument,
 * §3.3a of the search design), we enqueue a tiny "this doc changed" signal so a
 * separate indexer can later re-read the latest body and upsert it into
 * OpenSearch. The signal deliberately carries ONLY the documentName (no body,
 * no ACL) — the consumer re-reads authoritative data by key, which keeps the
 * message small. Coalescing is a CONSUMER behavior (collapse repeated signals
 * for a doc, read once): the stream itself does not dedupe, so a burst of edits
 * appends one entry each.
 *
 * Transport: a Kafka topic (config.kafka.topic, default `octo.docindex.v1`)
 * produced to here; the separate octo-doc-indexer consumes it via a consumer
 * group with a retry topic + DLQ for at-least-once delivery. The message key is
 * the documentName (so all signals for one doc land on the same partition and
 * stay in order); the value is the JSON {documentName,kind,ts} the indexer
 * JSON.parses. The consumer / indexer / OpenSearch wiring is intentionally out
 * of scope for this module.
 *
 * Growth is bounded by the topic's own retention (an ops concern), not by this
 * producer — so there is no MAXLEN-style trim here. Rollout contract: deploy the
 * consumer BEFORE flipping SEARCH_INDEX_ENABLED on.
 *
 * This is a best-effort side channel: a send failure must NEVER disturb the
 * collab store path, so callers fire-and-forget and every error is swallowed
 * after logging.
 */
import { getKafkaProducer } from '../db/kafka.js'
import { parseDocumentName } from '../permission/documentName.js'
import { config } from '../config/env.js'

/**
 * Kafka topic index signals are produced to. The indexer's DOCINDEX_KAFKA_TOPIC
 * env MUST be set to the same value.
 */
export function docIndexTopic(): string {
  return config.kafka.topic
}

/**
 * Kind of change that triggered the signal. Only 'body' is emitted now: content
 * changed, so the consumer re-reads the body and re-indexes it. (Permission/status
 * changes are NOT signalled — search visibility is computed live in MySQL at query
 * time via listVisibleDocIdSet, so the index needs no ACL/status sync. The old
 * 'acl' producer was removed.)
 */
export type DocIndexKind = 'body'

/**
 * Whether a documentName has a searchable body worth enqueuing. Indexed this期:
 * 'document' (doc / sheet) and 'whiteboard' (board, `:wb:` key / doc_type='board')
 * — both have a Yjs body the consumer can extract. Html is EXCLUDED at the
 * producer (its body lives in the external octo-doc service; the consumer skips
 * html anyway). Parse failures => not indexed (best-effort gate, never throws).
 */
export function isSearchIndexedDoc(documentName: string): boolean {
  try {
    const kind = parseDocumentName(documentName).kind
    return kind === 'document' || kind === 'whiteboard'
  } catch {
    return false
  }
}

/**
 * Shape of one index signal, serialized as the JSON message value by
 * enqueueDocIndex. The indexer JSON.parses the message value back into this shape.
 */
export interface DocIndexSignal {
  /** Canonical collab key `octo:<space>:<folder>:<doc>`; consumer parses/reads by it. */
  documentName: string
  kind: DocIndexKind
  /**
   * Enqueue timestamp (ms), DIAGNOSTIC ONLY. This is the producing node's local
   * wall clock, so it skews across a fleet — do NOT use it as a correctness
   * ordering / staleness key (e.g. OpenSearch external version), or a newer write
   * carrying an older ts would be dropped as "stale". Derive ordering from the DB
   * (updated_at / permission_epoch) instead.
   */
  ts: number
}

/**
 * Push a change signal onto the index topic. Best-effort: never throws — a Kafka
 * hiccup here must not fail the surrounding store. Returns true if the send was
 * accepted, false if it was swallowed.
 */
export async function enqueueDocIndex(
  documentName: string,
  kind: DocIndexKind = 'body',
): Promise<boolean> {
  const signal: DocIndexSignal = { documentName, kind, ts: Date.now() }
  try {
    // key = documentName so every signal for one doc hashes to the same
    // partition and stays ordered; value = the whole signal as JSON, which the
    // indexer JSON.parses. ts is DIAGNOSTIC ONLY (see DocIndexSignal) — the
    // indexer derives its OpenSearch version from the DB, never from ts.
    const producer = await getKafkaProducer()
    await producer.send({
      topic: config.kafka.topic,
      acks: config.kafka.acks,
      messages: [{ key: documentName, value: JSON.stringify(signal) }],
    })
    return true
  } catch (err) {
    // documentName is externally controlled (derived from client-supplied doc
    // keys), so it must NOT sit in the format-string position of console.warn —
    // Node treats the first arg as a util.format template, and a crafted key
    // containing %s/%d/%o would be interpreted as a format directive
    // (js/tainted-format-string). Keep the template a fixed literal and pass the
    // untrusted value as a separate argument.
    // eslint-disable-next-line no-console
    console.warn('[octo-docs] search index-queue enqueue failed for %s:', documentName, err)
    return false
  }
}
