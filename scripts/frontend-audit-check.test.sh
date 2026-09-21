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
  grep -Fq -- "$needle" "$file" || fail "expected '$needle' in $file"
}

assert_not_contains() {
  local needle=$1 file=$2
  if grep -Fq -- "$needle" "$file"; then
    fail "did not expect '$needle' in $file"
  fi
}

write_fixture_repo() {
  local repo_dir=$1
  mkdir -p "$repo_dir/frontend" "$repo_dir/bin"

  cat >"$repo_dir/frontend/audit-policy-exceptions.json" <<'JSON'
{
  "policyName": "test-policy",
  "approvedOn": "2026-07-31",
  "reviewBy": "tests",
  "expectedCounts": {
    "high": 1
  },
  "exceptions": [
    {
      "name": "allowed-package",
      "severity": "high",
      "range": "<=1.2.3",
      "via": ["brace-expansion"],
      "reason": "Approved test exception."
    }
  ]
}
JSON

  cat >"$repo_dir/bin/bun" <<'EOF_STUB'
#!/usr/bin/env bash
set -euo pipefail
cat "${FAKE_BUN_AUDIT_JSON:?}"
if [ "${FAKE_BUN_EXIT_CODE:-0}" -ne 0 ]; then
  exit "${FAKE_BUN_EXIT_CODE}"
fi
EOF_STUB
  chmod +x "$repo_dir/bin/bun"
}

write_audit_json() {
  local target=$1 body=$2
  cat >"$target" <<JSON
${body}
JSON
}

run_allowed_exception_check() {
  local repo_dir="$TMP_DIR/repo-allowed"
  write_fixture_repo "$repo_dir"
  write_audit_json "$TMP_DIR/allowed-audit.json" '{
  "allowed-package": [
    {
      "id": 1001,
      "title": "brace-expansion",
      "severity": "high",
      "vulnerable_versions": "<=1.2.3"
    }
  ]
}'

  if ! env \
    PATH="$repo_dir/bin:$PATH" \
    FAKE_BUN_AUDIT_JSON="$TMP_DIR/allowed-audit.json" \
    FAKE_BUN_EXIT_CODE=1 \
    node "$ROOT_DIR/scripts/frontend-audit-check.mjs" \
      --root "$repo_dir" \
      --frontend-dir frontend \
      --audit-level high >"$TMP_DIR/allowed.out" 2>&1; then
    cat "$TMP_DIR/allowed.out" >&2 || true
    fail "allowed exception should pass"
  fi

  assert_contains "frontend audit passed with only approved exception packages remaining." "$TMP_DIR/allowed.out"
  assert_contains "Approved exception packages:" "$TMP_DIR/allowed.out"
}

run_blocking_signature_mismatch_check() {
  local repo_dir="$TMP_DIR/repo-blocking"
  write_fixture_repo "$repo_dir"
  write_audit_json "$TMP_DIR/blocking-audit.json" '{
  "allowed-package": [
    {
      "id": 1002,
      "title": "totally-new-advisory",
      "severity": "high",
      "vulnerable_versions": "<=1.2.3"
    }
  ]
}'

  if env \
    PATH="$repo_dir/bin:$PATH" \
    FAKE_BUN_AUDIT_JSON="$TMP_DIR/blocking-audit.json" \
    FAKE_BUN_EXIT_CODE=1 \
    node "$ROOT_DIR/scripts/frontend-audit-check.mjs" \
      --root "$repo_dir" \
      --frontend-dir frontend \
      --audit-level high >"$TMP_DIR/blocking.out" 2>&1; then
    fail "signature mismatch should block"
  fi

  assert_contains "Blocking frontend audit findings:" "$TMP_DIR/blocking.out"
  assert_contains "totally-new-advisory" "$TMP_DIR/blocking.out"
}

run_expected_count_ceiling_check() {
  local repo_dir="$TMP_DIR/repo-count"
  write_fixture_repo "$repo_dir"
  write_audit_json "$TMP_DIR/count-audit.json" '{
  "allowed-package": [
    {
      "id": 1003,
      "title": "brace-expansion",
      "severity": "high",
      "vulnerable_versions": "<=1.2.3"
    },
    {
      "id": 1004,
      "title": "brace-expansion",
      "severity": "high",
      "vulnerable_versions": "<=1.2.3"
    }
  ]
}'

  if env \
    PATH="$repo_dir/bin:$PATH" \
    FAKE_BUN_AUDIT_JSON="$TMP_DIR/count-audit.json" \
    FAKE_BUN_EXIT_CODE=1 \
    node "$ROOT_DIR/scripts/frontend-audit-check.mjs" \
      --root "$repo_dir" \
      --frontend-dir frontend \
      --audit-level high >"$TMP_DIR/count.out" 2>&1; then
    fail "expected count ceiling should fail when audit count grows"
  fi

  assert_contains "Expected at most 1 high vulnerabilities" "$TMP_DIR/count.out"
}

