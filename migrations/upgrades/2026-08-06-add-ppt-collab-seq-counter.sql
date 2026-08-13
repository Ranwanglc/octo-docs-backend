-- Upgrade migration: Bento PPT (`html_ppt`) R4-B1 relay per-room seq counter (XIN-1647)
--
-- WHAT: adds the relay-owned durable sequence counter the Bento-frame WS relay
--   uses to allocate the per-room op sequence:
--     - ppt_collab_seq : one row per room; `last_seq` is the highest op seq ever
--                        ASSIGNED for that room (monotonic, never regresses).
--   A new table that touches no existing table, so there is no risk to the
--   legacy doc/sheet/board/html paths or the R2/R3/earlier-R4 PPT paths.
--
--   WHY (relay correctness the counter backs, §7.3):
--     - The next seq is allocated by atomically incrementing this row INSIDE the
--       append transaction (INSERT ... ON DUPLICATE KEY UPDATE last_seq+1). A
--       brand-new room therefore has a row to lock on the very first append, so
--       two concurrent first writers can no longer both compute seq=1 and have
--       one insert permanently refused on the (doc_id, seq) primary key.
--     - The counter is decoupled from ppt_collab_op contents, so a full-coverage
--       snapshot that prunes every op row does NOT reset the sequence to 1 (a
--       reused seq would silently drop the op on replay). last_seq only ever
--       advances.
--
-- SAFETY: idempotent / re-runnable. `CREATE TABLE IF NOT EXISTS` is a no-op on a
--   re-run (guard hit -> skip), matching the migration runner's at-least-once
--   execution contract. Existing rooms created before this migration have no
--   counter row yet; the first append after upgrade seeds it (INSERT path), and
--   the relay's read path treats an absent row as last_seq=0.
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-08-06-add-ppt-collab-seq-counter.sql

CREATE TABLE IF NOT EXISTS ppt_collab_seq (
  doc_id   VARCHAR(64) NOT NULL,                          -- FK-by-convention to doc_meta.doc_id (html_ppt row)
  last_seq BIGINT      NOT NULL DEFAULT 0,                -- highest op seq ever assigned for this room (monotonic)
  PRIMARY KEY (doc_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
