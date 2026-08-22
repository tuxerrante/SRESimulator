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
  assert_contains "contains a non-registry package source" "$TMP_DIR/tarball.txt"
}

run_tarball_prefixed_source_rejected() {
  local lock="$TMP_DIR/tarball-prefixed.lock"
  write_lock "$lock" \
    '    "evil": ["evil@tarball:https://example.com/evil.tgz", "", {}, ""],'

  if node "$ROOT_DIR/scripts/bun-lockfile-check.mjs" "$lock" \
    >"$TMP_DIR/tarball-prefixed.txt" 2>&1; then
    fail "a tarball: source must be rejected"
  fi
  assert_contains "contains a non-registry package source" \
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
  assert_contains "contains a non-registry package source" "$TMP_DIR/git.txt"
}

run_local_scheme_sources_rejected() {
  local scheme
  for scheme in "file:../pkg" "link:../pkg" "workspace:pkg"; do
    local safe_name lock out
    safe_name="${scheme%%:*}"
    lock="$TMP_DIR/local-${safe_name}.lock"
    out="$TMP_DIR/local-${safe_name}.txt"
    write_lock "$lock" "    \"evil\": [\"evil@${scheme}\", \"\", {}, \"\"],"

    if node "$ROOT_DIR/scripts/bun-lockfile-check.mjs" "$lock" \
      >"$out" 2>&1; then
      fail "a ${scheme} source must be rejected"
    fi
    assert_contains "contains a non-registry package source" "$out"
  done
}

run_custom_registry_rejected() {
  local lock="$TMP_DIR/registry.lock"
  write_lock "$lock" \
    '    "evil": ["evil@1.0.0", "https://npm.evil.example/", {}, "sha512-abc=="],'

  if node "$ROOT_DIR/scripts/bun-lockfile-check.mjs" "$lock" \
    >"$TMP_DIR/registry.txt" 2>&1; then
    fail "a custom registry in the second tuple element must be rejected"
  fi
  assert_contains "contains a non-allow-listed registry source" \
    "$TMP_DIR/registry.txt"
}

run_default_npm_registry_passes() {
  local lock="$TMP_DIR/registry-default.lock"
  write_lock "$lock" \
    '    "left-pad": ["left-pad@1.3.0", "https://registry.npmjs.org/", {}, "sha512-abc=="],'

  if ! node "$ROOT_DIR/scripts/bun-lockfile-check.mjs" "$lock" \
    >"$TMP_DIR/registry-default.txt" 2>&1; then
    cat "$TMP_DIR/registry-default.txt" >&2 || true
    fail "the canonical npmjs registry must be allow-listed"
  fi
  assert_contains "Validated 1 Bun lockfile(s)." "$TMP_DIR/registry-default.txt"
}

run_trusted_dependencies_not_scanned_as_registry() {
  # trustedDependencies lives in the workspace object, not the packages block;
  # its string array entries must never be misread as registry tuple values.
  local lock="$TMP_DIR/trusted.lock"
  cat >"$lock" <<'EOF'
{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
      "trustedDependencies": ["esbuild", "@sentry/cli"],
    },
  },
  "packages": {
    "left-pad": ["left-pad@1.3.0", "", {}, "sha512-abc=="],
  },
}
EOF

  if ! node "$ROOT_DIR/scripts/bun-lockfile-check.mjs" "$lock" \
    >"$TMP_DIR/trusted.txt" 2>&1; then
    cat "$TMP_DIR/trusted.txt" >&2 || true
    fail "trustedDependencies entries must not be scanned as registry values"
  fi
  assert_contains "Validated 1 Bun lockfile(s)." "$TMP_DIR/trusted.txt"
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
  run_local_scheme_sources_rejected
  run_custom_registry_rejected
  run_default_npm_registry_passes
  run_trusted_dependencies_not_scanned_as_registry
  run_npm_lockfile_rejected
  echo "bun lockfile check tests passed."
}

main "$@"