run_lower_count_pass_check() {
  local repo_dir="$TMP_DIR/repo-lower-count"
  write_fixture_repo "$repo_dir"
  write_audit_json "$TMP_DIR/lower-count-audit.json" '{}'

  if ! env \
    PATH="$repo_dir/bin:$PATH" \
    FAKE_BUN_AUDIT_JSON="$TMP_DIR/lower-count-audit.json" \
    FAKE_BUN_EXIT_CODE=0 \
    node "$ROOT_DIR/scripts/frontend-audit-check.mjs" \
      --root "$repo_dir" \
      --frontend-dir frontend \
      --audit-level high >"$TMP_DIR/lower-count.out" 2>&1; then
    cat "$TMP_DIR/lower-count.out" >&2 || true
    fail "lower audit counts should pass"
  fi

  assert_contains "Observed 0 high vulnerabilities, below the approved exception ceiling of 1." "$TMP_DIR/lower-count.out"
}

run_critical_gate_skips_high_count_check() {
  local repo_dir="$TMP_DIR/repo-critical"
  write_fixture_repo "$repo_dir"
  write_audit_json "$TMP_DIR/critical-audit.json" '{
  "allowed-package": [
    {
      "id": 1005,
      "title": "brace-expansion",
      "severity": "high",
      "vulnerable_versions": "<=1.2.3"
    }
  ]
}'

  if ! env \
    PATH="$repo_dir/bin:$PATH" \
    FAKE_BUN_AUDIT_JSON="$TMP_DIR/critical-audit.json" \
    FAKE_BUN_EXIT_CODE=1 \
    node "$ROOT_DIR/scripts/frontend-audit-check.mjs" \
      --root "$repo_dir" \
      --frontend-dir frontend \
      --audit-level critical >"$TMP_DIR/critical.out" 2>&1; then
    cat "$TMP_DIR/critical.out" >&2 || true
    fail "critical-only gate should ignore high count expectations"
  fi

  assert_contains "Filtered findings at or above critical: 0" "$TMP_DIR/critical.out"
  assert_not_contains "Expected 1 high vulnerabilities" "$TMP_DIR/critical.out"
}

run_ceiling_covers_severities_above_the_threshold_check() {
  local repo_dir="$TMP_DIR/repo-ceiling-above"
  write_fixture_repo "$repo_dir"

  # The ceiling is the only check that sees *excepted* findings: `blocking`
  # has already waved them through. Reading a single `expectedCounts` key
  # therefore ties enforcement to wherever the threshold happens to sit, and
  # this change moves the threshold from `high` down to `moderate` -- so the
  # `high: 0` ceiling in both real policies is exactly what would have gone
  # quiet. Reproduced before fixing: this fixture exited 1 at `--audit-level
  # high` and 0 at `--audit-level moderate`, same input, same policy.
  cat >"$repo_dir/frontend/audit-policy-exceptions.json" <<'JSON'
{
  "policyName": "ceiling-above-threshold",
  "approvedOn": "2026-09-21",
  "reviewBy": "tests",
  "expectedCounts": {
    "high": 0,
    "moderate": 0
  },
  "exceptions": [
    {
      "name": "allowed-package",
      "severity": "high",
      "range": "<=1.2.3",
      "via": ["brace-expansion"],
      "reason": "Approved test exception."
    }
  ]
}
JSON

  write_audit_json "$TMP_DIR/ceiling-above-audit.json" '{
  "allowed-package": [
    {
      "id": 1009,
      "title": "brace-expansion",
      "severity": "high",
      "vulnerable_versions": "<=1.2.3"
    }
  ]
}'

  if env \
    PATH="$repo_dir/bin:$PATH" \
    FAKE_BUN_AUDIT_JSON="$TMP_DIR/ceiling-above-audit.json" \
    FAKE_BUN_EXIT_CODE=1 \
    node "$ROOT_DIR/scripts/frontend-audit-check.mjs" \
      --root "$repo_dir" \
      --workspace-dir frontend \
      --audit-level moderate >"$TMP_DIR/ceiling-above.out" 2>&1; then
    cat "$TMP_DIR/ceiling-above.out" >&2 || true
    fail "a moderate-threshold run must still enforce the high exception ceiling"
  fi

  assert_contains "Expected at most 0 high vulnerabilities" "$TMP_DIR/ceiling-above.out"
}

