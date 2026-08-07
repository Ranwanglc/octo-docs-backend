/**
 * Process entry point.
 *
 * Starts the Hocuspocus collaborative WS server (§2.1) and the REST metadata
 * API (§8.4) in one process. Wires the Redis epoch-invalidation subscriber
 * (§4.5 step 3) to refresh the per-node epoch watermark, and a SIGTERM graceful
 * shutdown that flushes documents and releases locks (§9.4).
 *
 * NOTE: In production the Hocuspocus WS and the REST Meta API can be separate
 * deployables. The REST Meta API is stateless for its request/response endpoints,
 * but the PPT relay attached to it (below) keeps a PROCESS-LOCAL room registry
 * (live sockets, per-room seq/budget state) and a Redis-backed single-use ticket
 * store. For THIS round the committed topology is SINGLE-REPLICA: deploy exactly
 * one REST/PPT-relay replica per environment (see DEPLOYMENT.md). The earlier
 * docId-affinity routing note is retracted — horizontal REST scaling can be
 * revisited only after the relay grows an explicit shared transport or affinity
 * design; until then a second replica would split a deck's room state and is not
 * supported. The two listeners are colocated here for a runnable scaffold.
 */
import { Redis } from 'ioredis'
// B3: load .env before config/env.js is evaluated (must be the first import).
import './config/loadEnv.js'
import { config } from './config/env.js'
import { createServer, setEpochWatermark } from './collab/server.js'
import { createApp } from './api/app.js'
import { createPptRelay } from './ppt/relay/index.js'
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

  // R4-B1: construct the Bento-frame PPT relay BEFORE the epoch-invalidation
  // subscriber below — `handleInvalidate` closes over `pptRelay`, so creating the
  // relay after wiring `sub.on('message', ...)` left a temporal-dead-zone window
  // where an invalidation arriving between subscribe and relay-construction would
  // throw a ReferenceError (XIN-1693 P2-g). It is ATTACHED to the REST HTTP server
  // further below, once that server exists.
  const pptRelay = createPptRelay()

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
    // R4-B1: propagate the permission change to any live PPT relay sockets on
    // this doc — re-resolve each connection's role, notify `role-changed`, and
    // close a revoked (now-`none`) socket. Old-epoch frames still in flight are
    // refused by the relay's per-frame epoch check.
    void pptRelay.applyEpochBump(event.documentName).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[octo-docs] PPT relay epoch bump failed:', err)
    })
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

  // R4-B1: the Bento-frame PPT relay is hosted INSIDE B — attached to the REST
  // HTTP server on the `/api/v1/ppt/collab` upgrade path (owner-locked "no second
  // service"), NOT the Hocuspocus server above and NOT a new deployable. The relay
  // itself was constructed earlier (before the epoch subscriber that references
  // it); here we only bind it to the now-listening HTTP server.
  pptRelay.attach(httpServer)
  // eslint-disable-next-line no-console
  console.log('[octo-docs] PPT relay attached on /api/v1/ppt/collab')

  // §9.4 graceful shutdown: flush docs, then release locks, then close infra.
  const shutdown = async (signal: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`[octo-docs] ${signal} received, shutting down...`)
    try {
      await hocuspocus.destroy() // flushes in-memory docs (triggers onStoreDocument)
      // TODO(§5.3 / §9.4): releaseAllDocumentLocks() so a takeover node can
      // become primary writer immediately without waiting for the lock TTL.
      pptRelay.close()
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
