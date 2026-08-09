/**
 * MySQL-backed {@link PptRelayStore} (R4-B1, §7.3).
 *
 * Wires the relay's durability contract onto `ppt_collab_op` +
 * `ppt_live_snapshot` + `ppt_collab_seq` + `ppt_collab_frame`:
 *  - `appendOp` runs in a transaction. `ppt_collab_frame` (PK `(doc_id, frame_id)`)
 *    is the dedup AUTHORITY and is written at APPEND time, so dedup is a CURRENT
 *    read (the PRIMARY-KEY uniqueness check sees committed rows regardless of the
 *    transaction snapshot) rather than a REPEATABLE-READ snapshot read. A fast-path
 *    ledger read re-acks a resend already visible in this tx's snapshot without
 *    burning a seq; otherwise the next seq is allocated from the durable per-room
 *    counter (`ppt_collab_seq`, atomic increment under the counter row's lock) and
 *    the ledger row is inserted. If a concurrent resend already claimed the frame,
 *    the ledger insert raises `ER_DUP_ENTRY` and we re-ack the winner's seq via a
 *    LOCKING read (latest committed) — never `storage-failed`. A committed row (and
 *    its ack) therefore reflects a monotonic order that neither races on a room's
 *    first write, nor regresses after a full-coverage prune, nor re-mints a fresh
 *    seq for a frame whose op row was pruned (XIN-1655 C1), nor rebroadcasts a
 *    duplicate on the pre-commit-resend interleaving (XIN-1660 D1).
 *  - `saveSnapshot` advances `snapshot_version` and writes the doc atomically in
 *    one covered-guarded upsert (§7.3).
 *  - `pruneOpsThrough` runs only AFTER `saveSnapshot` has committed (the relay
 *    engine sequences these two calls), matching "GC only after a durable
 *    snapshot". Because the dedup ledger is now written at append time it needs no
 *    copy-at-prune step, so the prune is a plain `DELETE` — no `INSERT … SELECT`
 *    that took shared next-key locks over the gap above `coveredSeq` and blocked a
 *    concurrent append there into `ER_LOCK_WAIT_TIMEOUT` (XIN-1660 D2). It returns
 *    the bytes reclaimed so the relay's room-budget counter stays in step.
 */
import { getPool, transaction, type Tx } from '../../db/pool.js'
import { pptCollabFrameRepo } from '../../db/repos/pptCollabFrameRepo.js'
import { pptCollabOpRepo } from '../../db/repos/pptCollabOpRepo.js'
import { pptLiveSnapshotRepo } from '../../db/repos/pptLiveSnapshotRepo.js'
import { pptRelaySeqRepo } from '../../db/repos/pptRelaySeqRepo.js'
import {
  canonicalPayloadHash,
  DuplicateFramePayloadError,
  RetryableStorageError,
  withStoreRetry,
  type AppendOpResult,
  type FrameIdentity,
  type PersistedOp,
  type PptRelayStore,
  type RelaySnapshot,
  type ReplayCursor,
  type ReplayLimits,
  type ReplayView,
  type SaveSnapshotInput,
  type SaveSnapshotResult,
} from './store.js'

/** MySQL duplicate-key error code (surfaced by mysql2 on a unique/PK conflict). */
function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'ER_DUP_ENTRY'
  )
}

export class DbPptRelayStore implements PptRelayStore {
  async appendOp(docId: string, frameId: string, frame: unknown): Promise<AppendOpResult> {
    const frameJson = JSON.stringify(frame)
    const frameBytes = Buffer.byteLength(frameJson, 'utf8')
    const payloadHash = canonicalPayloadHash(frame)
    return withStoreRetry('append', () => this.appendOpOnce(docId, frameId, frameJson, frameBytes, payloadHash))
  }

