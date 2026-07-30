/**
 * Shared kafkajs producer (search doc-index signal channel).
 *
 * Mirrors db/redis.ts: a lazily-constructed singleton so the process holds one
 * producer connection. Used ONLY by the search index-signal producer
 * (search/docIndexQueue.ts) to publish {documentName,kind,ts} to the doc-index
 * Kafka topic; the separate octo-doc-indexer consumes it. Best-effort side
 * channel — send failures never disturb the collab store path (see
 * enqueueDocIndex).
 */
import { Kafka, Partitioners, type Producer } from 'kafkajs'
import { config } from '../config/env.js'

let producer: Producer | null = null
let connecting: Promise<Producer> | null = null

/**
 * Lazily construct + connect the shared producer (same lazy style as getRedis()).
 * Concurrent callers await the same in-flight connect. On connect failure the
 * cached promise is cleared so a later enqueue retries rather than being wedged
 * on a dead promise. Uses the Java-compatible DefaultPartitioner so keying by
 * documentName maps a document consistently to one partition (in-order per doc).
 */
export async function getKafkaProducer(): Promise<Producer> {
  if (producer) return producer
  if (!connecting) {
    const kafka = new Kafka({ clientId: config.hostname, brokers: config.kafka.brokers })
    const p = kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner })
    connecting = p
      .connect()
      .then(() => {
        producer = p
        return p
      })
      .catch((err) => {
        connecting = null
        throw err
      })
  }
  return connecting
}

/** Disconnect the shared producer if one was created (idempotent). */
export async function closeKafkaProducer(): Promise<void> {
  if (producer) {
    const p = producer
    producer = null
    connecting = null
    await p.disconnect()
  }
}
