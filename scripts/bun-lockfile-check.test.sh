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

# Bun records a package's resolved source in the first tuple element as
# `name@<source>`; only registry semver sources must pass the integrity gate.
write_lock() {
  local path=$1 packages=$2
  cat >"$path" <<EOF
{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "app"
    },
  },
  "packages": {
$packages
  },
}
EOF
}

run_valid_lock_passes() {
  local lock="$TMP_DIR/valid.lock"
  write_lock "$lock" '    "left-pad": ["left-pad@1.3.0", "", {}, "sha512-abc=="],'

  if ! node "$ROOT_DIR/scripts/bun-lockfile-check.mjs" "$lock" \
    >"$TMP_DIR/valid.txt" 2>&1; then
    cat "$TMP_DIR/valid.txt" >&2 || true
    fail "a registry-only Bun lockfile should pass"
  fi
  assert_contains "Validated 1 Bun lockfile(s)." "$TMP_DIR/valid.txt"
}

run_tarball_source_rejected() {
  local lock="$TMP_DIR/tarball.lock"
  write_lock "$lock" \
    '    "evil": ["evil@https://example.com/evil.tgz", "", {}, ""],'

  if node "$ROOT_DIR/scripts/bun-lockfile-check.mjs" "$lock" \
    >"$TMP_DIR/tarball.txt" 2>&1; then
    fail "an https tarball source in the first tuple element must be rejected"
  fi
  assert_contains "contains a URL-based package source" "$TMP_DIR/tarball.txt"
}

run_tarball_prefixed_source_rejected() {
  local lock="$TMP_DIR/tarball-prefixed.lock"
  write_lock "$lock" \
    '    "evil": ["evil@tarball:https://example.com/evil.tgz", "", {}, ""],'

  if node "$ROOT_DIR/scripts/bun-lockfile-check.mjs" "$lock" \
    >"$TMP_DIR/tarball-prefixed.txt" 2>&1; then
    fail "a tarball: source must be rejected"
  fi
  assert_contains "contains a URL-based package source" \
    "$TMP_DIR/tarball-prefixed.txt"
}

run_git_source_rejected() {
  local lock="$TMP_DIR/git.lock"
  write_lock "$lock" \
    '    "evil": ["evil@git+https://example.com/evil.git", "", {}, ""],'

  if node "$ROOT_DIR/scripts/bun-lockfile-check.mjs" "$lock" \
    >"$TMP_DIR/git.txt" 2>&1; then
    fail "a git+ source must be rejected"
  fi
  assert_contains "contains a URL-based package source" "$TMP_DIR/git.txt"
}

run_npm_lockfile_rejected() {
  local lock="$TMP_DIR/npm.lock"
  cat >"$lock" <<'EOF'
{
  "name": "app",
  "lockfileVersion": 2,
  "packages": {}
}
EOF

  if node "$ROOT_DIR/scripts/bun-lockfile-check.mjs" "$lock" \
    >"$TMP_DIR/npm.txt" 2>&1; then
    fail "an npm lockfile renamed to bun.lock must be rejected"
  fi
  assert_contains "is not a Bun text lockfile" "$TMP_DIR/npm.txt"
}

main() {
  run_valid_lock_passes
  run_tarball_source_rejected
  run_tarball_prefixed_source_rejected
  run_git_source_rejected
  run_npm_lockfile_rejected
  echo "bun lockfile check tests passed."
}

main "$@"