  private appendOpOnce(
    docId: string,
    frameId: string,
    frameJson: string,
    frameBytes: number,
    payloadHash: string,
  ): Promise<AppendOpResult> {
    return transaction(async (tx) => {
      // Fast-path: a resend whose ledger row is already committed AND visible in
      // this tx's snapshot re-acks without allocating (burning) a fresh seq. NOT
      // the authority for the concurrent race — the ledger PK insert below is —
      // so a snapshot miss here is still caught by `ER_DUP_ENTRY` (XIN-1660 D1).
      const existing = await pptCollabFrameRepo.getByFrameIdTx(tx, docId, frameId)
      if (existing !== null) {
        return this.resolveDuplicate(tx, docId, frameId, existing, payloadHash, frameBytes)
      }
      const seq = await pptRelaySeqRepo.nextSeqTx(tx, docId)
      try {
        // Dedup authority: the `(doc_id, frame_id)` PRIMARY KEY, written at APPEND
        // time so the uniqueness check is a CURRENT read, not a snapshot read.
        await pptCollabFrameRepo.insertTx(tx, docId, frameId, seq, payloadHash)
      } catch (err) {
        // A concurrent resend of the same frameId won the ledger race: re-read the
        // winner's seq (LOCKING read = latest committed) and re-ack it as a
        // duplicate — never a permanent failure, never a re-minted seq.
        if (isDuplicateKeyError(err)) {
          const orig = await pptCollabFrameRepo.getByFrameIdForUpdateTx(tx, docId, frameId)
          if (orig !== null) {
            return this.resolveDuplicate(tx, docId, frameId, orig, payloadHash, frameBytes)
          }
        }
        throw err
      }
      try {
        await pptCollabOpRepo.insertTx(tx, docId, seq, frameId, frameJson, frameBytes)
      } catch (err) {
        // P1-1 (b): the op table still carries `UNIQUE (doc_id, frame_id)`. On an
        // already-migrated DB, op rows written by the PREVIOUS deploy have no dedup
        // ledger row, so a resend takes this fresh-frame path (ledger insert above
        // succeeds), then the op insert hits that unique key. Before this fix the
        // throw escaped the append and became a permanent, forever-retried
        // `storage-failed` — "collaboration randomly loses edits after deploy".
        // Instead, re-ack the op's ORIGINAL seq and repoint the ledger row we just
        // inserted at it (the freshly-allocated seq is burned; seq gaps are legal).
        // The migration also backfills the ledger from `ppt_collab_op`, so this
        // branch is the belt to that migration's suspenders.
        //
        // The re-ack MUST be payload-verified, exactly like `resolveDuplicate`'s
        // ledger paths: read the stored op FRAME (not just its seq) under a locking
        // read and compare its canonical-ops hash to the incoming frame's. A match
        // is a genuine idempotent resend — repoint the ledger to the op's original
        // seq (the fresh ledger row we inserted above already carries the incoming
        // hash, which equals the stored hash) and re-ack. A MISMATCH is a reused
        // frameId carrying DIFFERENT ops: throw `DuplicateFramePayloadError`, which
        // rolls the whole transaction back — undoing the ledger row we just inserted
        // at the burned seq — so the burned-gap compatibility path can never blindly
        // re-ack a different payload as a duplicate. A pruned op row (no frame_json)
        // still fails closed on the null return below.
        if (isDuplicateKeyError(err)) {
          const orig = await pptCollabOpRepo.getFrameByFrameIdForUpdateTx(tx, docId, frameId)
          if (orig !== null) {
            if (canonicalPayloadHash(orig.frame) !== payloadHash) {
              throw new DuplicateFramePayloadError(frameId)
            }
            await pptCollabFrameRepo.updateSeqTx(tx, docId, frameId, orig.seq)
            return { seq: orig.seq, duplicate: true, frameBytes }
          }
        }
        throw err
      }
      return { seq, duplicate: false, frameBytes }
    })
  }

  /**
   * Resolve a frame that already has a ledger row into a duplicate re-ack or a
   * payload-mismatch error.
   *
   * A non-NULL `payload_hash` is the canonical-ops hash (XIN-1736 P1-A): an exact
   * match is an idempotent resend (re-ack the original seq); anything else is a
   * reused frameId carrying DIFFERENT ops and is refused.
   *
   * A NULL `payload_hash` is a legacy row (recorded before the canonical-ops hash,
   * or nulled by the hash-scheme migration). Rather than fail closed on the
   * missing hash — which would permanently refuse a legitimate resend of a
   * committed write — verify against the stored op `frame_json` when the op row is
   * still present (XIN-1736 P2-d): equal canonical ops re-ack (and the ledger row
   * is backfilled so the next resend takes the fast hash path), different ops are
   * refused. A frame whose op row was already PRUNED has no `frame_json` to verify
   * against and still fails closed (the round-10 invariant recorded in schema.sql:
   * "NULL legacy rows fail closed").
   */
  private async resolveDuplicate(
    tx: Tx,
    docId: string,
    frameId: string,
    stored: FrameIdentity,
    payloadHash: string,
    frameBytes: number,
  ): Promise<AppendOpResult> {
    if (stored.payloadHash !== null) {
      if (stored.payloadHash === payloadHash) return { seq: stored.seq, duplicate: true, frameBytes }
      throw new DuplicateFramePayloadError(frameId)
    }
    const op = await pptCollabOpRepo.getFrameByFrameIdForUpdateTx(tx, docId, frameId)
    if (op === null) throw new DuplicateFramePayloadError(frameId)
    if (canonicalPayloadHash(op.frame) !== payloadHash) throw new DuplicateFramePayloadError(frameId)
    // Backfill the canonical hash so a subsequent resend re-acks on the fast path.
    await pptCollabFrameRepo.updatePayloadHashTx(tx, docId, frameId, payloadHash)
    return { seq: stored.seq, duplicate: true, frameBytes }
  }

