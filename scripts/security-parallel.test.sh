#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAKEFILE="$ROOT_DIR/Makefile"
WORKFLOW="$ROOT_DIR/.github/workflows/ci.yml"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local expected=$1 file=$2
  grep -Fq -- "$expected" "$file" || fail "expected '$expected' in $file"
}

assert_not_contains() {
  local unexpected=$1 file=$2
  if grep -Fq -- "$unexpected" "$file"; then
    fail "did not expect '$unexpected' in $file"
  fi
}

assert_contains "GRYPE_DB_AUTO_UPDATE=true grype db update" "$MAKEFILE"
assert_contains "GRYPE_DB_AUTO_UPDATE=false grype" "$MAKEFILE"
assert_contains "GRYPE_DB_CACHE_DIR=/cache/db" "$MAKEFILE"
assert_contains '"$$HOME/.cache/grype:/cache"' "$MAKEFILE"
assert_contains 'FRONTEND_PID=$$!' "$MAKEFILE"
assert_contains 'BACKEND_PID=$$!' "$MAKEFILE"
assert_contains 'wait "$$FRONTEND_PID"' "$MAKEFILE"
assert_contains 'wait "$$BACKEND_PID"' "$MAKEFILE"

assert_contains "Restore Grype vulnerability database" "$WORKFLOW"
assert_contains "actions/cache@0400d5f644dc74513175e3cd8d07132dd4860809" "$WORKFLOW"
assert_contains "path: ~/.cache/grype" "$WORKFLOW"
assert_not_contains "Grype severity gate" "$WORKFLOW"

echo "parallel security scan checks passed."
