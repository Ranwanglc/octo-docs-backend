-- Upgrade migration: index the dedup-ledger retention prune predicate (XIN-1825 P2-1)
--
-- WHAT: add a secondary key `idx_ppt_collab_frame_doc_seq (doc_id, seq)` to
--   `ppt_collab_frame`, idempotently (skip if an equivalent index already exists).
--
-- WHY: the retention prune `DELETE FROM ppt_collab_frame WHERE doc_id = ? AND
--   seq <= ?` (XIN-1821 P1-4, run inside `DbPptRelayStore.pruneOpsThrough`) has no
--   index for its `seq` predicate — the table's only key is `PRIMARY KEY
--   (doc_id, frame_id)`. So the DELETE range-scans the doc's WHOLE PK partition and
--   filters `seq` in the server, taking next-key locks over every row it examines
--   plus the gaps. Once a doc passes the retention window (~262k seqs) that is a
--   large lock footprint held inside the SAME transaction as the op prune and the
--   room chain. `(doc_id, seq)` turns the DELETE into a bounded index range scan that
--   locks only the reclaimed prefix. This is the same lock class the append-time
--   authority migration removed from the prune path; the retention DELETE reopened
--   it without an index.
--
-- SAFETY: idempotent / re-runnable. Guarded on `information_schema.statistics` so an
--   index with this name is never re-created (matching the runner's at-least-once
--   contract). Adding a secondary index is an in-place `ALTER` on modern InnoDB
--   (`ALGORITHM=INPLACE`, no table rebuild); on a fresh install `schema.sql` already
--   declares the key, so this guard short-circuits to a pure no-op.
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-08-09-ppt-collab-frame-seq-retention-index.sql

DELIMITER //

DROP PROCEDURE IF EXISTS octo_ppt_collab_frame_seq_index_guard //

CREATE PROCEDURE octo_ppt_collab_frame_seq_index_guard()
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = 'ppt_collab_frame'
       AND index_name = 'idx_ppt_collab_frame_doc_seq'
  ) THEN
    ALTER TABLE ppt_collab_frame
      ADD KEY idx_ppt_collab_frame_doc_seq (doc_id, seq);
  END IF;
END //

CALL octo_ppt_collab_frame_seq_index_guard() //

DROP PROCEDURE IF EXISTS octo_ppt_collab_frame_seq_index_guard //

DELIMITER ;