  /** Seq recorded for a frame id, or null if unseen (pre-gate dedup lookup, D3). */
  async frameSeq(docId: string, frameId: string): Promise<number | null> {
    return pptCollabFrameRepo.getSeqByFrameId(docId, frameId)
  }

  async frameIdentity(docId: string, frameId: string): Promise<FrameIdentity | null> {
    return pptCollabFrameRepo.getByFrameId(docId, frameId)
  }

  async resolveNullHashReack(docId: string, frameId: string): Promise<{ seq: number; payloadHash: string } | null> {
    // Pre-gate re-ack for a NULL-payload_hash ledger row (legacy / nulled by the
    // canonical-ops hash migration): the ledger alone cannot verify the resend, so
    // recompute the canonical-ops hash from the stored op `frame_json` — the same
    // verification `resolveDuplicate` runs inside `appendOp`, but WITHOUT the
    // mutation gate, so a pure re-ack of an already-durable write is not refused
    // stale-epoch/forbidden-role for a downgraded/epoch-advanced connection
    // (XIN-1750). A non-locking CURRENT read: the pre-gate path neither persists
    // nor rebroadcasts. Only NULL-hash rows resolve here (a non-null row is the
    // fast path via `frameIdentity`); an unseen frame or a PRUNED op row (no
    // frame_json) returns null and falls through to `appendOp`, which fails closed.
    const identity = await pptCollabFrameRepo.getByFrameId(docId, frameId)
    if (identity === null || identity.payloadHash !== null) return null
    const op = await pptCollabOpRepo.getFrameByFrameId(docId, frameId)
    if (op === null) return null
    return { seq: identity.seq, payloadHash: canonicalPayloadHash(op.frame) }
  }

  async opsSince(docId: string, sinceSeq: number, limit?: number): Promise<PersistedOp[]> {
    const ops = await pptCollabOpRepo.since(docId, sinceSeq, limit)
    return ops.map((o) => ({ seq: o.seq, frameId: o.frameId, frame: o.frame, frameBytes: o.frameBytes }))
  }

  async currentSeq(docId: string): Promise<number> {
    // The authoritative high-water is the durable counter, NOT MAX(seq) over the
    // op table (which regresses after a prune empties it).
    return pptRelaySeqRepo.currentSeq(docId)
  }

  async roomBytes(docId: string): Promise<number> {
    return pptCollabOpRepo.sumFrameBytes(docId)
  }

  async getSnapshot(docId: string): Promise<RelaySnapshot | null> {
    const snap = await pptLiveSnapshotRepo.get(docId)
    if (!snap) return null
    return { snapshotVersion: snap.snapshotVersion, coveredSeq: snap.coveredSeq, doc: snap.doc, state: snap.state }
  }

  async saveSnapshot(input: SaveSnapshotInput): Promise<SaveSnapshotResult> {
    return withStoreRetry('saveSnapshot', () => transaction(async (tx) => {
      const { snapshotVersion, coveredSeq } = await pptLiveSnapshotRepo.upsertAdvanceTx(
        tx,
        input.docId,
        input.coveredSeq,
        input.doc,
        input.state,
      )
      // Surface the authoritative POST-WRITE coveredSeq (GREATEST(existing,
      // incoming)) so the relay prunes with it, never the client's raw `q` (P0-1).
      return { snapshotVersion, coveredSeq }
    }))
  }

