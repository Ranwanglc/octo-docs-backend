-- Upgrade migration: PPT relay dedup ledger becomes the APPEND-TIME authority
-- (XIN-1660 D1/D2).
--
-- WHAT: renames `ppt_collab_frame.pruned_at` to `recorded_at`. The dedup ledger is
--   no longer populated by copying rows out of `ppt_collab_op` at PRUNE time; the
--   relay now writes each `(doc_id, frame_id) -> seq` mapping at APPEND time and
--   uses the PRIMARY KEY as the dedup authority. The timestamp therefore records
--   when the mapping was first recorded (append time), not when a prune copied it,
--   so the column name `pruned_at` is now misleading.
--
--   WHY the code change this backs (no schema change is required for correctness —
--   this is a naming/clarity fix that keeps the column honest):
--     - D1: the old append deduped with NON-locking SELECTs (snapshot reads under
--       REPEATABLE READ). A resend whose transaction opened before the original
--       append committed saw neither the op row nor the prune-populated ledger row,
--       minted a fresh seq, and rebroadcast a duplicate — permanent peer divergence
--       for an ins/txt RGA op. Writing the ledger at append time and letting the PK
--       raise ER_DUP_ENTRY makes dedup a CURRENT read.
--     - D2: because the ledger no longer has to be copied at prune, the prune
--       reverts to a plain DELETE, dropping the `INSERT IGNORE ... SELECT` whose
--       shared next-key locks over the gap above covered_seq blocked a concurrent
--       append there into ER_LOCK_WAIT_TIMEOUT.
--
--   This is a SEPARATE migration, not an edit to `2026-08-07-add-ppt-collab-frame-dedup.sql`:
--   the runner records each applied file's checksum and HALTS on drift
--   (`Migration checksum mismatch ...`), so editing the applied file would break
--   migration on the dev/staging DBs that already ran it. A new, idempotent file
--   reaches fresh and already-iterated DBs alike.
--
-- SAFETY: idempotent / re-runnable. MySQL 8 has no `RENAME COLUMN IF EXISTS`, so the
--   rename is guarded behind an information_schema existence check in a throwaway
--   stored procedure — the same convention as the ADD COLUMN migrations
--   (2026-07-20-add-doc-access-request-decision-note.sql). A re-run (or a retry of a
--   partial apply, per migrate.ts's at-least-once contract) is a no-op: the guard
--   only renames when `pruned_at` still exists and `recorded_at` does not. A fresh
--   install created from schema.sql already has `recorded_at`, so the guard skips.
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-08-07-ppt-collab-frame-append-time-authority.sql

DELIMITER //

DROP PROCEDURE IF EXISTS octo_rename_ppt_collab_frame_pruned_at //

CREATE PROCEDURE octo_rename_ppt_collab_frame_pruned_at()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name   = 'ppt_collab_frame'
      AND column_name  = 'pruned_at'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name   = 'ppt_collab_frame'
      AND column_name  = 'recorded_at'
  ) THEN
    ALTER TABLE ppt_collab_frame
      CHANGE COLUMN pruned_at recorded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
  END IF;
END //

CALL octo_rename_ppt_collab_frame_pruned_at() //

DROP PROCEDURE IF EXISTS octo_rename_ppt_collab_frame_pruned_at //

DELIMITER ;
