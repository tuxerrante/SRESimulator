#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOW="$ROOT_DIR/.github/workflows/ci.yml"
MAKEFILE="$ROOT_DIR/Makefile"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local expected=$1 file=$2
  grep -Fq -- "$expected" "$file" || \
    fail "expected '$expected' in $file"
}

node --check "$ROOT_DIR/scripts/playwright-live-e2e.mjs"

assert_contains "live-e2e:" "$WORKFLOW"
assert_contains "name: live-e2e" "$WORKFLOW"
assert_contains "github.event.pull_request.head.repo.full_name == github.repository" "$WORKFLOW"
assert_contains "E2E_NAMESPACE_PREFIX: sre-pr-" "$WORKFLOW"
assert_contains "make test-e2e-live" "$WORKFLOW"
assert_contains "make e2e-azure-route-down" "$WORKFLOW"
assert_contains "LIVE_E2E_RESULT:" "$WORKFLOW"
assert_contains 'failed_jobs+=("live-e2e (${LIVE_E2E_RESULT})")' "$WORKFLOW"

assert_contains "playwright-install:" "$MAKEFILE"
assert_contains "test-e2e-live:" "$MAKEFILE"
assert_contains "LIVE_E2E_AUTH_SESSION_SECRET is required." "$MAKEFILE"

echo "live E2E gate checks passed."
