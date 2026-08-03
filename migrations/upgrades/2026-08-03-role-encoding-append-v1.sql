-- Authoritative marker for the append-v1 persisted role encoding.
--
-- Values remain reader=1, writer=2, admin=3, commenter=4.  This marker records
-- the interpretation without rewriting any existing ACL/invite/request rows.
-- The table and insert are idempotent so this is safe both for fresh installs,
-- upgraded databases, and deployments that adopted the encoding before markers
-- existed. A conflicting existing marker is intentionally preserved: startup
-- then fails closed rather than guessing or rewriting persisted role data.
CREATE TABLE IF NOT EXISTS docs_metadata (
  meta_key   VARCHAR(64)  NOT NULL,
  meta_value VARCHAR(255) NOT NULL,
  updated_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (meta_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO docs_metadata (meta_key, meta_value)
VALUES ('role_encoding', 'append-v1')
ON DUPLICATE KEY UPDATE meta_value = meta_value;
