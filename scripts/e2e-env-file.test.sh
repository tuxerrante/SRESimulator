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

run_env_fallback_check() {
  local backend_dir output_file

  backend_dir="$TMP_DIR/fallback-backend"
  output_file="$TMP_DIR/env-check-fallback.out"
  mkdir -p "$backend_dir"

  cat >"$backend_dir/.env" <<'EOF'
AZURE_SUBSCRIPTION_ID=00000000-0000-0000-0000-000000000001
CLUSTER_FLAVOR=aks
AKS_RG=test-aks-rg
AKS_CLUSTER=test-aks
AKS_FRONTEND_PUBLIC_IP_NAME=test-aks-frontend-pip
AKS_E2E_EXPOSURE_MODE=none
AOAI_RG=test-aoai-rg
AOAI_ACCOUNT=test-aoai
AOAI_DEPLOYMENT=gpt-4o-mini
EOF

  if ! env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
    make -s -C "$ROOT_DIR" env-check BACKEND_DIR="$backend_dir" >"$output_file" 2>&1; then
    cat "$output_file" >&2 || true
    fail "env-check should fall back to backend/.env when .env.local is absent"
  fi

  assert_contains "E2E env file: $backend_dir/.env (fallback from $backend_dir/.env.local)" "$output_file"
  assert_contains "AZURE_SUBSCRIPTION_ID: $backend_dir/.env" "$output_file"
  assert_contains "AKS_RG: $backend_dir/.env" "$output_file"
  assert_not_contains "Missing required e2e vars:" "$output_file"
}

run_missing_env_diagnostic_check() {
  local backend_dir output_file

  backend_dir="$TMP_DIR/missing-backend"
  output_file="$TMP_DIR/env-check-missing.out"
  mkdir -p "$backend_dir"

  if env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
    make -s -C "$ROOT_DIR" env-check BACKEND_DIR="$backend_dir" >"$output_file" 2>&1; then
    cat "$output_file" >&2 || true
    fail "env-check should fail when neither backend/.env.local nor backend/.env exists"
  fi

  assert_contains "E2E env file: $backend_dir/.env.local (missing; fallback $backend_dir/.env also missing)" "$output_file"
  assert_contains "AZURE_SUBSCRIPTION_ID: make (file)" "$output_file"
  assert_contains "Missing required e2e vars: AZURE_SUBSCRIPTION_ID AOAI_RG AOAI_ACCOUNT AOAI_DEPLOYMENT AKS_RG AKS_CLUSTER" "$output_file"
}

main() {
  run_env_fallback_check
  run_missing_env_diagnostic_check
  echo "e2e env file tests passed."
}

main "$@"
