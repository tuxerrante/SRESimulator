#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local needle=$1 file=$2
  grep -Fq "$needle" "$file" || fail "expected '$needle' in $file"
}

assert_not_contains() {
  local needle=$1 file=$2
  if grep -Fq "$needle" "$file"; then
    fail "did not expect '$needle' in $file"
  fi
}

run_missing_secret_guards() {
  if make -C "$ROOT_DIR" dev-db >"$TMP_DIR/dev-db-missing.txt" 2>&1; then
    fail "dev-db should fail without MSSQL_SA_PASSWORD"
  fi
  assert_contains "MSSQL_SA_PASSWORD is required for local SQL Edge flows." "$TMP_DIR/dev-db-missing.txt"
  assert_contains "backend/.env.local" "$TMP_DIR/dev-db-missing.txt"

  if make -C "$ROOT_DIR" smoke-backend-mssql >"$TMP_DIR/smoke-missing.txt" 2>&1; then
    fail "smoke-backend-mssql should fail without an explicit MSSQL secret source"
  fi
  assert_contains "Set MSSQL_DATABASE_URL or MSSQL_SA_PASSWORD before running this target." "$TMP_DIR/smoke-missing.txt"
  assert_contains "backend/.env.local" "$TMP_DIR/smoke-missing.txt"
}

run_static_wiring_checks() {
  assert_not_contains "DevPass@123!" "$ROOT_DIR/Makefile"
  assert_not_contains "DevPass@123!" "$ROOT_DIR/docker-compose.yml"
  assert_contains 'MSSQL_SA_PASSWORD: >-' "$ROOT_DIR/docker-compose.yml"
  assert_contains '${MSSQL_SA_PASSWORD:?Set MSSQL_SA_PASSWORD in your shell or untracked' "$ROOT_DIR/docker-compose.yml"
  assert_contains 'local env before starting SQL Edge}' "$ROOT_DIR/docker-compose.yml"
  assert_contains "export MSSQL_SA_PASSWORD MSSQL_DATABASE_URL" "$ROOT_DIR/Makefile"
  assert_contains 'sql.connect(process.env.DATABASE_URL)' "$ROOT_DIR/Makefile"
  assert_contains "Optional local SQL Edge secret for \`make dev-db\` / \`make test-mssql\`." "$ROOT_DIR/backend/.env.local.example"
}

run_dry_run_escaping_checks() {
  MSSQL_SA_PASSWORD='Abc$Def' make -C "$ROOT_DIR" -n dev-db >"$TMP_DIR/dev-db-dollar.txt" 2>&1
  assert_contains 'Password=${MSSQL_SA_PASSWORD};TrustServerCertificate=true' "$TMP_DIR/dev-db-dollar.txt"
  assert_contains 'DATABASE_URL="$LOCAL_SERVER_URL"' "$TMP_DIR/dev-db-dollar.txt"
  assert_contains 'sql.connect(process.env.DATABASE_URL)' "$TMP_DIR/dev-db-dollar.txt"
  assert_not_contains "Abcef" "$TMP_DIR/dev-db-dollar.txt"
  assert_not_contains 'Password=Abc$Def;TrustServerCertificate=true' "$TMP_DIR/dev-db-dollar.txt"

  MSSQL_SA_PASSWORD="Abc'Def" make -C "$ROOT_DIR" -n dev-db >"$TMP_DIR/dev-db-quote.txt" 2>&1
  assert_contains 'sql.connect(process.env.DATABASE_URL)' "$TMP_DIR/dev-db-quote.txt"
  assert_contains 'DATABASE_URL="$LOCAL_SERVER_URL"' "$TMP_DIR/dev-db-quote.txt"
  assert_not_contains "sql.connect('Server=localhost;User Id=sa;Password=Abc'Def;TrustServerCertificate=true')" "$TMP_DIR/dev-db-quote.txt"
  assert_not_contains "Abc'Def" "$TMP_DIR/dev-db-quote.txt"

  MSSQL_DATABASE_URL='Server=localhost;Database=sresimulator;User Id=sa;Password=Abc$Def;TrustServerCertificate=true' \
    make -C "$ROOT_DIR" -n smoke-backend-mssql >"$TMP_DIR/smoke-dollar.txt" 2>&1
  assert_contains 'RESPONSE_FILE="$(mktemp "${TMPDIR:-/tmp}/sre-db-smoke-response.XXXXXX")"' "$TMP_DIR/smoke-dollar.txt"
  assert_contains 'DATABASE_URL="${MSSQL_DATABASE_URL:-}"' "$TMP_DIR/smoke-dollar.txt"
  assert_contains 'sql.connect(process.env.DATABASE_URL)' "$TMP_DIR/smoke-dollar.txt"
  assert_not_contains 'mktemp /tmp/sre-db-smoke-response.XXXXXX.json' "$TMP_DIR/smoke-dollar.txt"
  assert_not_contains "Abcef" "$TMP_DIR/smoke-dollar.txt"
}

main() {
  run_missing_secret_guards
  run_static_wiring_checks
  run_dry_run_escaping_checks
  echo "local MSSQL secret tests passed."
}

main "$@"
