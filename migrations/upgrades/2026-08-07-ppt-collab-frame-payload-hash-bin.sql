-- Upgrade migration: harden PPT relay frame-id dedup identity.
--
-- Adds a canonical payload hash to the durable frame ledger so a duplicate
-- frame_id is idempotent only when the payload is identical, and makes frame_id
-- comparisons case-sensitive via utf8mb4_bin collation.

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

  ALTER TABLE ppt_collab_frame
    MODIFY frame_id VARCHAR(64)
      CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;

  ALTER TABLE ppt_collab_op
    MODIFY frame_id VARCHAR(64)
      CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;

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
