-- Upgrade migration: Bento PPT (`html_ppt`) R2-B1 create tables (XIN-1514)
--
-- WHAT: adds the two PPT-owned tables the human-create endpoint
--   (POST /api/v1/ppt/docs) needs:
--     - ppt_doc_state    : per-document PPT state + the materialized starter deck
--     - ppt_idempotency  : scoped Idempotency-Key replay/conflict store
--   Both are new tables that touch no existing table, so there is no risk to the
--   legacy doc/sheet/board/html paths.
--
-- SAFETY: idempotent / re-runnable. `CREATE TABLE IF NOT EXISTS` is a no-op on a
--   re-run (guard hit -> skip), matching the migration runner's at-least-once
--   execution contract.
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-08-05-add-ppt-create-tables.sql

CREATE TABLE IF NOT EXISTS ppt_doc_state (
  doc_id                VARCHAR(64)  NOT NULL,
  template_id           VARCHAR(64)  NOT NULL,
  draft_revision        BIGINT       NOT NULL DEFAULT 0,
  snapshot_version      BIGINT       NOT NULL DEFAULT 0,
  published_version_seq BIGINT       NULL DEFAULT NULL,
  ppt_format_version    INT          NOT NULL DEFAULT 1,
  bento_sync_pv         INT          NOT NULL DEFAULT 2,
  draft_doc             MEDIUMTEXT   NOT NULL,
  created_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (doc_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ppt_idempotency (
  space_id        VARCHAR(64)  NOT NULL,
  scope           VARCHAR(32)  NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash    CHAR(64)     NOT NULL,
  response_status INT          NOT NULL DEFAULT 0,
  response_body   MEDIUMTEXT   NULL DEFAULT NULL,
  doc_id          VARCHAR(64)  NULL DEFAULT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (space_id, scope, idempotency_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
