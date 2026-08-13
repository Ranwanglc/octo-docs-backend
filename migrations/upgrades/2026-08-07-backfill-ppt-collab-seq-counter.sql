-- Upgrade migration: backfill the PPT relay per-room seq counter (XIN-1655 C3)
--
-- WHAT: seeds `ppt_collab_seq.last_seq` for every room that already has op /
--   snapshot state, from `MAX(ppt_collab_op.seq)` UNION `ppt_live_snapshot.covered_seq`
--   (the greater of the two per doc).
--
-- WHY: `2026-08-06-add-ppt-collab-seq-counter.sql` creates `ppt_collab_seq` EMPTY.
--   Its header claimed the absent-row case was safe because "the first append
--   after upgrade seeds it (INSERT path)". That claim is CORRECT only for a room
--   created AFTER the counter existed. It is WRONG for a room that already had
--   `ppt_collab_op` rows (or a live snapshot) when the counter table was added —
--   exactly the dev/staging DB that iterated this PR's intermediate migrations:
--     (a) room with retained ops at seq 1..N: an empty counter hands out seq 1 on
--         the next append -> (doc_id, seq) PRIMARY KEY conflict on a different
--         frameId -> the append transaction rethrows/rolls back -> the relay
--         surfaces a permanent `storage-failed` for that room, forever.
--     (b) fully-pruned room (ops gone, snapshot covers 1..N): an empty counter
--         starts at 0 and re-mints seq 1, reproducing the very P0-2 seq-reuse
--         (silent op drop on replay) the counter was introduced to fix.
--   Backfilling the counter to the room's true high-water fixes both.
--
--   This is a SEPARATE migration rather than an edit to the seq-counter file on
--   purpose: the runner records each applied file's checksum and HALTS on drift
--   (`Migration checksum mismatch ...`). Editing the already-applied seq-counter
--   file would break migration on precisely the dev/staging DB this fix must
--   reach. A new, idempotent migration reaches fresh and already-iterated DBs
--   alike without touching the applied file's checksum.
--
-- SAFETY: idempotent / re-runnable. The upsert uses `GREATEST(last_seq, ...)`, so
--   a re-run (or a counter already ahead of the op/snapshot state, e.g. because a
--   prune left it above MAX(seq)) never regresses the counter. On a fresh install
--   the source tables are empty, so this seeds nothing (the SELECT yields no rows)
--   and is a harmless no-op — the counter self-seeds via the append INSERT path.
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-08-07-backfill-ppt-collab-seq-counter.sql

INSERT INTO ppt_collab_seq (doc_id, last_seq)
SELECT doc_id, MAX(s) AS last_seq
FROM (
  SELECT doc_id, MAX(seq) AS s FROM ppt_collab_op GROUP BY doc_id
  UNION ALL
  SELECT doc_id, covered_seq AS s FROM ppt_live_snapshot
) u
GROUP BY doc_id
ON DUPLICATE KEY UPDATE last_seq = GREATEST(last_seq, VALUES(last_seq));