run_npm_shape_fails_closed_check() {
  local repo_dir="$TMP_DIR/repo-npm-shape"
  write_fixture_repo "$repo_dir"
  write_audit_json "$TMP_DIR/npm-shape-audit.json" '{
  "vulnerabilities": {},
  "metadata": {
    "vulnerabilities": {
      "high": 0,
      "critical": 0,
      "total": 0
    }
  }
}'

  if env \
    PATH="$repo_dir/bin:$PATH" \
    FAKE_BUN_AUDIT_JSON="$TMP_DIR/npm-shape-audit.json" \
    FAKE_BUN_EXIT_CODE=0 \
    node "$ROOT_DIR/scripts/frontend-audit-check.mjs" \
      --root "$repo_dir" \
      --frontend-dir frontend \
      --audit-level high >"$TMP_DIR/npm-shape.out" 2>&1; then
    fail "npm audit shaped JSON should fail closed"
  fi

  assert_contains "bun audit JSON schema mismatch" "$TMP_DIR/npm-shape.out"
}

run_real_bun_golden_fixture_check() {
  local repo_dir="$TMP_DIR/repo-real-bun-golden"
  write_fixture_repo "$repo_dir"
  python3 - "$repo_dir/frontend/audit-policy-exceptions.json" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
path.write_text('''{
  "policyName": "test-policy",
  "approvedOn": "2026-07-31",
  "reviewBy": "tests",
  "expectedCounts": {
    "critical": 1
  },
  "exceptions": [
    {
      "name": "minimist",
      "severity": "critical",
      "range": "<0.2.4",
      "via": ["Prototype Pollution in minimist"],
      "reason": "Approved test exception."
    }
  ]
}
''')
PY

  if ! env \
    PATH="$repo_dir/bin:$PATH" \
    FAKE_BUN_AUDIT_JSON="$ROOT_DIR/scripts/fixtures/bun-audit-minimist.json" \
    FAKE_BUN_EXIT_CODE=1 \
    node "$ROOT_DIR/scripts/frontend-audit-check.mjs" \
      --root "$repo_dir" \
      --frontend-dir frontend \
      --audit-level critical >"$TMP_DIR/real-bun-golden.out" 2>&1; then
    cat "$TMP_DIR/real-bun-golden.out" >&2 || true
    fail "real Bun audit golden fixture should pass with the matching exception"
  fi

  assert_contains "Raw bun audit counts: high=0, critical=1, moderate=1, total=2" \
    "$TMP_DIR/real-bun-golden.out"
  assert_contains "Approved exception packages:" "$TMP_DIR/real-bun-golden.out"
}

run_real_frontend_bun_audit_check() {
  if ! command -v bun >/dev/null 2>&1; then
    echo "bun not found; skipping real frontend bun audit check."
    return
  fi

  if ! node "$ROOT_DIR/scripts/frontend-audit-check.mjs" \
    --root "$ROOT_DIR" \
    --frontend-dir frontend \
    --audit-level high >"$TMP_DIR/real-frontend.out" 2>&1; then
    cat "$TMP_DIR/real-frontend.out" >&2 || true
    fail "real frontend bun audit should pass"
  fi

  assert_contains "Raw bun audit counts:" "$TMP_DIR/real-frontend.out"
}

run_missing_arg_check() {
  if node "$ROOT_DIR/scripts/frontend-audit-check.mjs" --root >"$TMP_DIR/missing-root.out" 2>&1; then
    fail "missing --root value should fail"
  fi

  assert_contains "Missing value for --root" "$TMP_DIR/missing-root.out"
}

