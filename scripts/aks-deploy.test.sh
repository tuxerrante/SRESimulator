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

capture_helm_invocation() {
  : >"$TMP_DIR/helm-args.txt"
  rm -f "$TMP_DIR/captured-values.yaml"

  helm() {
    local idx arg

    printf '%s\n' "$@" >"$TMP_DIR/helm-args.txt"
    for ((idx = 1; idx <= $#; idx++)); do
      arg="${!idx}"
      if [[ "$arg" == "-f" ]]; then
        idx=$((idx + 1))
        cp "${!idx}" "$TMP_DIR/captured-values.yaml"
      fi
    done
  }
}

stub_cluster_helpers() {
  require_cli() { :; }
  ensure_namespace() { :; }
  resolve_aks_public_endpoint() {
    AKS_FRONTEND_PUBLIC_IP_NAME="example-frontend-pip"
    AKS_FRONTEND_PUBLIC_IP="203.0.113.10"
    AKS_FRONTEND_PUBLIC_FQDN="aks.example.test"
    AKS_FRONTEND_PUBLIC_ENDPOINT_HOST="${AKS_FRONTEND_PUBLIC_HOST:-$AKS_FRONTEND_PUBLIC_FQDN}"
  }
}

run_latest_tag_check() {
  # shellcheck disable=SC1091
  source "$ROOT_DIR/scripts/aks-deploy.sh"
  stub_cluster_helpers
  capture_helm_invocation

  unset DEPLOY_HOST DEPLOY_SCHEME || true
  E2E_RELEASE="sre-simulator"
  AKS_RG="example-aks-rg"
  AKS_CLUSTER="example-aks"
  AOAI_DEPLOYMENT="gpt-4o-mini"
  unset AOAI_MODEL || true

  if ! helm_deploy_sre "sre-simulator" "latest" "probe-token" >"$TMP_DIR/latest.txt" 2>&1; then
    cat "$TMP_DIR/latest.txt" >&2 || true
    fail "helm_deploy_sre should succeed for a mutable latest tag"
  fi

  assert_contains "frontend.image.pullPolicy=Always" "$TMP_DIR/helm-args.txt"
  assert_contains "backend.image.pullPolicy=Always" "$TMP_DIR/helm-args.txt"
  assert_contains "ai.provider=azure-openai" "$TMP_DIR/helm-args.txt"
  assert_contains "ai.mockMode=false" "$TMP_DIR/helm-args.txt"
  assert_contains "ai.model=gpt-4o-mini" "$TMP_DIR/helm-args.txt"
  assert_contains "ai.azureOpenai.deployment=gpt-4o-mini" "$TMP_DIR/helm-args.txt"
  assert_contains "ai.azureOpenai.endpointFromSecret.existingSecretName=azure-openai-creds" "$TMP_DIR/helm-args.txt"
  assert_contains "ai.azureOpenai.endpointFromSecret.key=endpoint" "$TMP_DIR/helm-args.txt"
  assert_contains "ai.azureOpenai.credentials.existingSecretName=azure-openai-creds" "$TMP_DIR/helm-args.txt"
  assert_contains "ai.azureOpenai.credentials.key=api-key" "$TMP_DIR/helm-args.txt"
  assert_not_contains "ai.azureOpenai.existingSecretName=azure-openai-creds" "$TMP_DIR/helm-args.txt"
  assert_contains 'host: "aks.example.test"' "$TMP_DIR/captured-values.yaml"
  assert_contains 'scheme: "http"' "$TMP_DIR/captured-values.yaml"
  assert_contains 'loadBalancerIP: "203.0.113.10"' "$TMP_DIR/captured-values.yaml"
}

run_immutable_tag_check() {
  # shellcheck disable=SC1091
  source "$ROOT_DIR/scripts/aks-deploy.sh"
  stub_cluster_helpers
  capture_helm_invocation

  E2E_RELEASE="sre-simulator"
  AKS_RG="example-aks-rg"
  AKS_CLUSTER="example-aks"
  AOAI_DEPLOYMENT="gpt-4o-mini"
  AOAI_MODEL="gpt-4.1"

  if ! helm_deploy_sre "sre-simulator" "v1.2.3" "probe-token" >"$TMP_DIR/immutable.txt" 2>&1; then
    cat "$TMP_DIR/immutable.txt" >&2 || true
    fail "helm_deploy_sre should succeed for an immutable semver tag"
  fi

  assert_contains "frontend.image.pullPolicy=IfNotPresent" "$TMP_DIR/helm-args.txt"
  assert_contains "backend.image.pullPolicy=IfNotPresent" "$TMP_DIR/helm-args.txt"
  assert_contains "ai.model=gpt-4.1" "$TMP_DIR/helm-args.txt"
}

main() {
  run_latest_tag_check
  run_immutable_tag_check
  echo "AKS deploy helper tests passed."
}

main "$@"
