-- Upgrade migration: retire the whole-envelope PPT frame payload hash (XIN-1736 P1-A).
--
-- WHAT: nulls out `ppt_collab_frame.payload_hash` for every existing row, in
--   bounded batches.
--
-- WHY: the payload hash is the idempotent-resend identity — a resend of the SAME
--   frameId is re-acked only when its payload hash matches, otherwise it is
--   refused `protocol-version` (non-retryable). The previous relay hashed the
--   WHOLE wire envelope (`t`, `pv`, `k`, `frameId`, `epoch`, `ops`) with
--   key-order-dependent JSON, and the sibling migration
--   `2026-08-07-ppt-collab-frame-payload-hash-bin.sql` backfilled existing rows
--   with `SHA2(o.frame_json, 256)` — the whole stored frame JSON. Both are the
--   RETIRED scheme. The relay now hashes the canonical `ops` array ONLY
--   (`canonicalPayloadHash`, src/ppt/relay/store.ts), so a legitimate resend of a
--   committed edit that carries a new `epoch` (after a permission-epoch bump) or a
--   different JSON key order re-acks instead of being permanently refused. A row
--   still carrying a whole-envelope hash would MISMATCH that canonical-ops hash on
--   the very next resend and be wrongly refused, so those hashes must not survive.
--
--   Nulling (rather than recomputing in SQL) is deliberate: MySQL cannot reproduce
--   the relay's JS canonicalization (stable key order, number formatting) to
--   recompute the canonical-ops hash. A NULL hash routes the resend through the
--   relay's P2-d fallback (dbStore `resolveDuplicate`): when the op row still
--   exists it is VERIFIED against the stored `frame_json`'s canonical ops (re-ack
--   on match, refuse on a genuine payload difference); when the op row was already
--   pruned it fails closed (the round-10 "NULL legacy rows fail closed"
--   invariant recorded in schema.sql). New frames written after this deploy record
--   the canonical-ops hash and take the fast hash path.
--
--   This is a SEPARATE, idempotent migration, NOT an edit to the already-applied
--   `-payload-hash-bin` file: the runner records each applied file's checksum and
--   HALTS on drift (`Migration checksum mismatch ...`, migrate.ts), so editing an
--   applied file would break migration on the dev/staging DBs that ran it. It
--   sorts AFTER `-payload-hash-bin` (…-payload-hash-bin < …-payload-hash-canonical)
--   so the retired backfill's values are already present to be nulled.
--
-- SAFETY: idempotent / re-runnable, batched. The UPDATE is chunked
--   (`LIMIT`-bounded) inside a throwaway procedure so a large ledger is not
--   rewritten in one lock-heavy statement (P2-c). It only ever nulls rows whose
--   `payload_hash IS NOT NULL` AND that are provably RETIRED whole-envelope hashes
--   (see the two-arm predicate below); migrate.ts starts the app AFTER migrations
--   complete, so on a genuine upgrade no canonical-scheme row exists yet when this
--   runs, and a crash-recovery re-run re-nulls the same set. On a fresh install the
--   ledger is empty, so this is a pure no-op.
--
-- P1-3 (XIN-1772) — DO NOT NULL LIVE CANONICAL HASHES ON THE LEDGER-ADOPTION PATH:
--   `migrate.ts` runs a file whenever `schema_migrations` lacks its row, and
--   "install from schema.sql, adopt the runner later" is a documented supported
--   path. On THAT path the app is ALREADY running the canonical-hash relay and has
--   written live `payload_hash` values — so a guard of merely `payload_hash IS NOT
--   NULL` would null those live hashes, and an already-GC'd op row (no `frame_json`
--   to verify against) would then permanently refuse a legitimate resend of a
--   committed edit (`DuplicateFramePayloadError` → `protocol-version`), the exact
--   "left permanently unsynced" failure XIN-1750 prevents.
--
--   IDENTIFY THE RETIRED HASH BY VALUE, NOT BY TIMESTAMP (XIN-1826 RC fix). The
--   earlier revision nulled solely on `recorded_at < @cutoff`. That marker LEAKS:
--   `2026-08-07-backfill-ppt-collab-frame-ledger.sql` inserts a ledger row for
--   every pre-existing op row with NO explicit timestamp, so `recorded_at` defaults
--   to the migration's execution time — and `-payload-hash-bin.sql` then stamps the
--   RETIRED whole-envelope hash `SHA2(frame_json,256)` onto those rows. Any env that
--   applies these migrations ON/AFTER the cutoff while `ppt_collab_op` already has
--   rows ends up with backfilled ledger rows carrying `recorded_at >= @cutoff` AND a
--   retired whole-envelope hash — which the timestamp-only guard NEVER nulls, so the
--   runtime treats the stale whole-envelope hash as a canonical-ops identity and
--   permanently refuses a legitimate resend as `protocol-version` (pptRelay.ts /
--   dbStore.ts). That is the very "left permanently unsynced" regression this
--   migration exists to prevent.
--
--   So the null is now driven by two OR-ed arms, guaranteeing every retired hash is
--   removed at ANY timestamp while a live canonical hash is provably preserved:
--     Arm A (VALUE match, timestamp-independent): the row JOINs an existing
--       `ppt_collab_op` row on (doc_id, frame_id, seq) AND its stored `payload_hash`
--       EQUALS `SHA2(o.frame_json, 256)`. By construction that is the retired
--       whole-envelope hash `-payload-hash-bin.sql` wrote, so it is nulled whatever
--       its `recorded_at`. It CANNOT touch a live canonical hash: the relay stores
--       `canonicalPayloadHash(ops)` (sha256 of the canonical `ops` array only,
--       src/ppt/relay/store.ts), which does not equal `SHA2(frame_json)` — the whole
--       stored envelope — except by cryptographic collision. This arm is what closes
--       the backfilled-after-cutoff gap.
--     Arm B (pruned-op fallback, timestamp-guarded): the op row is already GONE (the
--       SHA2 join cannot confirm the value) AND `recorded_at < @cutoff`. Such a row
--       predates the canonical-hash relay, so its non-null hash can only be a retired
--       whole-envelope hash; nulling it is safe. The `recorded_at < @cutoff` guard is
--       retained on THIS arm alone so the adoption path never nulls a live canonical
--       hash whose op row was already GC'd — those are written by the post-release
--       app and carry `recorded_at >= @cutoff`, so neither arm fires and they are
--       preserved. `@cutoff` is a FIXED literal set to this migration's release date.
--   A genuine upgrade may still leave a bounded window of pruned-op whole-envelope
--   rows written between the cutoff and the deploy un-nulled; those degrade to a
--   `protocol-version` refusal on resend (client resyncs — recoverable), never data
--   loss. Real-MySQL verification of BOTH paths is routed to the integration gate
--   (PR #163); the tokenizer-level regression in test/pptSchemaContract.test.ts pins
--   the corrected two-arm predicate and Jerry's exact after-cutoff backfill gap.
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-08-07-ppt-collab-frame-payload-hash-canonical-ops.sql

DELIMITER //

DROP PROCEDURE IF EXISTS octo_ppt_collab_frame_retire_envelope_hash //

CREATE PROCEDURE octo_ppt_collab_frame_retire_envelope_hash()
BEGIN
  -- Seek (keyset) cursor over the composite primary key (doc_id, frame_id).
  -- v_first guards the very first window: before any real key has been seen the
  -- lower bound is "everything", so we skip the `> cursor` predicate rather than
  -- rely on a sentinel value that would have to sort below every real key
  -- (frame_id is utf8mb4_bin, so a naive '' sentinel is fragile). v_done is set
  -- by the NOT FOUND handler when a window SELECT returns no row.
  DECLARE v_first TINYINT DEFAULT 1;
  DECLARE v_done  TINYINT DEFAULT 0;
  DECLARE v_last_doc    VARCHAR(64) CHARACTER SET utf8mb4;
  DECLARE v_last_frame  VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
  DECLARE v_batch_doc   VARCHAR(64) CHARACTER SET utf8mb4;
  DECLARE v_batch_frame VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

  -- Release boundary (P1-3), used ONLY by Arm B (pruned-op fallback) below. A
  -- pruned-op row recorded BEFORE this predates the canonical-hash relay, so its
  -- non-null hash can only be a retired whole-envelope hash. Live canonical hashes
  -- (adoption path) are written by the post-release app at/after this date, so a
  -- pruned-op live-hash row is preserved. Retired hashes whose op row still exists
  -- are caught by value (Arm A) regardless of this boundary — see the two-arm
  -- predicate below (XIN-1826).
  DECLARE v_cutoff DATETIME(3) DEFAULT '2026-08-07 00:00:00.000';

  -- A window SELECT that finds no more rows raises NOT FOUND (SQLSTATE 02000),
  -- which is NOT a SQLEXCEPTION and so does not trip the rollback handler below.
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_done = 1;

  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  -- KEYSET (seek) pagination over (doc_id, frame_id), NOT the previous
  -- OFFSET-free `ORDER BY ... LIMIT 2000` scan.
  --
  -- WHY: the old batch loop re-scanned/sorted from the start of the
  -- (doc_id, frame_id) index on EVERY iteration to find the next non-null rows,
  -- making the whole retire O(N^2) on a large ledger. Here each batch resumes
  -- STRICTLY AFTER the last key touched by the previous batch, so every row is
  -- visited once and the total work is O(N). Advancement is driven by the KEY,
  -- never by the `payload_hash IS NOT NULL` filter, so a window full of
  -- already-null rows still moves the cursor forward and the loop cannot stall or
  -- rescan. It stays deterministic under both row- and statement-based binlog:
  -- each UPDATE targets a closed key window `(cursor, batch_max]` (no bare
  -- `LIMIT` on the UPDATE), so the replicated statement rewrites exactly the same
  -- rows regardless of physical row order.
  retire_loop: LOOP
    -- Boundary probe: the max key of the NEXT up-to-2000 rows after the cursor.
    -- Take up to 2000 rows in ascending key order, then pick the largest key of
    -- that window (its last row). This works for both a full 2000-row batch and
    -- the final partial batch; NOT FOUND (no rows left) sets v_done.
    SET v_done = 0;
    IF v_first = 1 THEN
      SELECT w.doc_id, w.frame_id
        INTO v_batch_doc, v_batch_frame
        FROM (
          SELECT doc_id, frame_id
            FROM ppt_collab_frame
           ORDER BY doc_id, frame_id
           LIMIT 2000
        ) AS w
       ORDER BY w.doc_id DESC, w.frame_id DESC
       LIMIT 1;
    ELSE
      SELECT w.doc_id, w.frame_id
        INTO v_batch_doc, v_batch_frame
        FROM (
          SELECT doc_id, frame_id
            FROM ppt_collab_frame
           WHERE doc_id > v_last_doc
              OR (doc_id = v_last_doc AND frame_id > v_last_frame)
           ORDER BY doc_id, frame_id
           LIMIT 2000
        ) AS w
       ORDER BY w.doc_id DESC, w.frame_id DESC
       LIMIT 1;
    END IF;

    IF v_done = 1 THEN
      LEAVE retire_loop;
    END IF;

    -- Null the RETIRED whole-envelope hashes inside this batch's closed key window
    -- (cursor, batch_max]. Transaction-per-batch keeps each rewrite short-lived.
    -- The two OR-ed arms (see the P1-3 header): Arm A nulls by VALUE match against
    -- the joined op row (retired hash at ANY recorded_at; cannot hit a live
    -- canonical hash); Arm B nulls a pre-cutoff row whose op was already pruned and
    -- so cannot be value-confirmed. The key-window bounds drive cursor advancement,
    -- never the hash predicate, so a window of all-preserved rows still progresses.
    START TRANSACTION;
    IF v_first = 1 THEN
      UPDATE ppt_collab_frame f
         SET f.payload_hash = NULL
       WHERE f.payload_hash IS NOT NULL
         AND (
              EXISTS (
                SELECT 1 FROM ppt_collab_op o
                 WHERE o.doc_id = f.doc_id
                   AND o.frame_id = f.frame_id
                   AND o.seq = f.seq
                   AND f.payload_hash = SHA2(o.frame_json, 256)
              )
              OR (
                f.recorded_at < v_cutoff
                AND NOT EXISTS (
                  SELECT 1 FROM ppt_collab_op o
                   WHERE o.doc_id = f.doc_id
                     AND o.frame_id = f.frame_id
                     AND o.seq = f.seq
                )
              )
         )
         AND (f.doc_id < v_batch_doc
              OR (f.doc_id = v_batch_doc AND f.frame_id <= v_batch_frame));
    ELSE
      UPDATE ppt_collab_frame f
         SET f.payload_hash = NULL
       WHERE f.payload_hash IS NOT NULL
         AND (
              EXISTS (
                SELECT 1 FROM ppt_collab_op o
                 WHERE o.doc_id = f.doc_id
                   AND o.frame_id = f.frame_id
                   AND o.seq = f.seq
                   AND f.payload_hash = SHA2(o.frame_json, 256)
              )
              OR (
                f.recorded_at < v_cutoff
                AND NOT EXISTS (
                  SELECT 1 FROM ppt_collab_op o
                   WHERE o.doc_id = f.doc_id
                     AND o.frame_id = f.frame_id
                     AND o.seq = f.seq
                )
              )
         )
         AND (f.doc_id > v_last_doc
              OR (f.doc_id = v_last_doc AND f.frame_id > v_last_frame))
         AND (f.doc_id < v_batch_doc
              OR (f.doc_id = v_batch_doc AND f.frame_id <= v_batch_frame));
    END IF;
    COMMIT;

    -- Advance the cursor to this batch's max key (strictly ahead of the previous
    -- cursor because every window row was > cursor), guaranteeing progress and
    -- termination once no rows remain beyond it.
    SET v_last_doc = v_batch_doc;
    SET v_last_frame = v_batch_frame;
    SET v_first = 0;
  END LOOP;
END //

CALL octo_ppt_collab_frame_retire_envelope_hash() //

DROP PROCEDURE IF EXISTS octo_ppt_collab_frame_retire_envelope_hash //

DELIMITER ;
