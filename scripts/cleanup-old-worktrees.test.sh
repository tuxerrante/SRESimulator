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

assert_missing() {
  local path=$1
  [[ ! -e "$path" ]] || fail "expected '$path' to be removed"
}

set_worktree_age() {
  local path=$1 days=$2
  python3 - "$path" "$days" <<'PY'
import os
import sys
import time

path = sys.argv[1]
days = int(sys.argv[2])
stamp = time.time() - days * 24 * 60 * 60
os.utime(path, (stamp, stamp))
PY
}

create_fixture() {
  local repo_root=$1

  mkdir -p "$repo_root/.worktrees/old-branch/frontend/node_modules/pkg"
  mkdir -p "$repo_root/.worktrees/old-branch/backend/coverage"
  mkdir -p "$repo_root/.worktrees/old-branch/.cache"
  mkdir -p "$repo_root/.worktrees/old-branch/frontend/src/node_modules"
  mkdir -p "$repo_root/.worktrees/recent-branch/frontend/node_modules/pkg"

  echo "generated" >"$repo_root/.worktrees/old-branch/frontend/node_modules/pkg/index.js"
  echo "coverage" >"$repo_root/.worktrees/old-branch/backend/coverage/report.txt"
  echo "cache" >"$repo_root/.worktrees/old-branch/.cache/cache.txt"
  echo "keep-me" >"$repo_root/.worktrees/old-branch/frontend/src/node_modules/keep.txt"
  echo "recent" >"$repo_root/.worktrees/recent-branch/frontend/node_modules/pkg/index.js"
  echo "source" >"$repo_root/.worktrees/old-branch/frontend/src/app.ts"

  set_worktree_age "$repo_root/.worktrees/old-branch" 30
  set_worktree_age "$repo_root/.worktrees/recent-branch" 1
}

run_dry_run_checks() {
  local repo_root="$TMP_DIR/repo"
  create_fixture "$repo_root"

  if ! bash "$ROOT_DIR/scripts/cleanup-old-worktrees.sh" \
    --root "$repo_root" --days 14 --dry-run >"$TMP_DIR/dry-run.txt" 2>&1; then
    cat "$TMP_DIR/dry-run.txt" >&2 || true
    fail "dry-run should succeed"
  fi

  assert_contains "$repo_root/.worktrees/old-branch/frontend/node_modules" "$TMP_DIR/dry-run.txt"
  assert_contains "$repo_root/.worktrees/old-branch/backend/coverage" "$TMP_DIR/dry-run.txt"
  assert_contains "$repo_root/.worktrees/old-branch/.cache" "$TMP_DIR/dry-run.txt"

  assert_exists "$repo_root/.worktrees/old-branch/frontend/node_modules"
  assert_exists "$repo_root/.worktrees/old-branch/backend/coverage"
  assert_exists "$repo_root/.worktrees/old-branch/.cache"
}

run_delete_checks() {
  local repo_root="$TMP_DIR/repo-delete"
  create_fixture "$repo_root"

  if ! bash "$ROOT_DIR/scripts/cleanup-old-worktrees.sh" \
    --root "$repo_root" --days 14 >"$TMP_DIR/delete-run.txt" 2>&1; then
    cat "$TMP_DIR/delete-run.txt" >&2 || true
    fail "cleanup run should succeed"
  fi

  assert_missing "$repo_root/.worktrees/old-branch/frontend/node_modules"
  assert_missing "$repo_root/.worktrees/old-branch/backend/coverage"
  assert_missing "$repo_root/.worktrees/old-branch/.cache"

  assert_exists "$repo_root/.worktrees/old-branch/frontend/src/node_modules/keep.txt"
  assert_exists "$repo_root/.worktrees/old-branch/frontend/src/app.ts"
  assert_exists "$repo_root/.worktrees/recent-branch/frontend/node_modules/pkg/index.js"
}

run_missing_worktrees_checks() {
  local repo_root="$TMP_DIR/repo-no-worktrees"
  mkdir -p "$repo_root"

  if ! bash "$ROOT_DIR/scripts/cleanup-old-worktrees.sh" \
    --root "$repo_root" --days 14 >"$TMP_DIR/no-worktrees.txt" 2>&1; then
    cat "$TMP_DIR/no-worktrees.txt" >&2 || true
    fail "cleanup without .worktrees should be a no-op"
  fi

  assert_contains "No worktrees directory found" "$TMP_DIR/no-worktrees.txt"
}

main() {
  run_dry_run_checks
  run_delete_checks
  run_missing_worktrees_checks
  echo "cleanup-old-worktrees tests passed."
}

main "$@"
