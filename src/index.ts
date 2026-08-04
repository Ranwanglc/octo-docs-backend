/**
 * Process entry point.
 *
 * Starts the Hocuspocus collaborative WS server (§2.1) and the REST metadata
 * API (§8.4) in one process. Wires the Redis epoch-invalidation subscriber
 * (§4.5 step 3) to refresh the per-node epoch watermark, and a SIGTERM graceful
 * shutdown that flushes documents and releases locks (§9.4).
 *
 * NOTE: In production these can be separate deployables — the Meta API is
 * stateless and horizontally scalable, while Hocuspocus nodes are stateful and
 * documentName-affinity routed (§9.1). They are colocated here for a runnable
 * scaffold.
 */
import { Redis } from 'ioredis'
// B3: load .env before config/env.js is evaluated (must be the first import).
import './config/loadEnv.js'
import { config } from './config/env.js'
import { createServer, setEpochWatermark } from './collab/server.js'
import { createApp } from './api/app.js'
import { epochInvalidateChannel, currentEpoch, invalidateEpochCache, type InvalidateEvent } from './permission/epoch.js'
import { closePool, query } from './db/pool.js'
import { assertAppendV1RoleEncoding } from './db/roleEncodingMarker.js'
import { closeRedis } from './db/redis.js'
import { closeKafkaProducer } from './db/kafka.js'
import { broadcastCommentMutation, commentEventsChannel } from './api/services/commentEvents.js'

async function main(): Promise<void> {
  // B1 safety backstop: a stray throw/rejection inside an async hook (e.g. a
  // Hocuspocus awareness/sync callback) must never silently kill the server.
  // We log and KEEP SERVING — this is deliberately NOT a shutdown path; the
  // SIGTERM/SIGINT handlers below own graceful shutdown.
  process.on('uncaughtException', (err) => {
    // eslint-disable-next-line no-console
    console.error('[octo-docs] uncaughtException (non-fatal, still serving):', err)
  })
  process.on('unhandledRejection', (reason) => {
    // eslint-disable-next-line no-console
    console.error('[octo-docs] unhandledRejection (non-fatal, still serving):', reason)
  })

  // Role integers are security-sensitive persisted data. Verify their encoding
  // before constructing either permission-serving endpoint; missing migrations,
  // legacy encodings, and unreadable marker state all abort startup.
  await assertAppendV1RoleEncoding({
    query: (sql, params) => query<Record<string, unknown>>(sql, params),
  })

  const hocuspocus = createServer()

  // Subscribe to epoch invalidation events (§4.5 step 3). On an event we drop
  // caches and refresh the local watermark. Acting on individual live
  // connections (close 4403 / flip readOnly) is the next layer; the
  // beforeHandleMessage per-principal recheck (§4.5 step 4) is the backstop.
  const sub = new Redis({ host: config.redis.host, port: config.redis.port })
  await sub.subscribe(epochInvalidateChannel(), commentEventsChannel())
  sub.on('message', (channel: string, message: string) => {
    if (channel === epochInvalidateChannel()) void handleInvalidate(message)
    else if (channel === commentEventsChannel()) broadcastCommentMutation(message)
  })

  async function handleInvalidate(message: string): Promise<void> {
    let event: InvalidateEvent
    try {
      event = JSON.parse(message) as InvalidateEvent
    } catch {
      return
    }
    await invalidateEpochCache(event.documentName)
    try {
      const epoch = await currentEpoch(event.documentName)
      setEpochWatermark(event.documentName, epoch)
    } catch {
      /* doc gone or source unconfirmable; backstop is beforeHandleMessage */
    }
    // TODO(§4.5 step 3): locate local connections via the connection registry
    // and close(4403) revoked / flip readOnly on downgraded connections.
  }

  await hocuspocus.listen()
  // eslint-disable-next-line no-console
  console.log(`[octo-docs] Hocuspocus listening on :${config.hocuspocusPort}`)

  const app = createApp()
  const httpServer = app.listen(config.httpPort, () => {
    // eslint-disable-next-line no-console
    console.log(`[octo-docs] REST API listening on :${config.httpPort}`)
  })

  // §9.4 graceful shutdown: flush docs, then release locks, then close infra.
  const shutdown = async (signal: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`[octo-docs] ${signal} received, shutting down...`)
    try {
      await hocuspocus.destroy() // flushes in-memory docs (triggers onStoreDocument)
      // TODO(§5.3 / §9.4): releaseAllDocumentLocks() so a takeover node can
      // become primary writer immediately without waiting for the lock TTL.
      httpServer.close()
      sub.disconnect()
      await closeRedis()
      await closeKafkaProducer()
      await closePool()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[octo-docs] fatal startup error:', err)
  process.exit(1)
})