  /**
   * Streaming replay cursor (P1-4 / XIN-1736 P1-B, P1-G, P1-H).
   *
   * The round-9/10 implementation opened ONE `REPEATABLE READ` transaction and
   * held its pooled connection open across every client send. Three defects
   * followed, all fixed here:
   *
   *  - P1-H: the connection + open read transaction were held across `gatedSend`
   *    (up to `sendDrainTimeoutMs` per frame) behind a process-wide, un-timed
   *    replay semaphore, so one slow deck's replay pinned a pool connection,
   *    delayed joins on every deck, and blocked InnoDB purge. Now the head read
   *    (high-water + snapshot) runs in a short transaction that COMMITS before
   *    any frame is sent, and each op page runs in its OWN short transaction —
   *    no transaction is ever held across client I/O.
   *  - P1-B: `nextPage` retried its SELECT via `withStoreRetry` on the SAME
   *    connection whose transaction a deadlock had already rolled back, so the
   *    retried read ran OUTSIDE the consistent snapshot. Each page now opens a
   *    FRESH consistent-snapshot transaction, so a retry re-reads from a fresh,
   *    live snapshot instead of a dead one.
   *  - P1-G: the byte budget was applied AFTER fetching `pageRows` rows and the
   *    cursor advanced only through the rows that fit, so byte-dropped rows were
   *    re-SELECTed + re-parsed on every page (~16-24× I/O for large-frame rooms).
   *    A fetch now advances the cursor past EVERY row it read (buffered in the
   *    cursor) and the byte budget only bounds how many buffered rows each
   *    `nextPage` EMITS — nothing is ever re-fetched.
   *
   * Consistency across the now-separate page transactions is preserved by a
   * prune-race guard: each page reads the live snapshot's `covered_seq` in the
   * same fresh transaction as the op page; if a concurrent `snap`+prune advanced
   * coverage PAST the cursor (so ops the reader has not yet delivered may have
   * been physically pruned), the page throws a retryable error and the relay
   * refuses `storage-retry` — the client re-`hello`s and replays from the new
   * snapshot rather than silently skipping the pruned ops (the P1-4 property).
   */
  async openReplay(docId: string, sinceSeq: number, limits: ReplayLimits): Promise<ReplayCursor> {
    // Head read: high-water + snapshot from ONE consistent snapshot, then the
    // transaction/connection is released — never held across the client sends
    // that follow (P1-H).
    const head = await withStoreRetry('openReplay.head', () => this.readReplayHead(docId))
    const headCovered = head.snapshot?.coveredSeq ?? 0
    let cursor = sinceSeq
    let buffer: PersistedOp[] = []
    let eof = false
    let closed = false
    return {
      highWater: head.highWater,
      snapshot: head.snapshot,
      fromSeq: sinceSeq,
      nextPage: async () => {
        if (closed || eof) return []
        if (buffer.length === 0) {
          // Fresh short transaction per fetch: a deadlock retry re-opens a live
          // snapshot (P1-B), and the transaction is committed before we return
          // (so it is not held across the caller's client I/O, P1-H).
          const batch = await withStoreRetry('openReplay.page', () =>
            this.readReplayPage(docId, cursor, headCovered, limits.pageRows, head.highWater),
          )
          if (batch.rows.length === 0) {
            eof = true
            return []
          }
          // Advance the cursor past EVERY fetched row and buffer them, so the
          // byte budget below can trim what we EMIT without ever re-fetching the
          // remainder next page (P1-G).
          cursor = batch.rows[batch.rows.length - 1]!.seq
          buffer = batch.rows
        }
        const page: PersistedOp[] = []
        let bytes = 0
        while (buffer.length > 0) {
          const row = buffer[0]!
          const frameBytes = row.frameBytes ?? Buffer.byteLength(JSON.stringify(row.frame), 'utf8')
          if (page.length > 0 && bytes + frameBytes > limits.pageBytes) break
          page.push(buffer.shift()!)
          bytes += frameBytes
        }
        return page
      },
      close: async () => {
        closed = true
        buffer = []
      },
    }
  }

  /** Head of an atomic replay view: high-water + snapshot from one snapshot. */
  private async readReplayHead(docId: string): Promise<{ highWater: number; snapshot: RelaySnapshot | null }> {
    return this.inConsistentSnapshot(async (tx) => {
      const highWater = await pptRelaySeqRepo.currentSeqTx(tx, docId)
      const snap = await pptLiveSnapshotRepo.getTx(tx, docId)
      const snapshot: RelaySnapshot | null = snap
        ? { snapshotVersion: snap.snapshotVersion, coveredSeq: snap.coveredSeq, doc: snap.doc, state: snap.state }
        : null
      return { highWater, snapshot }
    })
  }

