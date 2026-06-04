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

run_direct_exec_checks() {
  if ! CLUSTER_FLAVOR=aks bash "$ROOT_DIR/scripts/select-deploy.sh" \
    >"$TMP_DIR/direct-aks.txt" 2>&1; then
    cat "$TMP_DIR/direct-aks.txt" >&2 || true
    fail "direct execution should succeed for CLUSTER_FLAVOR=aks"
  fi

  if ! CLUSTER_FLAVOR=aro bash "$ROOT_DIR/scripts/select-deploy.sh" \
    >"$TMP_DIR/direct-aro.txt" 2>&1; then
    cat "$TMP_DIR/direct-aro.txt" >&2 || true
    fail "direct execution should succeed for CLUSTER_FLAVOR=aro"
  fi

  if CLUSTER_FLAVOR=invalid bash "$ROOT_DIR/scripts/select-deploy.sh" \
    >"$TMP_DIR/direct-invalid.txt" 2>&1; then
    fail "direct execution should fail for an unsupported cluster flavor"
  fi

  assert_contains "unsupported CLUSTER_FLAVOR='invalid'" "$TMP_DIR/direct-invalid.txt"
  assert_not_contains "return: can only" "$TMP_DIR/direct-invalid.txt"
}

run_source_checks() {
  if CLUSTER_FLAVOR=invalid bash -lc 'source "$1"' _ \
    "$ROOT_DIR/scripts/select-deploy.sh" >"$TMP_DIR/source-invalid.txt" 2>&1; then
    fail "sourcing should fail for an unsupported cluster flavor"
  fi

  assert_contains "unsupported CLUSTER_FLAVOR='invalid'" "$TMP_DIR/source-invalid.txt"
  assert_not_contains "return: can only" "$TMP_DIR/source-invalid.txt"
}

main() {
  run_direct_exec_checks
  run_source_checks
  echo "select-deploy tests passed."
}

main "$@"
