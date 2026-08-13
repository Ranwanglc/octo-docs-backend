-- Upgrade migration: SUCCESSOR guarded form of the frame_id bin-collation change
-- (XIN-1783 P1-5, restoring XIN-1772 P1-4's intent without a checksum break).
--
-- WHAT: idempotently ensure `ppt_collab_frame.frame_id` and `ppt_collab_op.frame_id`
--   are `utf8mb4_bin` (case-sensitive dedup identity), guarded so an already-bin
--   column is NOT rebuilt.
--
-- WHY THIS FILE EXISTS (and is dated after the sibling it guards):
--   The sibling `2026-08-07-ppt-collab-frame-payload-hash-bin.sql` runs its two
--   `MODIFY frame_id ... COLLATE utf8mb4_bin` UNGUARDED. A charset/collation change
--   forces `ALGORITHM=COPY` (no concurrent DML) and rebuilds BOTH indexes on tables
--   carrying `frame_json MEDIUMTEXT` (~96 MB/room budget) — costly on a large legacy
--   DB. The correct fix is a GUARD, but that sibling is checksum-pinned: `migrate.ts`
--   records `sha256(sql)` per file and HALTS the whole run on drift (it never edits
--   or re-runs a recorded file). A round-23 head commit tried to inline the guard by
--   editing the sibling in place; that changed its recorded checksum and made
--   `npm run migrate` ABORT on every environment that had already recorded the
--   original file — blocking every LATER migration (including the `state_json` column
--   the snapshotter writes). So the sibling is restored BYTE-IDENTICAL to its pinned
--   form and the guard lives here, in a successor whose lexicographic order runs it
--   AFTER the unguarded rebuild. Because the guard is idempotent, ordering after the
--   rebuild costs nothing: on a fresh install and on any DB the sibling already
--   migrated, `frame_id` is already `utf8mb4_bin`, so both guards short-circuit and
--   this is a pure no-op (no COPY, no metadata lock). It only does work on a DB whose
--   `frame_id` is still a non-bin collation — where it is the guarded, index-aware
--   path the sibling should have used.
--
--   The RETIRED whole-envelope hash backfill the sibling also does
--   (`SET payload_hash = SHA2(frame_json,256)`) is deliberately NOT reproduced here:
--   `2026-08-07-...-canonical-ops.sql` retires that scheme (nulls those hashes), and
--   the canonical-ops hash is a JS canonicalization MySQL cannot reproduce — a NULL
--   `payload_hash` is verified against `frame_json` on the relay's re-ack path or
--   fails closed, which is the intended steady state.
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-08-09-ppt-collab-frameid-bin-collation-guard.sql

DELIMITER //

DROP PROCEDURE IF EXISTS octo_ppt_collab_frameid_bin_guard //

CREATE PROCEDURE octo_ppt_collab_frameid_bin_guard()
BEGIN
  -- ppt_collab_frame.frame_id → utf8mb4_bin, only if not already so (skip COPY).
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

  -- ppt_collab_op.frame_id → utf8mb4_bin, only if not already so (skip COPY).
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
END //

CALL octo_ppt_collab_frameid_bin_guard() //

DROP PROCEDURE IF EXISTS octo_ppt_collab_frameid_bin_guard //

DELIMITER ;
