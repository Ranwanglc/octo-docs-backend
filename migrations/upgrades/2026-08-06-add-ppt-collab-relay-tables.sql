-- Upgrade migration: Bento PPT (`html_ppt`) R4-B1 relay persistence tables (XIN-1638)
--
-- WHAT: adds the two PPT relay-owned tables the Bento-frame WS relay
--   (GET /api/v1/ppt/collab) needs for durable op/snapshot persistence:
--     - ppt_collab_op     : durable op frames by (doc_id, seq); unique (doc_id, frame_id)
--     - ppt_live_snapshot : authoritative live BentoDoc snapshot per doc, covered seq
--   Both are new tables that touch no existing table, so there is no risk to the
--   legacy doc/sheet/board/html paths or the R2/R3 PPT create/source paths.
--
--   Relay contract these tables back (§7.3):
--     - ppt_collab_op.seq is the MONOTONIC per-room sequence; the relay acks a
--       frame only AFTER the row is durably committed, then broadcasts.
--     - UNIQUE (doc_id, frame_id) makes a resent frame a no-op that re-acks its
--       original seq rather than inserting a duplicate.
--     - ppt_live_snapshot advances snapshot_version atomically; covered ops are
--       pruned from ppt_collab_op only AFTER the snapshot row is durable.
--
-- SAFETY: idempotent / re-runnable. `CREATE TABLE IF NOT EXISTS` is a no-op on a
--   re-run (guard hit -> skip), matching the migration runner's at-least-once
--   execution contract.
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-08-06-add-ppt-collab-relay-tables.sql

CREATE TABLE IF NOT EXISTS ppt_collab_op (
  doc_id     VARCHAR(64) NOT NULL,                       -- FK-by-convention to doc_meta.doc_id (html_ppt row)
  seq        BIGINT      NOT NULL,                        -- monotonic per-room sequence (relay-assigned)
  frame_id   VARCHAR(64) NOT NULL,                        -- globally-unique Bento frame id (dedup key)
  frame_json MEDIUMTEXT  NOT NULL,                        -- the original `ops` frame, plaintext JSON
  frame_bytes INT        NOT NULL DEFAULT 0,              -- byte size of frame_json (room-budget accounting)
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (doc_id, seq),
  UNIQUE KEY uq_ppt_collab_op_frame (doc_id, frame_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ppt_live_snapshot (
  doc_id           VARCHAR(64) NOT NULL,                  -- one authoritative live snapshot per doc
  snapshot_version BIGINT      NOT NULL DEFAULT 0,        -- monotonic; advances atomically on each save
  covered_seq      BIGINT      NOT NULL DEFAULT 0,        -- ppt_collab_op.seq this snapshot covers (<= are prunable)
  doc_json         MEDIUMTEXT  NOT NULL,                  -- the authoritative BentoDoc snapshot, plaintext JSON
  doc_sha          CHAR(64)    NOT NULL,                  -- sha256(hex) of doc_json (integrity / dedup)
  doc_bytes        INT         NOT NULL DEFAULT 0,        -- byte size of doc_json
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (doc_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