# The script is pointed at one workspace at a time, and until now the only
# workspace anyone pointed it at was the frontend. These two cases lock the
# half of that which is not obvious from reading the script: that the messages
# name the directory actually audited, and that the original flag spelling
# still works so nothing that calls it has to be found and edited.
run_workspace_dir_names_the_audited_workspace_check() {
  local repo_dir="$TMP_DIR/repo-workspace"
  write_fixture_repo "$repo_dir"

  # Same fixture, re-homed under backend/. If the reporting were still
  # hardcoded to "frontend" this would pass while saying the wrong thing --
  # which is precisely how the real backend advisories went unreported.
  mkdir -p "$repo_dir/backend"
  cp "$repo_dir/frontend/audit-policy-exceptions.json" \
    "$repo_dir/backend/audit-policy-exceptions.json"

    # `{}` is bun's clean result: the report is a map of package name to
  # advisories, so an empty object is zero findings. An npm-shaped
  # `{"vulnerabilities": []}` is rejected by design -- see
  # run_npm_shape_fails_closed_check.
  write_audit_json "$TMP_DIR/workspace-audit.json" '{}'

  if ! env \
    PATH="$repo_dir/bin:$PATH" \
    FAKE_BUN_AUDIT_JSON="$TMP_DIR/workspace-audit.json" \
    FAKE_BUN_EXIT_CODE=0 \
    node "$ROOT_DIR/scripts/frontend-audit-check.mjs" \
      --root "$repo_dir" \
      --workspace-dir backend \
      --audit-level moderate >"$TMP_DIR/workspace.out" 2>&1; then
    cat "$TMP_DIR/workspace.out" >&2 || true
    fail "--workspace-dir backend should pass on a clean fixture"
  fi

  assert_contains "backend audit policy: test-policy" "$TMP_DIR/workspace.out"
  assert_contains "backend audit passed" "$TMP_DIR/workspace.out"
  assert_not_contains "Frontend audit" "$TMP_DIR/workspace.out"
}

run_frontend_dir_alias_still_works_check() {
  local repo_dir="$TMP_DIR/repo-alias"
  write_fixture_repo "$repo_dir"
    # `{}` is bun's clean result: the report is a map of package name to
  # advisories, so an empty object is zero findings. An npm-shaped
  # `{"vulnerabilities": []}` is rejected by design -- see
  # run_npm_shape_fails_closed_check.
  write_audit_json "$TMP_DIR/alias-audit.json" '{}'

  if ! env \
    PATH="$repo_dir/bin:$PATH" \
    FAKE_BUN_AUDIT_JSON="$TMP_DIR/alias-audit.json" \
    FAKE_BUN_EXIT_CODE=0 \
    node "$ROOT_DIR/scripts/frontend-audit-check.mjs" \
      --root "$repo_dir" \
      --frontend-dir frontend \
      --audit-level high >"$TMP_DIR/alias.out" 2>&1; then
    cat "$TMP_DIR/alias.out" >&2 || true
    fail "--frontend-dir must keep working as an alias for --workspace-dir"
  fi

  assert_contains "frontend audit passed" "$TMP_DIR/alias.out"
}

# The real backend tree, alongside the frontend one the suite already checks.
# The five advisories this workspace carried were all `moderate`, so a `high`
# threshold here would report clean on the exact findings that motivated
# auditing it at all -- hence the level, not just the directory.
run_real_backend_bun_audit_check() {
  if ! command -v bun >/dev/null 2>&1; then
    echo "bun not found; skipping real backend bun audit check."
    return 0
  fi

  if ! node "$ROOT_DIR/scripts/frontend-audit-check.mjs" \
    --root "$ROOT_DIR" \
    --workspace-dir backend \
    --audit-level moderate >"$TMP_DIR/real-backend.out" 2>&1; then
    cat "$TMP_DIR/real-backend.out" >&2 || true
    fail "real backend bun audit should pass"
  fi

  assert_contains "Raw bun audit counts:" "$TMP_DIR/real-backend.out"
  assert_contains "backend audit passed" "$TMP_DIR/real-backend.out"
}

main() {
  run_allowed_exception_check
  run_blocking_signature_mismatch_check
  run_expected_count_ceiling_check
  run_lower_count_pass_check
  run_critical_gate_skips_high_count_check
  run_ceiling_covers_severities_above_the_threshold_check
  run_npm_shape_fails_closed_check
  run_real_bun_golden_fixture_check
  run_real_frontend_bun_audit_check
  run_workspace_dir_names_the_audited_workspace_check
  run_frontend_dir_alias_still_works_check
  run_real_backend_bun_audit_check
  run_missing_arg_check
  echo "frontend audit check tests passed."
}

main "$@"
