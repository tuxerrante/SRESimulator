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

  cat >"$repo_dir/frontend/audit-policy-exceptions.json" <<'EOF'
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
EOF

  cat >"$repo_dir/bin/bun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cat "${FAKE_BUN_AUDIT_JSON:?}"
if [ "${FAKE_BUN_EXIT_CODE:-0}" -ne 0 ]; then
  exit "${FAKE_BUN_EXIT_CODE}"
fi
EOF
  chmod +x "$repo_dir/bin/bun"
}

write_audit_json() {
  local target=$1 body=$2
  cat >"$target" <<EOF
${body}
EOF
}

run_allowed_exception_check() {
  local repo_dir="$TMP_DIR/repo-allowed"
  write_fixture_repo "$repo_dir"
  write_audit_json "$TMP_DIR/allowed-audit.json" '{
  "vulnerabilities": {
    "allowed-package": {
      "name": "allowed-package",
      "severity": "high",
      "via": [{"name": "brace-expansion"}],
      "range": "<=1.2.3",
      "fixAvailable": false
    }
  },
  "metadata": {
    "vulnerabilities": {
      "high": 1,
      "critical": 0,
      "total": 1
    }
  }
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

  assert_contains "Frontend audit passed with only approved exception packages remaining." "$TMP_DIR/allowed.out"
  assert_contains "Approved exception packages:" "$TMP_DIR/allowed.out"
}

run_blocking_signature_mismatch_check() {
  local repo_dir="$TMP_DIR/repo-blocking"
  write_fixture_repo "$repo_dir"
  write_audit_json "$TMP_DIR/blocking-audit.json" '{
  "vulnerabilities": {
    "allowed-package": {
      "name": "allowed-package",
      "severity": "high",
      "via": [{"name": "totally-new-advisory"}],
      "range": "<=1.2.3",
      "fixAvailable": false
    }
  },
  "metadata": {
    "vulnerabilities": {
      "high": 1,
      "critical": 0,
      "total": 1
    }
  }
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
  "vulnerabilities": {
    "allowed-package": {
      "name": "allowed-package",
      "severity": "high",
      "via": [{"name": "brace-expansion"}],
      "range": "<=1.2.3",
      "fixAvailable": false
    }
  },
  "metadata": {
    "vulnerabilities": {
      "high": 2,
      "critical": 0,
      "total": 2
    }
  }
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
  write_audit_json "$TMP_DIR/lower-count-audit.json" '{
  "vulnerabilities": {},
  "metadata": {
    "vulnerabilities": {
      "high": 0,
      "critical": 0,
      "total": 0
    }
  }
}'

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
  "vulnerabilities": {
    "allowed-package": {
      "name": "allowed-package",
      "severity": "high",
      "via": [{"name": "brace-expansion"}],
      "range": "<=1.2.3",
      "fixAvailable": false
    }
  },
  "metadata": {
    "vulnerabilities": {
      "high": 99,
      "critical": 0,
      "total": 99
    }
  }
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

run_missing_arg_check() {
  if node "$ROOT_DIR/scripts/frontend-audit-check.mjs" --root >"$TMP_DIR/missing-root.out" 2>&1; then
    fail "missing --root value should fail"
  fi

  assert_contains "Missing value for --root" "$TMP_DIR/missing-root.out"
}

main() {
  run_allowed_exception_check
  run_blocking_signature_mismatch_check
  run_expected_count_ceiling_check
  run_lower_count_pass_check
  run_critical_gate_skips_high_count_check
  run_missing_arg_check
  echo "frontend audit check tests passed."
}

main "$@"
