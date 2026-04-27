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
  local relative_repo_root="../repo-root"
  local relative_output_path="../launchd/com.example.weekly-cleanup.plist"
  local relative_log_dir="../logs"

  mkdir -p "$TMP_DIR/repo-root"

  pushd "$TMP_DIR/repo-root" >/dev/null
  if ! MAKE_BIN="/usr/bin/make" bash "$ROOT_DIR/scripts/install-worktree-cleanup-launchd.sh" \
    --repo-root "$relative_repo_root" \
    --output "$relative_output_path" \
    --log-dir "$relative_log_dir" \
    --label "com.example.weekly-cleanup" >"$TMP_DIR/install.txt" 2>&1; then
    cat "$TMP_DIR/install.txt" >&2 || true
    fail "launchd installer should succeed"
  fi
  popd >/dev/null

  output_path="$TMP_DIR/launchd/com.example.weekly-cleanup.plist"
  log_dir="$TMP_DIR/logs"

  assert_exists "$output_path"
  assert_contains "com.example.weekly-cleanup" "$output_path"
  assert_contains "$TMP_DIR/repo-root" "$output_path"
  assert_contains "/usr/bin/make" "$output_path"
  assert_contains "cleanup-worktrees" "$output_path"
  assert_contains "$log_dir/worktree-cleanup.stdout.log" "$output_path"
  assert_contains "$log_dir/worktree-cleanup.stderr.log" "$output_path"

  echo "install-worktree-cleanup-launchd tests passed."
}

main "$@"
