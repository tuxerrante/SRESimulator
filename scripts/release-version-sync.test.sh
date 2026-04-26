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

assert_file_contains() {
  local file=$1 needle=$2
  grep -Fq "$needle" "$file" || fail "expected '$needle' in $file"
}

write_fixture_repo() {
  local target_dir=$1

  mkdir -p \
    "$target_dir/frontend/src/lib" \
    "$target_dir/backend" \
    "$target_dir/helm/sre-simulator"

  cat >"$target_dir/frontend/package.json" <<'EOF'
{
  "name": "frontend",
  "version": "0.1.2"
}
EOF

  cat >"$target_dir/backend/package.json" <<'EOF'
{
  "name": "backend",
  "version": "0.1.2"
}
EOF

  cat >"$target_dir/frontend/package-lock.json" <<'EOF'
{
  "name": "frontend",
  "version": "0.1.2",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "frontend",
      "version": "0.1.2"
    }
  }
}
EOF

  cat >"$target_dir/backend/package-lock.json" <<'EOF'
{
  "name": "backend",
  "version": "0.1.2",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "backend",
      "version": "0.1.2"
    }
  }
}
EOF

  cat >"$target_dir/helm/sre-simulator/Chart.yaml" <<'EOF'
apiVersion: v2
name: sre-simulator
version: 0.1.2
appVersion: "0.1.2"
EOF

  cat >"$target_dir/frontend/src/lib/release.ts" <<'EOF'
export const APP_VERSION = "v0.1.2";
EOF

  cat >"$target_dir/CHANGELOG.md" <<'EOF'
# Changelog

## [0.1.2] - 2026-04-18

- Existing release notes.

## [0.1.3] - 2026-04-26

- New release notes.
EOF
}

run_verify_mismatch_check() {
  local repo_dir="$TMP_DIR/repo-mismatch"
  write_fixture_repo "$repo_dir"

  if node "$ROOT_DIR/scripts/release-version-sync.mjs" verify \
    --root "$repo_dir" \
    --tag v0.1.3 >"$TMP_DIR/verify-mismatch.txt" 2>&1; then
    fail "verify should fail when semver surfaces do not match the tag"
  fi

  assert_contains "frontend/package.json mismatch" "$TMP_DIR/verify-mismatch.txt"
}

run_verify_missing_changelog_check() {
  local repo_dir="$TMP_DIR/repo-missing-changelog"
  write_fixture_repo "$repo_dir"
  python3 - "$repo_dir/CHANGELOG.md" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
path.write_text("# Changelog\n\n## [0.1.2] - 2026-04-18\n\n- Existing release notes.\n")
PY

  if node "$ROOT_DIR/scripts/release-version-sync.mjs" verify \
    --root "$repo_dir" \
    --tag v0.1.3 >"$TMP_DIR/verify-missing-changelog.txt" 2>&1; then
    fail "verify should fail when the changelog entry is missing"
  fi

  assert_contains "No changelog notes found for 0.1.3" \
    "$TMP_DIR/verify-missing-changelog.txt"
}

run_prepare_and_verify_check() {
  local repo_dir="$TMP_DIR/repo-prepare"
  write_fixture_repo "$repo_dir"

  if ! node "$ROOT_DIR/scripts/release-version-sync.mjs" prepare \
    --root "$repo_dir" \
    --tag v0.1.3 >"$TMP_DIR/prepare.txt" 2>&1; then
    cat "$TMP_DIR/prepare.txt" >&2 || true
    fail "prepare should update all semver surfaces"
  fi

  assert_contains "Updated release version surfaces for v0.1.3." \
    "$TMP_DIR/prepare.txt"
  assert_file_contains "$repo_dir/frontend/package.json" '"version": "0.1.3"'
  assert_file_contains "$repo_dir/backend/package.json" '"version": "0.1.3"'
  assert_file_contains "$repo_dir/frontend/package-lock.json" '"version": "0.1.3"'
  assert_file_contains "$repo_dir/backend/package-lock.json" '"version": "0.1.3"'
  assert_file_contains "$repo_dir/helm/sre-simulator/Chart.yaml" 'version: 0.1.3'
  assert_file_contains "$repo_dir/helm/sre-simulator/Chart.yaml" 'appVersion: "0.1.3"'
  assert_file_contains "$repo_dir/frontend/src/lib/release.ts" \
    'export const APP_VERSION = "v0.1.3";'

  if ! node "$ROOT_DIR/scripts/release-version-sync.mjs" verify \
    --root "$repo_dir" \
    --tag v0.1.3 >"$TMP_DIR/verify-success.txt" 2>&1; then
    cat "$TMP_DIR/verify-success.txt" >&2 || true
    fail "verify should pass after prepare updates all semver surfaces"
  fi

  assert_contains "Semver surfaces aligned for v0.1.3." \
    "$TMP_DIR/verify-success.txt"
  assert_not_contains "mismatch" "$TMP_DIR/verify-success.txt"
}

run_static_wiring_checks() {
  assert_file_contains "$ROOT_DIR/Makefile" 'release-prepare: ## Update semver surfaces for a release tag'
  assert_file_contains "$ROOT_DIR/Makefile" 'verify-release-version: ## Verify semver surfaces for a release tag'
  assert_file_contains "$ROOT_DIR/Makefile" 'node scripts/release-version-sync.mjs prepare --tag "$$TAG"'
  assert_file_contains "$ROOT_DIR/Makefile" 'node scripts/release-version-sync.mjs verify --tag "$$TAG"'
  assert_file_contains "$ROOT_DIR/Makefile" 'bash scripts/release-version-sync.test.sh'
  assert_file_contains "$ROOT_DIR/.github/workflows/ci.yml" 'RELEASE_TAG: ${{ github.ref_name }}'
  assert_file_contains "$ROOT_DIR/.github/workflows/ci.yml" 'node scripts/release-version-sync.mjs verify --tag "${RELEASE_TAG}"'
  assert_file_contains "$ROOT_DIR/.github/workflows/release.yml" 'node scripts/release-version-sync.mjs verify --tag "${RELEASE_TAG}"'
  assert_not_contains 'const fs = require("fs");' "$ROOT_DIR/.github/workflows/release.yml"
}

main() {
  run_verify_mismatch_check
  run_verify_missing_changelog_check
  run_prepare_and_verify_check
  run_static_wiring_checks
  echo "release version sync tests passed."
}

main "$@"
