-- Recode persisted document roles to the ordered 4-level encoding (HTML 四级权限改造).
--
-- WHAT: shifts the stored doc_member.role / doc_invite.role / doc_access_request.
--   requested_role numbers from the old 3-level space (1=reader 2=writer 3=admin)
--   to the new ORDERED 4-level space (1=reader 2=commenter 3=writer 4=admin):
--     writer 2 -> 3   admin 3 -> 4   (reader 1 unchanged; commenter 2 is NEW,
--     never present in old data so nothing maps INTO the vacated 2 during migrate)
--   and rebuilds the matching CHECK constraints. doc_meta.share_role is an
--   INDEPENDENT enum (1=read 2=edit) and is deliberately NOT touched here.
--
-- WHY: the app now reads/writes the ordered 4-level codes. Old code read 2 as
--   writer and 3 as admin; new code reads 2 as commenter, 3 as writer, 4 as admin.
--   Persisted rows written before this batch MUST be recoded once so both meanings
--   never coexist. This is NOT a rolling upgrade (§5): stop old role-interpreting
--   instances, run this, start new instances.
--
-- WHO NEEDS THIS: only EXISTING deployments that already hold doc_member /
--   doc_invite / doc_access_request rows in the OLD encoding AND carry the OLD
--   named CHECKs (which enumerate the old domain and would REJECT the 3->4 bump).
--   Fresh installs get the new encoding + CHECKs directly from migrations/schema.sql;
--   there this file finds no old-domain checks to drop, the recode marker gates the
--   (empty) DML, and the new CHECKs already exist — a guarded no-op.
--
-- SAFETY: idempotent / re-runnable under an AT-LEAST-ONCE runner that records the
--   ledger in a SEPARATE, non-atomic step AFTER the SQL (see src/db/migrate.ts
--   EXECUTION CONTRACT). A crash may re-execute this whole file — including after
--   the old checks were already dropped — so every step is self-guarded:
--
--   1. DROP the OLD named CHECKs FIRST, guarded by information_schema so a re-run
--      (checks already gone) is a no-op. This MUST precede the DML: the old checks
--      enumerate the OLD domain, so the admin 3->4 bump would violate them if they
--      were still installed. MySQL 8 has no DROP CONSTRAINT IF EXISTS, hence the
--      information_schema guard (same convention as 2026-07-14-add-doc-share-scope.sql).
--
--   2. RECODE the numbers exactly ONCE, gated on a persistent progress marker and
--      wrapped with the marker write in a SINGLE TRANSACTION (UPDATE+INSERT are pure
--      DML, so unlike DDL they DO commit atomically). This is the crux of crash
--      safety: a bare `WHERE role IN (2,3)` guard is NOT enough, because after a
--      first run rows are {1,3,4} and a naive re-run would match the freshly written
--      3s (former writers) and double-bump them to 4 (admin) — a silent privilege
--      escalation, made worse now that the old checks have been dropped. The marker
--      row commits in the same transaction as the recode, so re-execution sees the
--      marker and skips the UPDATEs entirely; genuine post-migration commenter(2)
--      rows written by the new app are therefore never touched. The single-CASE
--      remap (HIGH value first) additionally makes 2->3 and 3->4 non-colliding
--      within the one pass.
--
--   3. INSTALL the NEW CHECKs LAST (after the data is in-domain), guarded by
--      information_schema so a re-run is a no-op, not ERROR 3822.
--
-- PRE-FLIGHT (operator, manual): confirm no out-of-enum values BEFORE running:
--     SELECT role, COUNT(*) FROM doc_member GROUP BY role;
--     SELECT role, COUNT(*) FROM doc_invite GROUP BY role;
--     SELECT requested_role, COUNT(*) FROM doc_access_request GROUP BY requested_role;
--   Old-encoding rows must be only IN (1,2,3) / requested_role IN (1,2). Abort on
--   any other value. POST: old writer count == new writer(3) count, old admin
--   count == new admin(4) count.
--
-- COST: three single-CASE UPDATEs (one pass each) inside one transaction + three
--   CHECK adds that VALIDATE existing rows under a brief metadata lock. Schedule in
--   a low-traffic window with role write-traffic paused (§5).
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-07-30-recode-doc-roles.sql

