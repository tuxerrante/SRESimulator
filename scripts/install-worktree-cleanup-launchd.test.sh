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

assert_exists() {
  local path=$1
  [[ -e "$path" ]] || fail "expected '$path' to exist"
}

main() {
  local output_path="$TMP_DIR/com.tuxerrante.sresimulator.worktree-cleanup.plist"
  local log_dir="$TMP_DIR/logs"

  if ! bash "$ROOT_DIR/scripts/install-worktree-cleanup-launchd.sh" \
    --repo-root "$ROOT_DIR" \
    --output "$output_path" \
    --log-dir "$log_dir" >"$TMP_DIR/install.txt" 2>&1; then
    cat "$TMP_DIR/install.txt" >&2 || true
    fail "launchd installer should succeed"
  fi

  assert_exists "$output_path"
  assert_contains "com.tuxerrante.sresimulator.worktree-cleanup" "$output_path"
  assert_contains "$ROOT_DIR" "$output_path"
  assert_contains "make" "$output_path"
  assert_contains "cleanup-worktrees" "$output_path"
  assert_contains "$log_dir/worktree-cleanup.stdout.log" "$output_path"
  assert_contains "$log_dir/worktree-cleanup.stderr.log" "$output_path"

  echo "install-worktree-cleanup-launchd tests passed."
}

main "$@"
