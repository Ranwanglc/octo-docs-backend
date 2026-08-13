-- Upgrade migration: add ppt_live_snapshot sync-state columns (R4-B1 XIN-1759 Part B)
--
-- WHAT: adds three NULLABLE columns to `ppt_live_snapshot` so the server-side
--   snapshotter can persist the Bento SyncState ATOMICALLY alongside the doc and
--   covered_seq:
--     - state_json  MEDIUMTEXT NULL : serialized SyncStateJSON (version vector /
--                    registers / positions / births / tombs / text generations /
--                    stash / limbo) the doc was reduced to
--     - state_sha   CHAR(64)   NULL : sha256(hex) of state_json
--     - state_bytes INT NOT NULL DEFAULT 0 : byte size of state_json (0 when NULL)
--
-- WHY: a late joiner needs BOTH doc AND state to deterministically apply the ops
--   that follow the snapshot boundary (seq > covered_seq); the doc alone cannot
--   converge concurrent edits against it (XIN-1764 Option 2). The columns are
--   nullable so an existing doc-only row (written before this migration) stays
--   valid and the relay replays it doc-only until the snapshotter next rewrites it.
--
-- SAFETY: idempotent / re-runnable via information_schema guards. MySQL 8 lacks
--   ADD COLUMN IF NOT EXISTS, so each ADD COLUMN is guarded; re-running is a no-op
--   (guard hit -> skip). Adds only nullable / defaulted columns to a PPT-owned
--   table, so it never rewrites existing row data and touches no other path.
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-08-08-ppt-live-snapshot-sync-state.sql

DELIMITER //

DROP PROCEDURE IF EXISTS octo_add_ppt_live_snapshot_sync_state //

CREATE PROCEDURE octo_add_ppt_live_snapshot_sync_state()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name   = 'ppt_live_snapshot'
      AND column_name  = 'state_json'
  ) THEN
    ALTER TABLE ppt_live_snapshot
      ADD COLUMN state_json MEDIUMTEXT NULL DEFAULT NULL AFTER doc_bytes;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name   = 'ppt_live_snapshot'
      AND column_name  = 'state_sha'
  ) THEN
    ALTER TABLE ppt_live_snapshot
      ADD COLUMN state_sha CHAR(64) NULL DEFAULT NULL AFTER state_json;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name   = 'ppt_live_snapshot'
      AND column_name  = 'state_bytes'
  ) THEN
    ALTER TABLE ppt_live_snapshot
      ADD COLUMN state_bytes INT NOT NULL DEFAULT 0 AFTER state_sha;
  END IF;
END //

DELIMITER ;

CALL octo_add_ppt_live_snapshot_sync_state();

DROP PROCEDURE IF EXISTS octo_add_ppt_live_snapshot_sync_state;
