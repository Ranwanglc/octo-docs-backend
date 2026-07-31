-- Hard-cutover migration for persisted document roles:
-- v1: 1=reader,2=writer,3=admin; v2: 1=reader,2=commenter,3=writer,4=admin.
-- Stop role-reading/writing application instances before running this file.
-- Row values overlap and are deliberately never used to infer the encoding.

DELIMITER //

DROP PROCEDURE IF EXISTS octo_recode_doc_roles //

CREATE PROCEDURE octo_recode_doc_roles()
main: BEGIN
  DECLARE metadata_table_exists INT DEFAULT 0;
  DECLARE encoding_value VARCHAR(128) DEFAULT NULL;
  DECLARE member_check_state TINYINT DEFAULT -1;
  DECLARE invite_check_state TINYINT DEFAULT -1;
  DECLARE request_check_state TINYINT DEFAULT -1;

  SELECT COUNT(*) INTO metadata_table_exists
    FROM information_schema.tables
   WHERE table_schema = DATABASE() AND table_name = 'octo_schema_metadata';

  IF metadata_table_exists = 1 THEN
    SELECT MAX(metadata_value) INTO encoding_value
      FROM octo_schema_metadata WHERE metadata_key = 'doc_role_encoding';
  END IF;

  -- A recorded v2 database is an exact no-op, including its constraints.
  IF encoding_value = 'v2' THEN
    LEAVE main;
  END IF;
  IF encoding_value IS NOT NULL AND encoding_value <> 'v1' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'unknown doc_role_encoding; migration aborted';
  END IF;

  -- State: 0=missing, 1=exact v1, 2=exact v2. Validate every named constraint
  -- before mutation so a name collision or unknown domain always fails closed.
  SELECT CASE
      WHEN COUNT(*) = 0 THEN 0
      WHEN COUNT(*) = 1 AND MAX(REPLACE(REPLACE(LOWER(cc.check_clause),' ',''),'`',''))
        IN ('rolein(1,2,3)','(rolein(1,2,3))') THEN 1
      WHEN COUNT(*) = 1 AND MAX(REPLACE(REPLACE(LOWER(cc.check_clause),' ',''),'`',''))
        IN ('rolein(1,2,3,4)','(rolein(1,2,3,4))') THEN 2
      ELSE -1 END INTO member_check_state
    FROM information_schema.table_constraints tc
    JOIN information_schema.check_constraints cc
      ON cc.constraint_schema = tc.constraint_schema
     AND cc.constraint_name = tc.constraint_name
   WHERE tc.table_schema = DATABASE()
     AND tc.table_name = 'doc_member'
     AND tc.constraint_name = 'chk_doc_member_role';

  SELECT CASE
      WHEN COUNT(*) = 0 THEN 0
      WHEN COUNT(*) = 1 AND MAX(REPLACE(REPLACE(LOWER(cc.check_clause),' ',''),'`',''))
        IN ('rolein(1,2,3)','(rolein(1,2,3))') THEN 1
      WHEN COUNT(*) = 1 AND MAX(REPLACE(REPLACE(LOWER(cc.check_clause),' ',''),'`',''))
        IN ('rolein(1,2,3,4)','(rolein(1,2,3,4))') THEN 2
      ELSE -1 END INTO invite_check_state
    FROM information_schema.table_constraints tc
    JOIN information_schema.check_constraints cc
      ON cc.constraint_schema = tc.constraint_schema
     AND cc.constraint_name = tc.constraint_name
   WHERE tc.table_schema = DATABASE()
     AND tc.table_name = 'doc_invite'
     AND tc.constraint_name = 'chk_doc_invite_role';

  SELECT CASE
      WHEN COUNT(*) = 0 THEN 0
      WHEN COUNT(*) = 1 AND MAX(REPLACE(REPLACE(LOWER(cc.check_clause),' ',''),'`',''))
        IN ('requested_rolein(1,2)','(requested_rolein(1,2))') THEN 1
      WHEN COUNT(*) = 1 AND MAX(REPLACE(REPLACE(LOWER(cc.check_clause),' ',''),'`',''))
        IN ('requested_rolein(1,2,3)','(requested_rolein(1,2,3))') THEN 2
      ELSE -1 END INTO request_check_state
    FROM information_schema.table_constraints tc
    JOIN information_schema.check_constraints cc
      ON cc.constraint_schema = tc.constraint_schema
     AND cc.constraint_name = tc.constraint_name
   WHERE tc.table_schema = DATABASE()
     AND tc.table_name = 'doc_access_request'
     AND tc.constraint_name = 'chk_doc_access_request_role';

  IF member_check_state < 0 OR invite_check_state < 0 OR request_check_state < 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'unknown role CHECK domain or name collision; migration aborted';
  END IF;
  IF encoding_value IS NULL AND NOT (
    member_check_state = 1 AND invite_check_state = 1 AND request_check_state = 1
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ambiguous doc role encoding; migration aborted';
  END IF;

  -- Validation above precedes every mutation. DDL necessarily commits in MySQL;
  -- after checks are replaced, the DML and authoritative v2 marker commit together.
  CREATE TABLE IF NOT EXISTS octo_schema_metadata (
    metadata_key VARCHAR(128) NOT NULL,
    metadata_value VARCHAR(128) NOT NULL,
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (metadata_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

  INSERT INTO octo_schema_metadata (metadata_key, metadata_value)
    VALUES ('doc_role_encoding','v1')
    ON DUPLICATE KEY UPDATE metadata_value = VALUES(metadata_value);

  IF member_check_state = 1 THEN
    ALTER TABLE doc_member DROP CHECK chk_doc_member_role;
  END IF;
  IF member_check_state <> 2 THEN
    ALTER TABLE doc_member ADD CONSTRAINT chk_doc_member_role CHECK (role IN (1,2,3,4));
  END IF;

  IF invite_check_state = 1 THEN
    ALTER TABLE doc_invite DROP CHECK chk_doc_invite_role;
  END IF;
  IF invite_check_state <> 2 THEN
    ALTER TABLE doc_invite ADD CONSTRAINT chk_doc_invite_role CHECK (role IN (1,2,3,4));
  END IF;

  IF request_check_state = 1 THEN
    ALTER TABLE doc_access_request DROP CHECK chk_doc_access_request_role;
  END IF;
  IF request_check_state <> 2 THEN
    ALTER TABLE doc_access_request ADD CONSTRAINT chk_doc_access_request_role CHECK (requested_role IN (1,2,3));
  END IF;

  START TRANSACTION;
    UPDATE doc_member SET role = CASE role WHEN 3 THEN 4 WHEN 2 THEN 3 ELSE role END
      WHERE role IN (2,3);
    UPDATE doc_invite SET role = CASE role WHEN 3 THEN 4 WHEN 2 THEN 3 ELSE role END
      WHERE role IN (2,3);
    UPDATE doc_access_request SET requested_role = 3 WHERE requested_role = 2;
    INSERT INTO octo_schema_metadata (metadata_key, metadata_value)
      VALUES ('doc_role_encoding','v2')
      ON DUPLICATE KEY UPDATE metadata_value = VALUES(metadata_value);
  COMMIT;

END //

DELIMITER ;

CALL octo_recode_doc_roles();
DROP PROCEDURE IF EXISTS octo_recode_doc_roles;
