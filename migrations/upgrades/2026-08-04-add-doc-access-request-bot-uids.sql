-- Add bot_uids to doc_access_request: a JSON array of the bot uids the requester
-- chose to include (bots they own in the doc's Space at submit time). On approval
-- each snapshotted bot is granted the SAME role as the human via forward-grant.
-- NULL / '[]' = zero-bot case (backward compatible: grants only the human). The
-- backend fail-closes a corrupt/hand-edited value to [] on read (authorizes
-- nothing) rather than erroring. JSON, not a child table: small (<=50), read/
-- written whole, never queried by element.
--
-- SAFETY: idempotent / re-runnable. MySQL 8 lacks ADD COLUMN IF NOT EXISTS, so
-- the ALTER is guarded by an information_schema check in a throwaway procedure
-- (same convention as 2026-07-20-add-doc-access-request-decision-note.sql) —
-- re-running is a no-op, not ERROR 1060.
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-08-04-add-doc-access-request-bot-uids.sql

DELIMITER //

DROP PROCEDURE IF EXISTS octo_add_doc_access_request_bot_uids //

CREATE PROCEDURE octo_add_doc_access_request_bot_uids()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name   = 'doc_access_request'
      AND column_name  = 'bot_uids'
  ) THEN
    ALTER TABLE doc_access_request
      ADD COLUMN bot_uids JSON NULL AFTER decision_note;
  END IF;
END //

CALL octo_add_doc_access_request_bot_uids() //

DROP PROCEDURE IF EXISTS octo_add_doc_access_request_bot_uids //

DELIMITER ;
