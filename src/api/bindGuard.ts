/**
 * Bind-failure guard for an HTTP listener.
 *
 * WHY THIS EXISTS (and why it is not just `server.on('error', exit)`):
 *
 * `src/index.ts` installs a deliberately NON-FATAL `uncaughtException` handler —
 * a stray throw inside a Hocuspocus hook must not kill a node that is serving
 * live collaborative sessions. That backstop has a side effect: a listener that
 * fails to BIND (EADDRINUSE / EACCES) would only be logged, and the process
 * would keep running while serving nothing on that port — `/healthz` still
 * answers 200 on the other listener, so orchestration calls the container
 * healthy. A visible crashloop beats a silently degraded pod, so a bind failure
 * must exit.
 *
 * But `net.Server` emits `'error'` for MORE than bind failures, and for the
 * whole life of the process. Node's own `net.js` routes accept-time failures to
 * the same event:
 *
 *   function onconnection(err, clientHandle) {
 *     if (err) { self.emit('error', new ErrnoException(err, 'accept')); return }
 *
 * So under FD exhaustion (EMFILE / ENFILE at `accept`) — a realistic failure
 * mode for a process that also holds long-lived WS connections plus MySQL /
 * Redis / Kafka handles — an unconditional `process.exit(1)` would:
 *   - kill a process that was serving fine a moment ago, and
 *   - bypass the graceful `shutdown()` in index.ts, so `hocuspocus.destroy()`
 *     never runs and in-memory Yjs docs are never flushed via onStoreDocument —
 *     costing live sessions and up to a debounce window of unpersisted edits.
 *
 * Hence the guard is scoped by LIFECYCLE, not by error code: everything before
 * `'listening'` is a bind failure and is fatal; everything after it is a runtime
 * error on an already-bound socket and is logged, matching the non-fatal posture
 * the process had before the guard existed. Scoping by lifecycle rather than by
 * an EADDRINUSE/EACCES allowlist means an unforeseen pre-bind errno still fails
 * fast instead of being silently treated as survivable.
 *
 * Extracted into its own module (rather than inlined in index.ts) so it is
 * unit-testable: importing index.ts requires live MySQL/Redis, which is exactly
 * why the over-broad version of this handler shipped unnoticed.
 */
import type { Server } from 'node:http'

/** Injectable seams so a test can observe the guard without killing the runner. */
export interface BindGuardHooks {
  /** Defaults to `process.exit`. */
  exit?: (code: number) => never
  /** Defaults to `console.error`. */
  logError?: (message: string, err: unknown) => void
}

/**
 * Make a bind failure on `server` fatal, while leaving post-bind `'error'`
 * events non-fatal.
 *
 * @param server listener to guard; attach BEFORE or right after `listen()` —
 *   `'listening'` has not fired yet in either case, so no bind error is missed.
 * @param label human name used in the log line, e.g. `REST API :3000`.
 */
export function attachBindGuard(server: Server, label: string, hooks: BindGuardHooks = {}): void {
  const exit = hooks.exit ?? ((code: number) => process.exit(code))
  const logError =
    hooks.logError ??
    ((message: string, err: unknown) => {
      // eslint-disable-next-line no-console
      console.error(message, err)
    })

  let bound = false
  server.once('listening', () => {
    bound = true
  })

  server.on('error', (err: unknown) => {
    if (!bound) {
      logError(`[octo-docs] ${label} failed to bind — refusing to serve:`, err)
      exit(1)
      return
    }
    // Already serving: an accept-level failure (EMFILE/ENFILE) must not take the
    // node down and must not bypass graceful shutdown. Log and keep serving,
    // which is exactly what the process did before this guard existed.
    logError(`[octo-docs] ${label} socket error after bind (non-fatal, still serving):`, err)
  })
}
