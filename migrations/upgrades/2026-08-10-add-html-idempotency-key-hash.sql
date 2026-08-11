-- Add publisher-scoped canonical HTML idempotency hashes. Re-runnable on MySQL 8.
DELIMITER //
DROP PROCEDURE IF EXISTS octo_add_html_idempotency //
CREATE PROCEDURE octo_add_html_idempotency()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'doc_meta'
      AND column_name = 'html_idempotency_key_hash'
  ) THEN
    ALTER TABLE doc_meta
      ADD COLUMN html_idempotency_key_hash BINARY(32) NULL DEFAULT NULL AFTER octo_doc_slug;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'doc_meta'
      AND index_name = 'uk_html_idempotency'
  ) THEN
    ALTER TABLE doc_meta
      ADD UNIQUE KEY uk_html_idempotency
        (space_id, owner_id, html_idempotency_key_hash, doc_type);
  END IF;
END //
DELIMITER ;
CALL octo_add_html_idempotency();
DROP PROCEDURE IF EXISTS octo_add_html_idempotency;
