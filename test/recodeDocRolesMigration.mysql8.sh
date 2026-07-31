#!/usr/bin/env bash
set -euo pipefail

# Real-engine regression for the historical v1 deployment shape: role tables
# existed without named CHECK constraints, and an operator explicitly marks the
# inspected database as v1 before running the recode migration.

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
container="octo-doc-role-migration-mysql8-$$"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run --name "$container" -e MYSQL_ROOT_PASSWORD=test -e MYSQL_DATABASE=octo_docs -d mysql:8.4 >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$container" mysql -uroot -ptest -e 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$container" mysql -uroot -ptest -e 'SELECT 1' >/dev/null

docker exec -i "$container" mysql -uroot -ptest octo_docs <<'SQL'
CREATE TABLE doc_member (role TINYINT UNSIGNED NOT NULL);
CREATE TABLE doc_invite (role TINYINT UNSIGNED NOT NULL);
CREATE TABLE doc_access_request (requested_role TINYINT UNSIGNED NOT NULL);
CREATE TABLE octo_schema_metadata (
  metadata_key VARCHAR(128) NOT NULL PRIMARY KEY,
  metadata_value VARCHAR(128) NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
);
INSERT INTO doc_member VALUES (1),(2),(3);
INSERT INTO doc_invite VALUES (1),(2),(3);
INSERT INTO doc_access_request VALUES (1),(2);
INSERT INTO octo_schema_metadata (metadata_key, metadata_value) VALUES ('doc_role_encoding','v1');
SQL

docker exec -i "$container" mysql -uroot -ptest octo_docs \
  < "$repo_dir/migrations/upgrades/2026-07-30-recode-doc-roles.sql"

actual=$(docker exec "$container" mysql -N -uroot -ptest octo_docs -e "
SELECT metadata_value FROM octo_schema_metadata WHERE metadata_key='doc_role_encoding';
SELECT GROUP_CONCAT(role ORDER BY role) FROM doc_member;
SELECT GROUP_CONCAT(role ORDER BY role) FROM doc_invite;
SELECT GROUP_CONCAT(requested_role ORDER BY requested_role) FROM doc_access_request;
SELECT COUNT(*) FROM information_schema.table_constraints
 WHERE table_schema='octo_docs' AND constraint_type='CHECK'
   AND constraint_name IN ('chk_doc_member_role','chk_doc_invite_role','chk_doc_access_request_role');")

expected=$'v2\n1,3,4\n1,3,4\n1,3\n3'
if [[ "$actual" != "$expected" ]]; then
  printf 'unexpected migration result:\n%s\n' "$actual" >&2
  exit 1
fi

echo 'MySQL 8 explicit-v1/no-check role migration: PASS'

setup_partial_case() {
  local db=$1
  docker exec -i "$container" mysql -uroot -ptest <<SQL
CREATE DATABASE $db;
USE $db;
CREATE TABLE doc_member (role TINYINT NOT NULL, CONSTRAINT chk_doc_member_role CHECK (role IN (1,2,3)));
CREATE TABLE doc_invite (role TINYINT NOT NULL, CONSTRAINT chk_doc_invite_role CHECK (role IN (1,2,3)));
CREATE TABLE doc_access_request (requested_role TINYINT NOT NULL, CONSTRAINT chk_doc_access_request_role CHECK (requested_role IN (1,2)));
CREATE TABLE octo_schema_metadata (
  metadata_key VARCHAR(128) NOT NULL PRIMARY KEY,
  metadata_value VARCHAR(128) NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
);
INSERT INTO doc_member VALUES (1),(2),(3);
INSERT INTO doc_invite VALUES (1),(2),(3);
INSERT INTO doc_access_request VALUES (1),(2);
INSERT INTO octo_schema_metadata (metadata_key, metadata_value) VALUES ('doc_role_encoding','v1');
SQL
}

assert_recovered() {
  local db=$1
  docker exec -i "$container" mysql -uroot -ptest "$db" \
    < "$repo_dir/migrations/upgrades/2026-07-30-recode-doc-roles.sql"
  local recovered
  recovered=$(docker exec "$container" mysql -N -uroot -ptest "$db" -e "
SELECT metadata_value FROM octo_schema_metadata WHERE metadata_key='doc_role_encoding';
SELECT GROUP_CONCAT(role ORDER BY role) FROM doc_member;
SELECT COUNT(*) FROM information_schema.table_constraints
 WHERE table_schema='$db' AND constraint_type='CHECK'
   AND constraint_name IN ('chk_doc_member_role','chk_doc_invite_role','chk_doc_access_request_role');")
  [[ "$recovered" == $'v2\n1,3,4\n3' ]]
}

# Crash after a DROP: one expected name is missing while two remain v1.
setup_partial_case octo_partial_drop
docker exec "$container" mysql -uroot -ptest octo_partial_drop \
  -e 'ALTER TABLE doc_member DROP CHECK chk_doc_member_role'
assert_recovered octo_partial_drop

# Crash after an ADD: one CHECK is v2, one is missing, and one remains v1.
setup_partial_case octo_partial_add
docker exec "$container" mysql -uroot -ptest octo_partial_add -e '
ALTER TABLE doc_member DROP CHECK chk_doc_member_role;
ALTER TABLE doc_member ADD CONSTRAINT chk_doc_member_role CHECK (role IN (1,2,3,4));
ALTER TABLE doc_invite DROP CHECK chk_doc_invite_role;'
assert_recovered octo_partial_add

echo 'MySQL 8 partial CHECK DDL recovery: PASS'