-- ── 0. Persistent progress marker (survives a crash; gates the recode) ────────
-- One-row sentinel table. Its presence-of-row is the "recode already committed"
-- flag; it is written in the SAME transaction as the UPDATEs so the two can never
-- diverge across a crash/re-execution. Kept separate from schema_migrations, which
-- the runner writes only AFTER the whole file succeeds (and not at all on a crash).
CREATE TABLE IF NOT EXISTS octo_recode_doc_roles_progress (
  marker  TINYINT     NOT NULL,
  done_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (marker)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── 1. Drop the OLD-domain named CHECKs (guarded) — MUST precede the DML ──────
--   and 2/3. Do the transactional recode, then reinstall the NEW CHECKs. All
--   three phases live in one throwaway procedure so each is self-guarded and the
--   whole file re-runs as a no-op.

DELIMITER //

DROP PROCEDURE IF EXISTS octo_recode_doc_roles //

CREATE PROCEDURE octo_recode_doc_roles()
BEGIN
  -- 1. Drop old named CHECKs if still present (old domain would reject 3->4).
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = DATABASE()
      AND table_name = 'doc_member' AND constraint_name = 'chk_doc_member_role'
  ) THEN
    ALTER TABLE doc_member DROP CHECK chk_doc_member_role;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = DATABASE()
      AND table_name = 'doc_invite' AND constraint_name = 'chk_doc_invite_role'
  ) THEN
    ALTER TABLE doc_invite DROP CHECK chk_doc_invite_role;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = DATABASE()
      AND table_name = 'doc_access_request' AND constraint_name = 'chk_doc_access_request_role'
  ) THEN
    ALTER TABLE doc_access_request DROP CHECK chk_doc_access_request_role;
  END IF;

  -- 2. Recode ONCE, gated by the marker, UPDATEs + marker INSERT in ONE
  --    transaction so crash/re-execution cannot double-bump writer(3)->admin(4).
  IF NOT EXISTS (SELECT 1 FROM octo_recode_doc_roles_progress WHERE marker = 1) THEN
    START TRANSACTION;
      -- HIGH value first within a single CASE: 2->3 and 3->4 cannot collide.
      UPDATE doc_member
        SET role = CASE role WHEN 3 THEN 4 WHEN 2 THEN 3 ELSE role END
        WHERE role IN (2, 3);
      UPDATE doc_invite
        SET role = CASE role WHEN 3 THEN 4 WHEN 2 THEN 3 ELSE role END
        WHERE role IN (2, 3);
      UPDATE doc_access_request
        SET requested_role = CASE requested_role WHEN 2 THEN 3 ELSE requested_role END
        WHERE requested_role = 2;
      INSERT INTO octo_recode_doc_roles_progress (marker) VALUES (1);
    COMMIT;
  END IF;

  -- 3. Install the NEW-domain CHECKs (data is now in range), guarded.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = DATABASE()
      AND table_name = 'doc_member' AND constraint_name = 'chk_doc_member_role'
  ) THEN
    ALTER TABLE doc_member
      ADD CONSTRAINT chk_doc_member_role CHECK (role IN (1, 2, 3, 4));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = DATABASE()
      AND table_name = 'doc_invite' AND constraint_name = 'chk_doc_invite_role'
  ) THEN
    ALTER TABLE doc_invite
      ADD CONSTRAINT chk_doc_invite_role CHECK (role IN (1, 2, 3, 4));
  END IF;
  -- doc_access_request.requested_role IN (1,2,3) — admin is never requestable.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = DATABASE()
      AND table_name = 'doc_access_request' AND constraint_name = 'chk_doc_access_request_role'
  ) THEN
    ALTER TABLE doc_access_request
      ADD CONSTRAINT chk_doc_access_request_role CHECK (requested_role IN (1, 2, 3));
  END IF;
END //

DELIMITER ;

CALL octo_recode_doc_roles();

DROP PROCEDURE IF EXISTS octo_recode_doc_roles;