  /**
   * One op page from a FRESH consistent snapshot, plus the prune-race guard: if a
   * concurrent snapshot has advanced `covered_seq` past `cursor`, ops in
   * `(cursor, covered]` may have been physically pruned, so the reader must
   * restart from the new snapshot rather than skip them (P1-4 / P1-B).
   */
  private async readReplayPage(
    docId: string,
    cursor: number,
    headCovered: number,
    pageRows: number,
    highWater: number,
  ): Promise<{ rows: PersistedOp[] }> {
    return this.inConsistentSnapshot(async (tx) => {
      const snap = await pptLiveSnapshotRepo.getTx(tx, docId)
      // Fire only for a snapshot NEWER than the one the head read already
      // delivered (`coveredSeq > headCovered`) that also covers ops we have not
      // yet fetched (`coveredSeq > cursor`). A snapshot at or below `headCovered`
      // is the one we already sent — the ops it pruned are subsumed by it, so
      // the reader legitimately skips them; only a newer prune could delete
      // un-delivered ops (P1-4 / P1-B).
      if (snap && snap.coveredSeq > headCovered && snap.coveredSeq > cursor) {
        throw new RetryableStorageError('replay superseded by a concurrent snapshot prune')
      }
      // Pin the paged read at the head high-water captured when replay opened
      // (inclusive). Each page runs in its own consistent-snapshot transaction and
      // would otherwise observe ops committed by live writers AFTER open, so in an
      // actively-written room the cursor would never drain and `ready` would never
      // fire (XIN-1783 P1-4). Post-head ops reach the client through the live
      // buffer / cutover path instead.
      const rows = await pptCollabOpRepo.sinceTx(tx, docId, cursor, pageRows, highWater)
      return { rows: rows.map((o) => ({ seq: o.seq, frameId: o.frameId, frame: o.frame, frameBytes: o.frameBytes })) }
    })
  }

  /** Run `fn` in a short REPEATABLE READ consistent-snapshot transaction on a
   * dedicated connection, releasing it (never held across caller I/O). */
  private async inConsistentSnapshot<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const conn = await getPool().getConnection()
    const tx: Tx = {
      async query<T2>(sql: string, params: unknown[] = []): Promise<T2[]> {
        const [rows] = await conn.execute(sql, params as never[])
        return rows as T2[]
      },
    }
    try {
      // Transaction-control statements MUST go through the TEXT protocol
      // (`conn.query`), not the prepared-statement protocol (`conn.execute`):
      // `START TRANSACTION WITH CONSISTENT SNAPSHOT` is not in MySQL 8's
      // prepared-statement grammar and `execute()` rejects it with
      // `ER_UNSUPPORTED_PS` (1295) on a real engine — a non-transient error that
      // `withStoreRetry` rethrows, so the relay maps it to a NON-retryable
      // `storage-failed` and closes the socket, breaking durable replay on every
      // hello/late-join/reconnect (P1-4). The in-memory fake routed `execute`
      // straight through its `query` model, so it could never surface this; the
      // real-MySQL integration suite (XIN-1740) pins it. `SET TRANSACTION
      // ISOLATION LEVEL` IS accepted on the prepared path, but is issued via
      // `query()` too so the whole transaction-control preamble is uniform.
      await conn.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
      await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT')
      const result = await fn(tx)
      await conn.commit()
      return result
    } catch (err) {
      try {
        await conn.rollback()
      } catch {
        /* ignore rollback failure */
      }
      throw err
    } finally {
      conn.release()
    }
  }

  async readReplay(docId: string, sinceSeq: number, pageSize: number): Promise<ReplayView> {
    return transaction(async (tx) => {
      const highWater = await pptRelaySeqRepo.currentSeqTx(tx, docId)
      const snap = await pptLiveSnapshotRepo.getTx(tx, docId)
      const snapshot: RelaySnapshot | null = snap
        ? { snapshotVersion: snap.snapshotVersion, coveredSeq: snap.coveredSeq, doc: snap.doc, state: snap.state }
        : null
      const ops: PersistedOp[] = []
      let cursor = sinceSeq
      for (;;) {
        const page = await pptCollabOpRepo.sinceTx(tx, docId, cursor, pageSize)
        for (const row of page) ops.push({ seq: row.seq, frameId: row.frameId, frame: row.frame, frameBytes: row.frameBytes })
        if (page.length < pageSize) break
        cursor = page[page.length - 1]!.seq
      }
      return { highWater, snapshot, ops }
    })
  }

  async pruneOpsThrough(docId: string, coveredSeq: number): Promise<number> {
    // The dedup ledger (`ppt_collab_frame`) is written at APPEND time, so a prune
    // no longer has to copy mappings out of `ppt_collab_op` first: it is a plain
    // `DELETE`. Dropping the old `INSERT IGNORE … SELECT` also drops the shared
    // next-key locks it took over the gap above `coveredSeq`, which used to block a
    // concurrent append there into `ER_LOCK_WAIT_TIMEOUT` (XIN-1660 D2).
    return withStoreRetry('pruneOpsThrough', () => transaction((tx) => pptCollabOpRepo.pruneThroughTx(tx, docId, coveredSeq)))
  }
}
