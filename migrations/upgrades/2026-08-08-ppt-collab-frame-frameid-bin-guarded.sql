-- Upgrade migration: SUPERSEDING guarded form of the frame_id bin-collation change
-- (XIN-1772 P1-4).
--
-- WHAT: idempotently ensure `ppt_collab_frame.frame_id` and `ppt_collab_op.frame_id`
--   are `utf8mb4_bin` (case-sensitive dedup identity), guarded so an already-bin
--   column is NOT rebuilt.
--
-- WHY: the sibling `2026-08-07-ppt-collab-frame-payload-hash-bin.sql` runs its two
--   `MODIFY frame_id ... COLLATE utf8mb4_bin` UNGUARDED — NOT behind the
--   `information_schema` check its own `ADD COLUMN` uses. A charset/collation change
--   forces `ALGORITHM=COPY` (no concurrent DML) and rebuilds BOTH indexes on tables
--   that carry `frame_json MEDIUMTEXT` (a ~96 MB/room budget), so on a large legacy
--   DB that runs it fresh the whole table is copy-rebuilt under a metadata lock. That
--   sibling file is checksum-pinned (migrate.ts HALTS on drift), so it cannot be
--   edited in place; this SUPERSEDING migration adds the guard the sibling lacked.
--
--   The RETIRED whole-envelope hash backfill the sibling also did
--   (`SET payload_hash = SHA2(frame_json,256)`) is deliberately NOT reproduced here:
--   `2026-08-07-...-canonical-ops.sql` retires that scheme (nulls those hashes), and
--   the canonical-ops hash is a JS canonicalization MySQL cannot reproduce — a NULL
--   `payload_hash` is verified against `frame_json` on the relay's re-ack path or
--   fails closed, which is the intended steady state. Re-hashing here would only
--   re-introduce the retired scheme.
--
-- SAFETY: fully guarded + idempotent. On a fresh `schema.sql` install and on any DB
--   the sibling already migrated, `frame_id` is already `utf8mb4_bin`, so both
--   guards short-circuit and this is a pure no-op (no COPY, no lock). It only does
--   work on a DB whose `frame_id` is still a non-bin collation — where it is the
--   guarded, index-aware path the sibling should have used. real-MySQL confirmation
--   (guard short-circuits when already bin; performs the collation change once
--   otherwise) is routed to the integration gate (PR #163).
--
-- NOTE on the sibling's UNBATCHED backfill: because the canonical-ops migration
--   retires the whole-envelope hash entirely, there is no correct batched backfill to
--   supersede it with — the fix is "do not hash in SQL", already realized by the
--   NULL-hash re-ack path (dbStore `resolveDuplicate` / `resolveNullHashReack`).
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-08-08-ppt-collab-frame-frameid-bin-guarded.sql

DELIMITER //

DROP PROCEDURE IF EXISTS octo_ppt_collab_frameid_bin_guarded //

CREATE PROCEDURE octo_ppt_collab_frameid_bin_guarded()
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

CALL octo_ppt_collab_frameid_bin_guarded() //

DROP PROCEDURE IF EXISTS octo_ppt_collab_frameid_bin_guarded //

DELIMITER ;
