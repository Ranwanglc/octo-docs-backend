-- Upgrade migration: harden PPT relay frame-id dedup identity.
--
-- Adds a canonical payload hash to the durable frame ledger so a duplicate
-- frame_id is idempotent only when the payload is identical, and makes frame_id
-- comparisons case-sensitive via utf8mb4_bin collation.
--
-- SAFETY (XIN-1776): every DDL statement in this procedure is information_schema
-- guarded so the file is safely re-runnable (per `src/db/migrate.ts` execution
-- contract — "execute-then-record" is non-atomic in MySQL, so a crash between
-- the two leaves the SQL applied but unrecorded; the next deploy re-executes
-- the file. First adoption over an empty ledger on a hand-migrated DB does the
-- same). `ALTER TABLE ... MODIFY` forces ALGORITHM=COPY (rebuilds the table
-- under a metadata lock) on InnoDB, so running it when `frame_id` is already
-- `utf8mb4_bin` is both unnecessary and expensive on a large legacy DB (~96MB
-- per-room budget). The `collation_name <> 'utf8mb4_bin'` guards skip it.

DELIMITER //

DROP PROCEDURE IF EXISTS octo_ppt_collab_frame_identity //

CREATE PROCEDURE octo_ppt_collab_frame_identity()
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'ppt_collab_frame'
       AND column_name = 'payload_hash'
  ) THEN
    ALTER TABLE ppt_collab_frame
      ADD COLUMN payload_hash CHAR(64) NULL AFTER seq;
  END IF;

  -- Guarded collation change for ppt_collab_frame.frame_id (utf8mb4_bin for
  -- case-sensitive frame_id dedup). Skip when the column is already
  -- utf8mb4_bin so a re-run (crash/recovery or first-adoption over an
  -- already-migrated DB) does NOT trigger an ALGORITHM=COPY rebuild.
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'ppt_collab_frame'
       AND column_name = 'frame_id'
       AND collation_name <> 'utf8mb4_bin'
  ) THEN
    ALTER TABLE ppt_collab_frame
      MODIFY frame_id VARCHAR(64)
        CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;
  END IF;

  -- Guarded collation change for ppt_collab_op.frame_id, same rationale.
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'ppt_collab_op'
       AND column_name = 'frame_id'
       AND collation_name <> 'utf8mb4_bin'
  ) THEN
    ALTER TABLE ppt_collab_op
      MODIFY frame_id VARCHAR(64)
        CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;
  END IF;

  UPDATE ppt_collab_frame f
    JOIN ppt_collab_op o
      ON o.doc_id = f.doc_id
     AND o.frame_id = f.frame_id
     AND o.seq = f.seq
     SET f.payload_hash = SHA2(o.frame_json, 256)
   WHERE f.payload_hash IS NULL;
END //

CALL octo_ppt_collab_frame_identity() //

DROP PROCEDURE IF EXISTS octo_ppt_collab_frame_identity //

DELIMITER ;
