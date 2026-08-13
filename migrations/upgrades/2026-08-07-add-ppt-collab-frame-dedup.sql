-- Upgrade migration: Bento PPT (`html_ppt`) R4-B1 relay dedup ledger (XIN-1655 C1)
--
-- WHAT: adds the durable dedup ledger the Bento-frame WS relay uses to keep
--   idempotent resend correct ACROSS op-log pruning:
--     - ppt_collab_frame : one row per accepted frame, mapping (doc_id, frame_id)
--                          to the room seq it was assigned. Written at PRUNE time
--                          (the relay copies each pruned frame's mapping here just
--                          before deleting its ppt_collab_op row), so the mapping
--                          outlives the op row.
--   A new table that touches no existing table — no risk to the legacy
--   doc/sheet/board/html paths or the R2/R3/earlier-R4 PPT paths.
--
--   WHY (the C1 defect this closes): `DbPptRelayStore.appendOp` deduped a resent
--   frame only by reading `ppt_collab_op` on (doc_id, frame_id). But a snapshot
--   physically deletes covered rows via `pruneOpsThrough`. Once seq N was covered
--   and pruned, a client re-sending that same frameId (after a reconnect /
--   partition) no longer hit the (doc_id, frame_id) unique row -> it was minted a
--   FRESH seq and rebroadcast as a duplicate mutation, duplicating an op the
--   snapshot already subsumes. With this ledger, appendOp re-acks the frame's
--   ORIGINAL seq (duplicate:true, no rebroadcast) even after its op row is gone.
--
-- SAFETY: idempotent / re-runnable. `CREATE TABLE IF NOT EXISTS` is a no-op on a
--   re-run (guard hit -> skip), matching the migration runner's at-least-once
--   execution contract. The relay's prune writes rows with `INSERT IGNORE`, so a
--   re-run of a prune is a no-op too.
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-08-07-add-ppt-collab-frame-dedup.sql

CREATE TABLE IF NOT EXISTS ppt_collab_frame (
  doc_id     VARCHAR(64) NOT NULL,                        -- FK-by-convention to doc_meta.doc_id (html_ppt row)
  frame_id   VARCHAR(64) NOT NULL,                        -- globally-unique Bento frame id (dedup key)
  seq        BIGINT      NOT NULL,                        -- room seq this frame was assigned (retained past prune)
  pruned_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (doc_id, frame_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
