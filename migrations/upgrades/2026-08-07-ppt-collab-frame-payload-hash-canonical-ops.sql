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
--   rewritten in one lock-heavy statement (P2-c). A re-run only matches rows whose
--   `payload_hash IS NOT NULL`; migrate.ts starts the app AFTER migrations
--   complete, so no canonical-scheme rows exist yet when this runs, and a
--   crash-recovery re-run re-nulls the same set. On a fresh install the ledger is
--   empty, so this is a pure no-op.
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-08-07-ppt-collab-frame-payload-hash-canonical-ops.sql

DELIMITER //

DROP PROCEDURE IF EXISTS octo_ppt_collab_frame_retire_envelope_hash //

CREATE PROCEDURE octo_ppt_collab_frame_retire_envelope_hash()
BEGIN
  DECLARE v_rows BIGINT DEFAULT 1;

  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  -- Batch the rewrite so a large ledger is not nulled in one lock-heavy UPDATE.
  retire_loop: LOOP
    START TRANSACTION;
    UPDATE ppt_collab_frame
       SET payload_hash = NULL
     WHERE payload_hash IS NOT NULL
     LIMIT 2000;
    SET v_rows = ROW_COUNT();
    COMMIT;
    IF v_rows = 0 THEN
      LEAVE retire_loop;
    END IF;
  END LOOP;
END //

CALL octo_ppt_collab_frame_retire_envelope_hash() //

DROP PROCEDURE IF EXISTS octo_ppt_collab_frame_retire_envelope_hash //

DELIMITER ;
