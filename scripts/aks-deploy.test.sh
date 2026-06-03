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

assert_equals() {
  local expected=$1 actual=$2 message=${3:-"values differ"}
  if [ "$expected" != "$actual" ]; then
    fail "$message (expected '$expected', got '$actual')"
  fi
}

assert_matches() {
  local pattern=$1 file=$2
  grep -Eq "$pattern" "$file" || fail "expected pattern '$pattern' in $file"
}

assert_not_matches() {
  local pattern=$1 file=$2
  if grep -Eq "$pattern" "$file"; then
    fail "did not expect pattern '$pattern' in $file"
  fi
}

assert_call_count_at_most() {
  local max_calls=$1 file=$2
  local call_count

  call_count=$(wc -l <"$file")
  if [ "$call_count" -gt "$max_calls" ]; then
    fail "expected at most $max_calls calls recorded in $file, got $call_count"
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

write_fake_kubectl() {
  mkdir -p "$TMP_DIR/bin"
  cat >"$TMP_DIR/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

log_file="${FAKE_KUBECTL_LOG:?}"
printf '%s\n' "$*" >>"$log_file"

not_found() {
  echo "Error from server (NotFound): $1" >&2
  exit 1
}

if [ "${1:-}" = "-n" ]; then
  namespace="${2:-}"
  shift 2
else
  namespace=""
fi

verb="${1:-}"
resource="${2:-}"
output_flag="${3:-}"
output_value="${4:-}"

if [ "$verb" = "get" ] && [ "$resource" = "namespace" ]; then
  exit 0
fi

case "${verb}:${resource}" in
  get:pods)
    printf '%s\n' 'NAME READY STATUS'
    ;;
  get:deployments)
    printf '%s\n' 'NAME READY UP-TO-DATE AVAILABLE AGE'
    ;;
  get:svc/sre-simulator-frontend)
    if [ "$output_flag" = "-o" ] && [ "$output_value" = "jsonpath={.spec.type}" ]; then
      printf '%s' "${FAKE_FRONTEND_SERVICE_TYPE:-ClusterIP}"
    elif [ "$output_flag" = "-o" ] && [ "$output_value" = "jsonpath={.spec.ports[0].port}" ]; then
      printf '%s' "${FAKE_FRONTEND_SERVICE_PORT:-80}"
    else
      printf '%s\n' 'NAME TYPE CLUSTER-IP EXTERNAL-IP PORT(S) AGE'
    fi
    ;;
  get:svc/sre-simulator-backend)
    if [ "$output_flag" = "-o" ] && [ "$output_value" = "jsonpath={.spec.type}" ]; then
      printf '%s' "${FAKE_BACKEND_SERVICE_TYPE:-ClusterIP}"
    else
      printf '%s\n' 'NAME TYPE CLUSTER-IP EXTERNAL-IP PORT(S) AGE'
    fi
    ;;
  get:ingress/sre-simulator)
    if [ "${FAKE_FRONTEND_INGRESS_EXISTS:-0}" = "1" ]; then
      exit 0
    fi
    not_found 'ingresses.networking.k8s.io "sre-simulator" not found'
    ;;
  get:ingress/sre-simulator-backend)
    if [ "${FAKE_BACKEND_INGRESS_EXISTS:-0}" = "1" ]; then
      exit 0
    fi
    not_found 'ingresses.networking.k8s.io "sre-simulator-backend" not found'
    ;;
  get:gateway/sre-simulator)
    if [ "${FAKE_GATEWAY_EXISTS:-0}" = "1" ]; then
      exit 0
    fi
    not_found 'gateways.gateway.networking.k8s.io "sre-simulator" not found'
    ;;
  get:httproute/sre-simulator)
    if [ "${FAKE_HTTPROUTE_MAIN_EXISTS:-0}" = "1" ]; then
      exit 0
    fi
    not_found 'httproutes.gateway.networking.k8s.io "sre-simulator" not found'
    ;;
  get:httproute/sre-simulator-redirect)
    if [ "${FAKE_HTTPROUTE_REDIRECT_EXISTS:-0}" = "1" ]; then
      exit 0
    fi
    not_found 'httproutes.gateway.networking.k8s.io "sre-simulator-redirect" not found'
    ;;
  get:certificate)
    if [ "$output_flag" = "-o" ]; then
      printf '%s' "${FAKE_CERTIFICATE_LIST:-}"
    else
      printf '%s\n' 'NAME READY SECRET AGE'
    fi
    ;;
  get:gateway,httproute,certificate)
    printf '%s\n' 'NAME READY AGE'
    ;;
  *)
    echo "unexpected fake kubectl invocation: namespace=${namespace} args=$*" >&2
    exit 1
    ;;
esac
EOF
  chmod +x "$TMP_DIR/bin/kubectl"
}

write_fake_e2e_clis() {
  mkdir -p "$TMP_DIR/e2e-bin"

  cat >"$TMP_DIR/e2e-bin/az" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"${FAKE_AZ_LOG:?}"

case "$*" in
  "account show --query id -o tsv")
    printf '%s\n' "${FAKE_AZ_ACCOUNT_ID:-00000000-0000-0000-0000-000000000001}"
    ;;
  account\ set\ -s\ *)
    ;;
  aks\ get-credentials\ *)
    ;;
  cognitiveservices\ account\ show\ *)
    printf '%s\n' "${FAKE_AOAI_ENDPOINT:-https://aoai.example.test/}"
    ;;
  cognitiveservices\ account\ keys\ list\ *)
    printf '%s\n' "${FAKE_AOAI_KEY:-fake-aoai-key}"
    ;;
  network\ public-ip\ show\ *"--query ipAddress -o tsv")
    printf '%s\n' "${FAKE_AKS_PUBLIC_IP:-203.0.113.10}"
    ;;
  network\ public-ip\ show\ *"--query dnsSettings.fqdn -o tsv")
    printf '%s\n' "${FAKE_AKS_PUBLIC_FQDN:-aks.example.test}"
    ;;
  *)
    echo "unexpected fake az invocation: $*" >&2
    exit 1
    ;;
esac
EOF
  chmod +x "$TMP_DIR/e2e-bin/az"

  cat >"$TMP_DIR/e2e-bin/helm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

log_file="${FAKE_HELM_LOG:?}"
capture_file="${FAKE_HELM_VALUES_CAPTURE:?}"
printf '%s\n' "$*" >>"$log_file"
rm -f "$capture_file"

idx=1
while [ "$idx" -le "$#" ]; do
  eval "arg=\${$idx}"
  if [ "$arg" = "-f" ]; then
    idx=$((idx + 1))
    eval "values_file=\${$idx}"
    cp "$values_file" "$capture_file"
  fi
  idx=$((idx + 1))
done
EOF
  chmod +x "$TMP_DIR/e2e-bin/helm"

  cat >"$TMP_DIR/e2e-bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"${FAKE_CURL_LOG:?}"

for arg in "$@"; do
  if [ "$arg" = "-w" ]; then
    printf '200'
    exit 0
  fi
done

printf '%s\n' '{"ok":true}'
EOF
  chmod +x "$TMP_DIR/e2e-bin/curl"

  cat >"$TMP_DIR/e2e-bin/nohup" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"${FAKE_NOHUP_LOG:?}"
exec "$@"
EOF
  chmod +x "$TMP_DIR/e2e-bin/nohup"

  cat >"$TMP_DIR/e2e-bin/kubectl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

log_file="${FAKE_KUBECTL_LOG:?}"
state_dir="${FAKE_KUBECTL_STATE_DIR:?}"
mkdir -p "$state_dir/namespaces"

printf '%s\n' "$*" >>"$log_file"

if [ "${1:-}" = "-n" ]; then
  namespace="${2:-}"
  shift 2
else
  namespace=""
fi

command="$*"

case "$command" in
  "get namespace "*)
    target_ns="${command#get namespace }"
    [ -f "$state_dir/namespaces/$target_ns" ]
    ;;
  get\ namespace/*)
    target_ns="${command#get namespace/}"
    [ -f "$state_dir/namespaces/$target_ns" ]
    ;;
  "create namespace "*)
    target_ns="${command#create namespace }"
    : >"$state_dir/namespaces/$target_ns"
    ;;
  create\ secret\ generic\ azure-openai-creds*)
    printf '%s\n' \
      'apiVersion: v1' \
      'kind: Secret' \
      'metadata:' \
      '  name: azure-openai-creds'
    ;;
  "apply -f -")
    cat >/dev/null
    ;;
  rollout\ status\ deployment/*)
    ;;
  port-forward\ svc/sre-simulator-frontend\ *)
    sleep "${FAKE_PORT_FORWARD_SLEEP:-5}"
    ;;
  *)
    echo "unexpected fake kubectl invocation: namespace=${namespace} args=$command" >&2
    exit 1
    ;;
esac
EOF
  chmod +x "$TMP_DIR/e2e-bin/kubectl"
}

cleanup_port_forward_from_metadata() {
  local metadata_file=$1
  local port_forward_pid=""

  if [ ! -f "$metadata_file" ]; then
    return 0
  fi

  port_forward_pid="$(sed -n 's/^PORT_FORWARD_PID=//p' "$metadata_file")"
  if [ -n "$port_forward_pid" ] && printf '%s\n' "$port_forward_pid" | grep -Eq '^[0-9]+$'; then
    kill "$port_forward_pid" >/dev/null 2>&1 || true
  fi
}

stub_cluster_helpers() {
  require_cli() { :; }
  ensure_namespace() { :; }
  resolve_aks_public_endpoint() {
    AKS_FRONTEND_PUBLIC_IP_NAME="example-frontend-pip"
    AKS_FRONTEND_PUBLIC_IP="203.0.113.10"
    AKS_FRONTEND_PUBLIC_FQDN="aks.example.test"
    AKS_FRONTEND_PUBLIC_ENDPOINT_HOST="aks.example.test"
  }
}

run_latest_tag_check() {
  # shellcheck disable=SC1091
  source "$ROOT_DIR/scripts/aks-deploy.sh"
  stub_cluster_helpers
  capture_helm_invocation

  unset DEPLOY_HOST DEPLOY_SCHEME || true
  unset AKS_FRONTEND_PUBLIC_HOST AKS_FRONTEND_PUBLIC_ORIGIN_SCHEME || true
  unset AKS_GATEWAY_HOST AKS_GATEWAY_CLASS_NAME \
    AKS_CLUSTER_ISSUER_NAME AKS_GATEWAY_TLS_SECRET_NAME || true
  E2E_RELEASE="sre-simulator"
  AKS_RG="example-aks-rg"
  AKS_CLUSTER="example-aks"
  AKS_EXPOSURE_MODE="publicService"
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

run_gateway_values_check() {
  local values_file

  # shellcheck disable=SC1091
  source "$ROOT_DIR/scripts/aks-deploy.sh"

  unset AOAI_MODEL || true
  E2E_RELEASE="sre-simulator"
  AKS_RG="aaffinit-test-rg"
  AKS_CLUSTER="aaffinit-test"
  AKS_EXPOSURE_MODE="gateway"
  DEPLOY_HOST="play.sresimulator.osadev.cloud"
  DEPLOY_SCHEME="https"
  AKS_GATEWAY_HOST="play.sresimulator.osadev.cloud"
  AKS_GATEWAY_CLASS_NAME="eg"
  AKS_CLUSTER_ISSUER_NAME="letsencrypt-azuredns-prod"
  AKS_GATEWAY_TLS_SECRET_NAME="sre-simulator-gateway-tls"

  if ! values_file="$(write_aks_exposure_values 2>"$TMP_DIR/gateway.txt")"; then
    cat "$TMP_DIR/gateway.txt" >&2 || true
    fail "write_aks_exposure_values should support AKS gateway mode"
  fi

  assert_contains 'mode: "gateway"' "$values_file"
  assert_contains 'host: "play.sresimulator.osadev.cloud"' "$values_file"
  assert_contains 'scheme: "https"' "$values_file"
  assert_contains 'className: "eg"' "$values_file"
  assert_contains 'clusterIssuer: "letsencrypt-azuredns-prod"' "$values_file"
  assert_contains 'secretName: "sre-simulator-gateway-tls"' "$values_file"
  assert_not_contains 'loadBalancerIP:' "$values_file"
  assert_not_contains 'azure-pip-name' "$values_file"
  rm -f "$values_file"
}

run_gateway_deploy_path_check() {
  # shellcheck disable=SC1091
  source "$ROOT_DIR/scripts/aks-deploy.sh"
  stub_cluster_helpers
  capture_helm_invocation

  ensure_aks_gateway_stack() {
    printf '%s\n' "$1" >"$TMP_DIR/gateway-stack-ns.txt"
  }

  unset DEPLOY_HOST DEPLOY_SCHEME || true
  E2E_RELEASE="sre-simulator"
  AKS_RG="example-aks-rg"
  AKS_CLUSTER="example-aks"
  AKS_EXPOSURE_MODE="gateway"
  AKS_GATEWAY_HOST="play.sresimulator.osadev.cloud"
  AKS_GATEWAY_CLASS_NAME="eg"
  AKS_CLUSTER_ISSUER_NAME="letsencrypt-azuredns-prod"
  AKS_GATEWAY_TLS_SECRET_NAME="sre-simulator-gateway-tls"
  AOAI_DEPLOYMENT="gpt-4o-mini"
  unset AOAI_MODEL || true

  if ! helm_deploy_sre "sre-simulator" "latest" "probe-token" >"$TMP_DIR/gateway-deploy.txt" 2>&1; then
    cat "$TMP_DIR/gateway-deploy.txt" >&2 || true
    fail "helm_deploy_sre should support the AKS gateway deploy path"
  fi

  assert_contains "sre-simulator" "$TMP_DIR/gateway-stack-ns.txt"
  assert_equals "play.sresimulator.osadev.cloud" "$DEPLOY_HOST" "gateway deploy path should use AKS_GATEWAY_HOST"
  assert_equals "https" "$DEPLOY_SCHEME" "gateway deploy path should force https"
  assert_contains 'mode: "gateway"' "$TMP_DIR/captured-values.yaml"
  assert_contains 'host: "play.sresimulator.osadev.cloud"' "$TMP_DIR/captured-values.yaml"
  assert_contains 'scheme: "https"' "$TMP_DIR/captured-values.yaml"
  assert_not_contains 'loadBalancerIP:' "$TMP_DIR/captured-values.yaml"
  assert_not_contains 'azure-pip-name' "$TMP_DIR/captured-values.yaml"
}

run_gateway_deploy_skip_bootstrap_check() {
  # shellcheck disable=SC1091
  source "$ROOT_DIR/scripts/aks-deploy.sh"
  stub_cluster_helpers
  capture_helm_invocation

  ensure_aks_gateway_stack() {
    printf '%s\n' "$1" >"$TMP_DIR/gateway-stack-skipped.txt"
  }

  unset DEPLOY_HOST DEPLOY_SCHEME || true
  E2E_RELEASE="sre-simulator"
  AKS_RG="example-aks-rg"
  AKS_CLUSTER="example-aks"
  AKS_EXPOSURE_MODE="gateway"
  AKS_SKIP_GATEWAY_BOOTSTRAP="true"
  AKS_GATEWAY_HOST="play.sresimulator.osadev.cloud"
  AKS_GATEWAY_CLASS_NAME="eg"
  AKS_CLUSTER_ISSUER_NAME="letsencrypt-azuredns-prod"
  AKS_GATEWAY_TLS_SECRET_NAME="sre-simulator-gateway-tls"
  AOAI_DEPLOYMENT="gpt-4o-mini"
  unset AOAI_MODEL || true

  if ! helm_deploy_sre "sre-simulator" "latest" "probe-token" >"$TMP_DIR/gateway-skip-bootstrap.txt" 2>&1; then
    cat "$TMP_DIR/gateway-skip-bootstrap.txt" >&2 || true
    fail "helm_deploy_sre should allow gateway bootstrap to be skipped explicitly"
  fi

  if [ -e "$TMP_DIR/gateway-stack-skipped.txt" ]; then
    fail "helm_deploy_sre should not bootstrap the shared gateway stack when AKS_SKIP_GATEWAY_BOOTSTRAP=true"
  fi
  assert_equals "play.sresimulator.osadev.cloud" "$DEPLOY_HOST" "skipping bootstrap should still use AKS_GATEWAY_HOST"
  assert_equals "https" "$DEPLOY_SCHEME" "skipping bootstrap should still force https"
  assert_contains 'mode: "gateway"' "$TMP_DIR/captured-values.yaml"
}

run_none_values_check() {
  local values_file

  # shellcheck disable=SC1091
  source "$ROOT_DIR/scripts/aks-deploy.sh"

  unset AOAI_MODEL || true
  E2E_RELEASE="sre-simulator"
  AKS_RG="aaffinit-test-rg"
  AKS_CLUSTER="aaffinit-test"
  AKS_EXPOSURE_MODE="none"
  AKS_LOCAL_PORT_FORWARD_PORT="38080"
  DEPLOY_HOST="127.0.0.1:38080"
  DEPLOY_SCHEME="http"

  if ! values_file="$(write_aks_exposure_values 2>"$TMP_DIR/none.txt")"; then
    cat "$TMP_DIR/none.txt" >&2 || true
    fail "write_aks_exposure_values should support AKS none mode"
  fi

  assert_contains 'mode: "none"' "$values_file"
  assert_contains 'host: "127.0.0.1:38080"' "$values_file"
  assert_contains 'scheme: "http"' "$values_file"
  assert_not_contains 'loadBalancerIP:' "$values_file"
  assert_not_contains 'azure-pip-name' "$values_file"
  rm -f "$values_file"
}

run_none_deploy_path_check() {
  # shellcheck disable=SC1091
  source "$ROOT_DIR/scripts/aks-deploy.sh"
  stub_cluster_helpers
  capture_helm_invocation

  resolve_aks_public_endpoint() {
    fail "helm_deploy_sre should not resolve the public endpoint in AKS none mode"
  }

  ensure_aks_gateway_stack() {
    fail "helm_deploy_sre should not bootstrap the gateway stack in AKS none mode"
  }

  unset DEPLOY_HOST DEPLOY_SCHEME || true
  E2E_RELEASE="sre-simulator"
  AKS_RG="example-aks-rg"
  AKS_CLUSTER="example-aks"
  AKS_EXPOSURE_MODE="none"
  AKS_LOCAL_PORT_FORWARD_PORT="38080"
  AOAI_DEPLOYMENT="gpt-4o-mini"
  unset AOAI_MODEL || true

  if ! helm_deploy_sre "sre-simulator" "latest" "probe-token" >"$TMP_DIR/none-deploy.txt" 2>&1; then
    cat "$TMP_DIR/none-deploy.txt" >&2 || true
    fail "helm_deploy_sre should support the AKS none deploy path"
  fi

  assert_equals "127.0.0.1:38080" "$DEPLOY_HOST" "none deploy path should use the local port-forward host"
  assert_equals "http" "$DEPLOY_SCHEME" "none deploy path should use http"
  assert_contains 'mode: "none"' "$TMP_DIR/captured-values.yaml"
  assert_contains 'host: "127.0.0.1:38080"' "$TMP_DIR/captured-values.yaml"
  assert_contains 'scheme: "http"' "$TMP_DIR/captured-values.yaml"
  assert_not_contains 'loadBalancerIP:' "$TMP_DIR/captured-values.yaml"
}

run_immutable_tag_check() {
  # shellcheck disable=SC1091
  source "$ROOT_DIR/scripts/aks-deploy.sh"
  stub_cluster_helpers
  capture_helm_invocation

  unset AKS_GATEWAY_HOST AKS_GATEWAY_CLASS_NAME \
    AKS_CLUSTER_ISSUER_NAME AKS_GATEWAY_TLS_SECRET_NAME || true
  unset AKS_FRONTEND_PUBLIC_HOST AKS_FRONTEND_PUBLIC_ORIGIN_SCHEME || true
  E2E_RELEASE="sre-simulator"
  AKS_RG="example-aks-rg"
  AKS_CLUSTER="example-aks"
  AKS_EXPOSURE_MODE="publicService"
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

run_frontend_auth_secret_flag_check() {
  # shellcheck disable=SC1091
  source "$ROOT_DIR/scripts/aks-deploy.sh"
  stub_cluster_helpers
  capture_helm_invocation

  unset AKS_GATEWAY_HOST AKS_GATEWAY_CLASS_NAME \
    AKS_CLUSTER_ISSUER_NAME AKS_GATEWAY_TLS_SECRET_NAME || true
  E2E_RELEASE="sre-simulator"
  AKS_RG="example-aks-rg"
  AKS_CLUSTER="example-aks"
  AKS_EXPOSURE_MODE="publicService"
  AOAI_DEPLOYMENT="gpt-4o-mini"
  GITHUB_AUTH_SECRET_NAME="sre-auth-secrets"

  if ! helm_deploy_sre "sre-simulator" "latest" "probe-token" >"$TMP_DIR/auth-secret.txt" 2>&1; then
    cat "$TMP_DIR/auth-secret.txt" >&2 || true
    fail "helm_deploy_sre should pass frontend auth secret settings when configured"
  fi

  assert_contains "frontend.auth.existingSecretName=sre-auth-secrets" "$TMP_DIR/helm-args.txt"
}

run_clusterissuer_manifest_check() {
  local manifest

  # shellcheck disable=SC1091
  source "$ROOT_DIR/scripts/aks-deploy.sh"

  AZURE_SUBSCRIPTION_ID="fe16a035-e540-4ab7-80d9-373fa9a3d6ae"
  AKS_DNS_ZONE_NAME="osadev.cloud"
  AKS_DNS_ZONE_RESOURCE_GROUP="dns"
  AKS_CERT_MANAGER_ACME_EMAIL="aaffinit@redhat.com"
  AKS_CERT_MANAGER_IDENTITY_CLIENT_ID="00000000-0000-0000-0000-000000000099"

  manifest="$(write_aks_clusterissuer_manifest)"
  assert_contains 'name: letsencrypt-azuredns-staging' "$manifest"
  assert_contains 'name: letsencrypt-azuredns-prod' "$manifest"
  assert_contains 'subscriptionID: fe16a035-e540-4ab7-80d9-373fa9a3d6ae' "$manifest"
  assert_contains 'resourceGroupName: dns' "$manifest"
  assert_contains 'hostedZoneName: osadev.cloud' "$manifest"
  assert_contains 'clientID: 00000000-0000-0000-0000-000000000099' "$manifest"
  rm -f "$manifest"
}

run_clusterissuer_manifest_requires_email_check() {
  # shellcheck disable=SC1091
  source "$ROOT_DIR/scripts/aks-deploy.sh"

  AZURE_SUBSCRIPTION_ID="fe16a035-e540-4ab7-80d9-373fa9a3d6ae"
  AKS_DNS_ZONE_NAME="osadev.cloud"
  AKS_DNS_ZONE_RESOURCE_GROUP="dns"
  AKS_CERT_MANAGER_IDENTITY_CLIENT_ID="00000000-0000-0000-0000-000000000099"
  unset AKS_CERT_MANAGER_ACME_EMAIL || true

  if write_aks_clusterissuer_manifest >"$TMP_DIR/clusterissuer-missing-email.out" 2>"$TMP_DIR/clusterissuer-missing-email.err"; then
    fail "write_aks_clusterissuer_manifest should require an explicit ACME email"
  fi

  assert_contains "AKS_CERT_MANAGER_ACME_EMAIL is required to render AKS cert-manager ClusterIssuers" "$TMP_DIR/clusterissuer-missing-email.err"
}

run_gatewayclass_manifest_check() {
  local manifest

  # shellcheck disable=SC1091
  source "$ROOT_DIR/scripts/aks-deploy.sh"

  AKS_GATEWAY_CLASS_NAME="eg"

  manifest="$(write_aks_gatewayclass_manifest)"
  assert_contains 'kind: GatewayClass' "$manifest"
  assert_contains 'name: eg' "$manifest"
  assert_contains 'controllerName: gateway.envoyproxy.io/gatewayclass-controller' "$manifest"
  rm -f "$manifest"
}

run_cert_manager_gateway_api_enable_check() {
  # shellcheck disable=SC1091
  source "$ROOT_DIR/scripts/aks-deploy.sh"
  capture_helm_invocation

  AKS_CERT_MANAGER_IDENTITY_CLIENT_ID="00000000-0000-0000-0000-000000000099"

  if ! ensure_cert_manager >"$TMP_DIR/cert-manager.out" 2>&1; then
    cat "$TMP_DIR/cert-manager.out" >&2 || true
    fail "ensure_cert_manager should succeed while enabling Gateway API support"
  fi

  assert_contains 'config.enableGatewayAPI=true' "$TMP_DIR/helm-args.txt"
  assert_contains 'webhook.validatingWebhookConfiguration.namespaceSelector={"matchExpressions":[{"key":"cert-manager.io/disable-validation","operator":"NotIn","values":["true"]},{"key":"control-plane","operator":"NotIn","values":["true"]},{"key":"kubernetes.azure.com/managedby","operator":"NotIn","values":["aks"]}]}' "$TMP_DIR/helm-args.txt"
}

run_gateway_ready_missing_gateway_check() {
  # shellcheck disable=SC1091
  source "$ROOT_DIR/scripts/kube-deploy-common.sh"

  WAIT_FOR_GATEWAY_READY_MAX_POLLS=2
  : >"$TMP_DIR/gateway-missing.calls"
  KUBE_CLI="fake_kubectl"
  sleep() { :; }
  fake_kubectl() {
    printf '%s\n' "$*" >>"$TMP_DIR/gateway-missing.calls"
    echo 'Error from server (NotFound): gateways.gateway.networking.k8s.io "sre-simulator" not found' >&2
    return 1
  }

  if wait_for_gateway_ready "sre-simulator" "sre-simulator" >"$TMP_DIR/gateway-missing.out" 2>"$TMP_DIR/gateway-missing.err"; then
    fail "wait_for_gateway_ready should fail fast when the Gateway cannot be fetched"
  fi

  assert_call_count_at_most 2 "$TMP_DIR/gateway-missing.calls"
  assert_contains "Gateway 'sre-simulator' in namespace 'sre-simulator' could not be fetched" "$TMP_DIR/gateway-missing.err"
  assert_contains 'not found' "$TMP_DIR/gateway-missing.err"
}

run_gateway_ready_stale_status_check() {
  # shellcheck disable=SC1091
  source "$ROOT_DIR/scripts/kube-deploy-common.sh"

  WAIT_FOR_GATEWAY_READY_MAX_POLLS=2
  KUBE_CLI="fake_kubectl"
  sleep() { :; }
  fake_kubectl() {
    case "$*" in
      *".metadata.generation"*)
        printf '3'
        ;;
      *".status.conditions"*)
        printf '%s\n' 'Accepted=True:2' 'Programmed=True:2'
        ;;
      *".status.listeners"*)
        printf '%s\n' \
          'http|Accepted=True:2,Programmed=True:2,ResolvedRefs=True:2,' \
          'https|Accepted=True:2,Programmed=True:2,ResolvedRefs=True:2,'
        ;;
      *"-o yaml"*)
        printf '%s\n' 'status:' '  conditions: []'
        ;;
      *)
        fail "unexpected fake_kubectl invocation for stale status check: $*"
        ;;
    esac
  }

  if wait_for_gateway_ready "sre-simulator" "sre-simulator" >"$TMP_DIR/gateway-stale.out" 2>"$TMP_DIR/gateway-stale.err"; then
    fail "wait_for_gateway_ready should reject stale Gateway status"
  fi

  assert_contains "status is stale" "$TMP_DIR/gateway-stale.err"
  assert_contains "observedGeneration" "$TMP_DIR/gateway-stale.err"
}

run_gateway_ready_listener_conditions_check() {
  # shellcheck disable=SC1091
  source "$ROOT_DIR/scripts/kube-deploy-common.sh"

  WAIT_FOR_GATEWAY_READY_MAX_POLLS=2
  KUBE_CLI="fake_kubectl"
  sleep() { :; }
  fake_kubectl() {
    case "$*" in
      *".metadata.generation"*)
        printf '3'
        ;;
      *".status.conditions"*)
        printf '%s\n' 'Accepted=True:3' 'Programmed=True:3'
        ;;
      *".status.listeners"*)
        printf '%s\n' \
          'http|Accepted=True:3,Programmed=True:3,ResolvedRefs=True:3,' \
          'https|Accepted=True:3,Programmed=True:3,ResolvedRefs=False:3,'
        ;;
      *"-o yaml"*)
        printf '%s\n' 'status:' '  listeners: []'
        ;;
      *)
        fail "unexpected fake_kubectl invocation for listener readiness check: $*"
        ;;
    esac
  }

  if wait_for_gateway_ready "sre-simulator" "sre-simulator" >"$TMP_DIR/gateway-listener.out" 2>"$TMP_DIR/gateway-listener.err"; then
    fail "wait_for_gateway_ready should reject Gateways with unresolved listener refs"
  fi

  assert_contains "listener 'https'" "$TMP_DIR/gateway-listener.err"
  assert_contains "ResolvedRefs=True" "$TMP_DIR/gateway-listener.err"
}

run_gateway_stack_cleanup_check() {
  local clusterissuer_path envoyproxy_path gatewayclass_path

  # shellcheck disable=SC1091
  source "$ROOT_DIR/scripts/aks-deploy.sh"

  clusterissuer_path="$TMP_DIR/test-clusterissuer.yaml"
  envoyproxy_path="$TMP_DIR/test-envoyproxy.yaml"
  gatewayclass_path="$TMP_DIR/test-gatewayclass.yaml"
  KUBE_CLI="fake_kubectl"
  fake_kubectl() {
    case "$*" in
      *"get clusterissuer/letsencrypt-azuredns-staging"*)
        return 1
        ;;
      *"get clusterissuer/letsencrypt-azuredns-prod"*)
        return 1
        ;;
      *"apply -f ${gatewayclass_path}"*)
        return 0
        ;;
      *"apply -f ${clusterissuer_path}"*)
        return 0
        ;;
      *"apply -f ${envoyproxy_path}"*)
        echo "envoyproxy apply failed" >&2
        return 1
        ;;
      *)
        fail "unexpected fake_kubectl invocation for gateway stack cleanup check: $*"
        ;;
    esac
  }
  resolve_aks_public_endpoint() {
    AKS_FRONTEND_PUBLIC_IP_NAME="example-frontend-pip"
    AKS_FRONTEND_PUBLIC_IP="203.0.113.10"
  }
  resolve_aks_gateway_identity_client_id() {
    AKS_CERT_MANAGER_IDENTITY_CLIENT_ID="00000000-0000-0000-0000-000000000099"
  }
  ensure_envoy_gateway() { :; }
  ensure_cert_manager() { :; }
  write_aks_gatewayclass_manifest() {
    printf '%s\n' 'apiVersion: gateway.networking.k8s.io/v1' >"$gatewayclass_path"
    printf '%s\n' "$gatewayclass_path"
  }
  write_aks_clusterissuer_manifest() {
    printf '%s\n' 'apiVersion: cert-manager.io/v1' >"$clusterissuer_path"
    printf '%s\n' "$clusterissuer_path"
  }
  write_aks_envoyproxy_manifest() {
    printf '%s\n' 'apiVersion: gateway.envoyproxy.io/v1alpha1' >"$envoyproxy_path"
    printf '%s\n' "$envoyproxy_path"
  }

  if ensure_aks_gateway_stack "sre-simulator" >"$TMP_DIR/gateway-stack.out" 2>"$TMP_DIR/gateway-stack.err"; then
    fail "ensure_aks_gateway_stack should fail when EnvoyProxy apply fails"
  fi

  [ ! -e "$gatewayclass_path" ] || fail "ensure_aks_gateway_stack should remove the GatewayClass temp file on failure"
  [ ! -e "$clusterissuer_path" ] || fail "ensure_aks_gateway_stack should remove the ClusterIssuer temp file on failure"
  [ ! -e "$envoyproxy_path" ] || fail "ensure_aks_gateway_stack should remove the EnvoyProxy temp file on failure"
}

run_gateway_stack_existing_issuers_without_email_check() {
  local envoyproxy_path gatewayclass_path log_file

  # shellcheck disable=SC1091
  source "$ROOT_DIR/scripts/aks-deploy.sh"

  envoyproxy_path="$TMP_DIR/existing-issuers-envoyproxy.yaml"
  gatewayclass_path="$TMP_DIR/existing-issuers-gatewayclass.yaml"
  log_file="$TMP_DIR/existing-issuers-kubectl.log"
  : >"$log_file"

  KUBE_CLI="fake_kubectl"
  fake_kubectl() {
    printf '%s\n' "$*" >>"$log_file"
    case "$*" in
      "get clusterissuer/letsencrypt-azuredns-staging")
        return 0
        ;;
      "get clusterissuer/letsencrypt-azuredns-prod")
        return 0
        ;;
      "apply -f ${gatewayclass_path}")
        return 0
        ;;
      "apply -f ${envoyproxy_path}")
        return 0
        ;;
      *)
        fail "unexpected fake_kubectl invocation for existing issuer check: $*"
        ;;
    esac
  }
  resolve_aks_public_endpoint() {
    AKS_FRONTEND_PUBLIC_IP_NAME="example-frontend-pip"
    AKS_FRONTEND_PUBLIC_IP="203.0.113.10"
  }
  resolve_aks_gateway_identity_client_id() {
    AKS_CERT_MANAGER_IDENTITY_CLIENT_ID="00000000-0000-0000-0000-000000000099"
  }
  ensure_envoy_gateway() { :; }
  ensure_cert_manager() { :; }
  write_aks_gatewayclass_manifest() {
    printf '%s\n' 'apiVersion: gateway.networking.k8s.io/v1' >"$gatewayclass_path"
    printf '%s\n' "$gatewayclass_path"
  }
  write_aks_clusterissuer_manifest() {
    fail "ensure_aks_gateway_stack should reuse existing ClusterIssuers when no ACME email override is provided"
  }
  write_aks_envoyproxy_manifest() {
    printf '%s\n' 'apiVersion: gateway.envoyproxy.io/v1alpha1' >"$envoyproxy_path"
    printf '%s\n' "$envoyproxy_path"
  }

  unset AKS_CERT_MANAGER_ACME_EMAIL || true

  if ! ensure_aks_gateway_stack "sre-simulator" >"$TMP_DIR/existing-issuers.out" 2>"$TMP_DIR/existing-issuers.err"; then
    cat "$TMP_DIR/existing-issuers.err" >&2 || true
    fail "ensure_aks_gateway_stack should reuse existing ClusterIssuers when no ACME email override is set"
  fi

  assert_contains 'get clusterissuer/letsencrypt-azuredns-staging' "$log_file"
  assert_contains 'get clusterissuer/letsencrypt-azuredns-prod' "$log_file"
  [ ! -e "$gatewayclass_path" ] || fail "ensure_aks_gateway_stack should remove the GatewayClass temp file after a successful existing-issuer check"
  [ ! -e "$envoyproxy_path" ] || fail "ensure_aks_gateway_stack should remove the EnvoyProxy temp file after a successful existing-issuer check"
}

run_tempfile_collision_check() {
  local collision_dir values_file

  # shellcheck disable=SC1091
  source "$ROOT_DIR/scripts/aks-deploy.sh"

  collision_dir="$TMP_DIR/mktemp-collision"
  mkdir -p "$collision_dir"
  touch "$collision_dir/sre-aks-exposure-XXXXXX.yaml"

  TMPDIR="$collision_dir"
  DEPLOY_HOST="aks.example.test"
  DEPLOY_SCHEME="http"
  AKS_RG="example-aks-rg"
  AKS_FRONTEND_PUBLIC_IP="203.0.113.10"
  AKS_FRONTEND_PUBLIC_IP_NAME="example-frontend-pip"

  if ! values_file="$(write_aks_exposure_values 2>"$TMP_DIR/mktemp-collision.txt")"; then
    cat "$TMP_DIR/mktemp-collision.txt" >&2 || true
    fail "write_aks_exposure_values should use a unique temp file template"
  fi

  if [[ "$values_file" == "$collision_dir/sre-aks-exposure-XXXXXX.yaml" ]]; then
    fail "write_aks_exposure_values should not reuse the literal XXXXXX template path"
  fi

  [[ -f "$values_file" ]] || fail "expected write_aks_exposure_values to create a temp values file"
  rm -f "$values_file"
}

run_wait_for_rollout_gateway_tls_check() {
  # shellcheck disable=SC1091
  source "$ROOT_DIR/scripts/kube-deploy-common.sh"

  KUBE_CLI="fake_kubectl"
  E2E_RELEASE="sre-simulator"
  CLUSTER_FLAVOR="aks"
  AKS_EXPOSURE_MODE="gateway"
  AKS_GATEWAY_TLS_SECRET_NAME="sre-simulator-gateway-tls"
  : >"$TMP_DIR/wait-for-rollout.calls"

  fake_kubectl() {
    printf '%s\n' "$*" >>"$TMP_DIR/wait-for-rollout.calls"
  }
  wait_for_gateway_ready() {
    printf 'gateway %s %s\n' "$1" "$2" >>"$TMP_DIR/wait-for-rollout.calls"
  }
  wait_for_certificate_ready() {
    printf 'certificate %s %s\n' "$1" "$2" >>"$TMP_DIR/wait-for-rollout.calls"
  }

  wait_for_rollout "sre-simulator"

  assert_contains "gateway sre-simulator sre-simulator" "$TMP_DIR/wait-for-rollout.calls"
  assert_contains "certificate sre-simulator sre-simulator-gateway-tls" "$TMP_DIR/wait-for-rollout.calls"
}

run_prod_status_metadata_publicservice_check() {
  local metadata_file output_file log_file

  write_fake_kubectl
  metadata_file="$TMP_DIR/prod-status.env"
  output_file="$TMP_DIR/prod-status.out"
  log_file="$TMP_DIR/prod-status.kubectl.log"
  cat >"$metadata_file" <<'EOF'
NS=sre-simulator
RELEASE=sre-simulator
URL=http://public.example.com
TAG=latest
CLUSTER_FLAVOR=aks
DEPLOYED_AKS_EXPOSURE_MODE=publicService
EOF
  : >"$log_file"

  if ! env \
    -u AKS_EXPOSURE_MODE \
    PATH="$TMP_DIR/bin:$PATH" \
    FAKE_KUBECTL_LOG="$log_file" \
    make -s prod-status \
      CLUSTER_FLAVOR=aks \
      PROD_METADATA_FILE="$metadata_file" >"$output_file" 2>&1; then
    cat "$output_file" >&2 || true
    fail "prod-status should honor the deployed AKS exposure mode from production metadata"
  fi

  assert_contains 'Frontend service:' "$output_file"
  assert_contains 'get svc/sre-simulator-frontend' "$log_file"
  assert_not_contains 'get gateway,httproute,certificate' "$log_file"
}

run_public_exposure_audit_metadata_publicservice_check() {
  local metadata_file output_file log_file

  write_fake_kubectl
  metadata_file="$TMP_DIR/public-audit-metadata.env"
  output_file="$TMP_DIR/public-audit-metadata.out"
  log_file="$TMP_DIR/public-audit-metadata.kubectl.log"
  cat >"$metadata_file" <<'EOF'
NS=sre-simulator
RELEASE=sre-simulator
URL=http://public.example.com
TAG=latest
CLUSTER_FLAVOR=aks
DEPLOYED_AKS_EXPOSURE_MODE=publicService
EOF
  : >"$log_file"

  if ! env \
    -u AKS_EXPOSURE_MODE \
    PATH="$TMP_DIR/bin:$PATH" \
    FAKE_KUBECTL_LOG="$log_file" \
    FAKE_FRONTEND_SERVICE_TYPE="LoadBalancer" \
    FAKE_FRONTEND_SERVICE_PORT="80" \
    FAKE_BACKEND_SERVICE_TYPE="ClusterIP" \
    make -s public-exposure-audit \
      CLUSTER_FLAVOR=aks \
      PROD_METADATA_FILE="$metadata_file" >"$output_file" 2>&1; then
    cat "$output_file" >&2 || true
    fail "public-exposure-audit should use deployed publicService mode from production metadata when not explicitly overridden"
  fi

  assert_contains 'get svc/sre-simulator-frontend -o jsonpath={.spec.type}' "$log_file"
  assert_contains 'get svc/sre-simulator-frontend -o jsonpath={.spec.ports[0].port}' "$log_file"
  assert_not_contains 'get gateway/sre-simulator' "$log_file"
}

run_public_exposure_audit_operator_override_check() {
  local metadata_file output_file log_file

  write_fake_kubectl
  metadata_file="$TMP_DIR/public-audit-override.env"
  output_file="$TMP_DIR/public-audit-override.out"
  log_file="$TMP_DIR/public-audit-override.kubectl.log"
  cat >"$metadata_file" <<'EOF'
NS=sre-simulator
RELEASE=sre-simulator
URL=http://public.example.com
TAG=latest
CLUSTER_FLAVOR=aks
DEPLOYED_AKS_EXPOSURE_MODE=publicService
EOF
  : >"$log_file"

  if ! env \
    PATH="$TMP_DIR/bin:$PATH" \
    FAKE_KUBECTL_LOG="$log_file" \
    FAKE_GATEWAY_EXISTS="1" \
    FAKE_HTTPROUTE_MAIN_EXISTS="1" \
    FAKE_HTTPROUTE_REDIRECT_EXISTS="1" \
    FAKE_CERTIFICATE_LIST=$'sre-simulator-gateway|sre-simulator-gateway-tls\n' \
    FAKE_FRONTEND_SERVICE_TYPE="ClusterIP" \
    FAKE_BACKEND_SERVICE_TYPE="ClusterIP" \
    make -s public-exposure-audit \
      CLUSTER_FLAVOR=aks \
      PROD_METADATA_FILE="$metadata_file" \
      AKS_EXPOSURE_MODE=gateway \
      AKS_GATEWAY_TLS_SECRET_NAME=sre-simulator-gateway-tls >"$output_file" 2>&1; then
    cat "$output_file" >&2 || true
    fail "public-exposure-audit should respect an explicit AKS_EXPOSURE_MODE operator override"
  fi

  assert_contains 'get gateway/sre-simulator' "$log_file"
  assert_not_contains 'get svc/sre-simulator-frontend -o jsonpath={.spec.ports[0].port}' "$log_file"
}

run_public_exposure_audit_gateway_frontend_ingress_rejection_check() {
  local metadata_file output_file log_file

  write_fake_kubectl
  metadata_file="$TMP_DIR/public-audit-gateway-frontend-ingress.env"
  output_file="$TMP_DIR/public-audit-gateway-frontend-ingress.out"
  log_file="$TMP_DIR/public-audit-gateway-frontend-ingress.kubectl.log"
  cat >"$metadata_file" <<'EOF'
NS=sre-simulator
RELEASE=sre-simulator
URL=https://play.sresimulator.osadev.cloud
TAG=latest
CLUSTER_FLAVOR=aks
DEPLOYED_AKS_EXPOSURE_MODE=gateway
EOF
  : >"$log_file"

  if env \
    PATH="$TMP_DIR/bin:$PATH" \
    FAKE_KUBECTL_LOG="$log_file" \
    FAKE_FRONTEND_INGRESS_EXISTS="1" \
    FAKE_GATEWAY_EXISTS="1" \
    FAKE_HTTPROUTE_MAIN_EXISTS="1" \
    FAKE_HTTPROUTE_REDIRECT_EXISTS="1" \
    FAKE_CERTIFICATE_LIST=$'sre-simulator-gateway|sre-simulator-gateway-tls\n' \
    FAKE_FRONTEND_SERVICE_TYPE="ClusterIP" \
    FAKE_BACKEND_SERVICE_TYPE="ClusterIP" \
    make -s public-exposure-audit \
      CLUSTER_FLAVOR=aks \
      PROD_METADATA_FILE="$metadata_file" \
      AKS_GATEWAY_TLS_SECRET_NAME=sre-simulator-gateway-tls >"$output_file" 2>&1; then
    fail "gateway-mode public-exposure-audit should fail when a stale frontend Ingress exists"
  fi

  assert_contains 'Unexpected frontend ingress found: sre-simulator' "$output_file"
}

run_public_exposure_audit_gateway_backend_ingress_rejection_check() {
  local metadata_file output_file log_file

  write_fake_kubectl
  metadata_file="$TMP_DIR/public-audit-gateway-backend-ingress.env"
  output_file="$TMP_DIR/public-audit-gateway-backend-ingress.out"
  log_file="$TMP_DIR/public-audit-gateway-backend-ingress.kubectl.log"
  cat >"$metadata_file" <<'EOF'
NS=sre-simulator
RELEASE=sre-simulator
URL=https://play.sresimulator.osadev.cloud
TAG=latest
CLUSTER_FLAVOR=aks
DEPLOYED_AKS_EXPOSURE_MODE=gateway
EOF
  : >"$log_file"

  if env \
    PATH="$TMP_DIR/bin:$PATH" \
    FAKE_KUBECTL_LOG="$log_file" \
    FAKE_BACKEND_INGRESS_EXISTS="1" \
    FAKE_GATEWAY_EXISTS="1" \
    FAKE_HTTPROUTE_MAIN_EXISTS="1" \
    FAKE_HTTPROUTE_REDIRECT_EXISTS="1" \
    FAKE_CERTIFICATE_LIST=$'sre-simulator-gateway|sre-simulator-gateway-tls\n' \
    FAKE_FRONTEND_SERVICE_TYPE="ClusterIP" \
    FAKE_BACKEND_SERVICE_TYPE="ClusterIP" \
    make -s public-exposure-audit \
      CLUSTER_FLAVOR=aks \
      PROD_METADATA_FILE="$metadata_file" \
      AKS_GATEWAY_TLS_SECRET_NAME=sre-simulator-gateway-tls >"$output_file" 2>&1; then
    fail "gateway-mode public-exposure-audit should fail when a stale backend Ingress exists"
  fi

  assert_contains 'Unexpected backend ingress found: sre-simulator-backend' "$output_file"
}

run_e2e_route_up_default_none_mode_check() {
  local metadata_file output_file az_log kubectl_log helm_log helm_values curl_log nohup_log state_dir

  write_fake_e2e_clis
  metadata_file="$TMP_DIR/e2e-up-default.env"
  output_file="$TMP_DIR/e2e-up-default.out"
  az_log="$TMP_DIR/e2e-up-default.az.log"
  kubectl_log="$TMP_DIR/e2e-up-default.kubectl.log"
  helm_log="$TMP_DIR/e2e-up-default.helm.log"
  helm_values="$TMP_DIR/e2e-up-default.values.yaml"
  curl_log="$TMP_DIR/e2e-up-default.curl.log"
  nohup_log="$TMP_DIR/e2e-up-default.nohup.log"
  state_dir="$TMP_DIR/e2e-up-default.state"
  mkdir -p "$state_dir"
  : >"$az_log"
  : >"$kubectl_log"
  : >"$helm_log"
  : >"$curl_log"
  : >"$nohup_log"

  if ! env \
    -u AKS_EXPOSURE_MODE \
    PATH="$TMP_DIR/e2e-bin:$PATH" \
    FAKE_AZ_LOG="$az_log" \
    FAKE_KUBECTL_LOG="$kubectl_log" \
    FAKE_KUBECTL_STATE_DIR="$state_dir" \
    FAKE_HELM_LOG="$helm_log" \
    FAKE_HELM_VALUES_CAPTURE="$helm_values" \
    FAKE_CURL_LOG="$curl_log" \
    FAKE_NOHUP_LOG="$nohup_log" \
    FAKE_PORT_FORWARD_SLEEP=30 \
    make -s -C "$ROOT_DIR" e2e-azure-route-up \
      E2E_ENV_FILE="$TMP_DIR/missing.env" \
      E2E_METADATA_FILE="$metadata_file" \
      E2E_NAMESPACE_PREFIX="test-e2e" \
      CLUSTER_FLAVOR=aks \
      AZURE_SUBSCRIPTION_ID=00000000-0000-0000-0000-000000000001 \
      AKS_RG=test-aks-rg \
      AKS_CLUSTER=test-aks \
      AOAI_RG=test-aoai-rg \
      AOAI_ACCOUNT=test-aoai \
      AOAI_DEPLOYMENT=gpt-4o-mini \
      AKS_E2E_EXPOSURE_MODE=none \
      AKS_LOCAL_PORT_FORWARD_PORT=38080 \
      FRONTEND_PORT=3000 >"$output_file" 2>&1; then
    cat "$output_file" >&2 || true
    fail "e2e-azure-route-up should default AKS e2e traffic to AKS_E2E_EXPOSURE_MODE when AKS_EXPOSURE_MODE is not explicitly overridden"
  fi

  cleanup_port_forward_from_metadata "$metadata_file"
  assert_contains 'DEPLOYED_AKS_EXPOSURE_MODE=none' "$metadata_file"
  assert_contains 'URL=http://127.0.0.1:38080' "$metadata_file"
  assert_matches '^PORT_FORWARD_LOG=/tmp/sre-e2e-.*-frontend-port-forward\.log$' "$metadata_file"
  assert_contains 'mode: "none"' "$helm_values"
  assert_contains 'host: "127.0.0.1:38080"' "$helm_values"
  assert_contains 'scheme: "http"' "$helm_values"
  assert_not_contains 'loadBalancerIP:' "$helm_values"
  assert_contains 'port-forward svc/sre-simulator-frontend 38080:3000' "$kubectl_log"
  assert_not_contains 'network public-ip show' "$az_log"
  assert_contains 'http://127.0.0.1:38080/api/ai/probe?live=true' "$curl_log"
}

run_e2e_route_up_explicit_override_check() {
  local metadata_file output_file az_log kubectl_log helm_log helm_values curl_log nohup_log state_dir

  write_fake_e2e_clis
  metadata_file="$TMP_DIR/e2e-up-override.env"
  output_file="$TMP_DIR/e2e-up-override.out"
  az_log="$TMP_DIR/e2e-up-override.az.log"
  kubectl_log="$TMP_DIR/e2e-up-override.kubectl.log"
  helm_log="$TMP_DIR/e2e-up-override.helm.log"
  helm_values="$TMP_DIR/e2e-up-override.values.yaml"
  curl_log="$TMP_DIR/e2e-up-override.curl.log"
  nohup_log="$TMP_DIR/e2e-up-override.nohup.log"
  state_dir="$TMP_DIR/e2e-up-override.state"
  mkdir -p "$state_dir"
  : >"$az_log"
  : >"$kubectl_log"
  : >"$helm_log"
  : >"$curl_log"
  : >"$nohup_log"

  if ! env \
    PATH="$TMP_DIR/e2e-bin:$PATH" \
    FAKE_AZ_LOG="$az_log" \
    FAKE_KUBECTL_LOG="$kubectl_log" \
    FAKE_KUBECTL_STATE_DIR="$state_dir" \
    FAKE_HELM_LOG="$helm_log" \
    FAKE_HELM_VALUES_CAPTURE="$helm_values" \
    FAKE_CURL_LOG="$curl_log" \
    FAKE_NOHUP_LOG="$nohup_log" \
    make -s -C "$ROOT_DIR" e2e-azure-route-up \
      E2E_ENV_FILE="$TMP_DIR/missing.env" \
      E2E_METADATA_FILE="$metadata_file" \
      E2E_NAMESPACE_PREFIX="test-e2e" \
      CLUSTER_FLAVOR=aks \
      AZURE_SUBSCRIPTION_ID=00000000-0000-0000-0000-000000000001 \
      AKS_RG=test-aks-rg \
      AKS_CLUSTER=test-aks \
      AOAI_RG=test-aoai-rg \
      AOAI_ACCOUNT=test-aoai \
      AOAI_DEPLOYMENT=gpt-4o-mini \
      AKS_E2E_EXPOSURE_MODE=none \
      AKS_EXPOSURE_MODE=publicService >"$output_file" 2>&1; then
    cat "$output_file" >&2 || true
    fail "e2e-azure-route-up should keep honoring an explicit AKS_EXPOSURE_MODE override"
  fi

  assert_contains 'DEPLOYED_AKS_EXPOSURE_MODE=publicService' "$metadata_file"
  assert_contains 'URL=http://aks.example.test' "$metadata_file"
  assert_not_matches '^PORT_FORWARD_PID=[0-9]+$' "$metadata_file"
  assert_contains 'mode: "publicService"' "$helm_values"
  assert_contains 'host: "aks.example.test"' "$helm_values"
  assert_contains 'scheme: "http"' "$helm_values"
  assert_contains 'loadBalancerIP: "203.0.113.10"' "$helm_values"
  assert_matches '^network public-ip show -g test-aks-rg -n .+ --query ipAddress -o tsv$' "$az_log"
  assert_matches '^network public-ip show -g test-aks-rg -n .+ --query dnsSettings.fqdn -o tsv$' "$az_log"
  assert_not_contains 'port-forward svc/sre-simulator-frontend' "$kubectl_log"
  assert_contains 'http://aks.example.test/api/ai/probe?live=true' "$curl_log"
}

run_e2e_route_refresh_metadata_mode_check() {
  local metadata_file output_file az_log kubectl_log helm_log helm_values curl_log nohup_log state_dir

  write_fake_e2e_clis
  metadata_file="$TMP_DIR/e2e-refresh.env"
  output_file="$TMP_DIR/e2e-refresh.out"
  az_log="$TMP_DIR/e2e-refresh.az.log"
  kubectl_log="$TMP_DIR/e2e-refresh.kubectl.log"
  helm_log="$TMP_DIR/e2e-refresh.helm.log"
  helm_values="$TMP_DIR/e2e-refresh.values.yaml"
  curl_log="$TMP_DIR/e2e-refresh.curl.log"
  nohup_log="$TMP_DIR/e2e-refresh.nohup.log"
  state_dir="$TMP_DIR/e2e-refresh.state"
  mkdir -p "$state_dir/namespaces"
  : >"$state_dir/namespaces/test-refresh"
  : >"$az_log"
  : >"$kubectl_log"
  : >"$helm_log"
  : >"$curl_log"
  : >"$nohup_log"
  cat >"$metadata_file" <<'EOF'
NS=test-refresh
RELEASE=sre-simulator
URL=http://old.example.test
TAG=latest
CLUSTER_FLAVOR=aks
DEPLOYED_AKS_EXPOSURE_MODE=publicService
PORT_FORWARD_PID=
PORT_FORWARD_LOG=
EOF

  if ! env \
    -u AKS_EXPOSURE_MODE \
    PATH="$TMP_DIR/e2e-bin:$PATH" \
    FAKE_AZ_LOG="$az_log" \
    FAKE_KUBECTL_LOG="$kubectl_log" \
    FAKE_KUBECTL_STATE_DIR="$state_dir" \
    FAKE_HELM_LOG="$helm_log" \
    FAKE_HELM_VALUES_CAPTURE="$helm_values" \
    FAKE_CURL_LOG="$curl_log" \
    FAKE_NOHUP_LOG="$nohup_log" \
    make -s -C "$ROOT_DIR" e2e-azure-route-refresh \
      E2E_ENV_FILE="$TMP_DIR/missing.env" \
      E2E_METADATA_FILE="$metadata_file" \
      CLUSTER_FLAVOR=aks \
      AZURE_SUBSCRIPTION_ID=00000000-0000-0000-0000-000000000001 \
      AKS_RG=test-aks-rg \
      AKS_CLUSTER=test-aks \
      AOAI_RG=test-aoai-rg \
      AOAI_ACCOUNT=test-aoai \
      AOAI_DEPLOYMENT=gpt-4o-mini \
      AKS_E2E_EXPOSURE_MODE=none >"$output_file" 2>&1; then
    cat "$output_file" >&2 || true
    fail "e2e-azure-route-refresh should honor DEPLOYED_AKS_EXPOSURE_MODE from metadata when no explicit override is present"
  fi

  assert_contains 'NS=test-refresh' "$metadata_file"
  assert_contains 'DEPLOYED_AKS_EXPOSURE_MODE=publicService' "$metadata_file"
  assert_contains 'URL=http://aks.example.test' "$metadata_file"
  assert_not_matches '^PORT_FORWARD_PID=[0-9]+$' "$metadata_file"
  assert_contains 'mode: "publicService"' "$helm_values"
  assert_contains 'loadBalancerIP: "203.0.113.10"' "$helm_values"
  assert_contains 'get namespace/test-refresh' "$kubectl_log"
  assert_not_contains 'port-forward svc/sre-simulator-frontend' "$kubectl_log"
  assert_contains 'http://aks.example.test/api/ai/probe?live=true' "$curl_log"
}

run_makefile_gateway_defaults_check() {
  local makefile="$ROOT_DIR/Makefile"

  assert_contains 'AKS_EXPOSURE_MODE ?= gateway' "$makefile"
  assert_contains 'AKS_E2E_EXPOSURE_MODE ?= none' "$makefile"
  assert_contains 'AKS_GATEWAY_HOST ?= play.sresimulator.osadev.cloud' "$makefile"
  assert_contains 'AKS_GATEWAY_CLASS_NAME ?= eg' "$makefile"
  assert_contains 'AKS_GATEWAY_TLS_SECRET_NAME ?= sre-simulator-gateway-tls' "$makefile"
  assert_contains 'AKS_CLUSTER_ISSUER_NAME ?= letsencrypt-azuredns-prod' "$makefile"
  assert_contains 'AKS_DNS_ZONE_NAME ?= osadev.cloud' "$makefile"
  assert_contains 'AKS_DNS_ZONE_RESOURCE_GROUP ?= dns' "$makefile"
  assert_contains 'AKS_CERT_MANAGER_IDENTITY_NAME ?= $(if $(strip $(AKS_CLUSTER)),$(AKS_CLUSTER)-cert-manager-dns,)' "$makefile"
  assert_contains 'AKS_CERT_MANAGER_ACME_EMAIL ?=' "$makefile"
  assert_not_contains 'AKS_CERT_MANAGER_ACME_EMAIL ?= aaffinit@redhat.com' "$makefile"
  assert_contains 'AKS_SKIP_GATEWAY_BOOTSTRAP ?= false' "$makefile"
  assert_contains 'export AKS_EXPOSURE_MODE AKS_E2E_EXPOSURE_MODE AKS_GATEWAY_HOST AKS_GATEWAY_CLASS_NAME' "$makefile"
  assert_contains 'export AKS_GATEWAY_TLS_SECRET_NAME AKS_CLUSTER_ISSUER_NAME' "$makefile"
  assert_contains 'export AKS_DNS_ZONE_NAME AKS_DNS_ZONE_RESOURCE_GROUP' "$makefile"
  assert_contains 'export AKS_CERT_MANAGER_IDENTITY_NAME AKS_CERT_MANAGER_ACME_EMAIL' "$makefile"
  assert_contains 'export AKS_SKIP_GATEWAY_BOOTSTRAP' "$makefile"
}

run_makefile_gateway_audit_targets_check() {
  local makefile="$ROOT_DIR/Makefile"

  assert_contains 'get gateway,httproute,certificate' "$makefile"
  assert_contains 'DEPLOYED_AKS_EXPOSURE_MODE' "$makefile"
  assert_contains 'if [ "$(CLUSTER_FLAVOR)" = "aks" ] && [ -z "$(AKS_EXPOSURE_MODE_EXPLICIT)" ] && [ -f "$(PROD_METADATA_FILE)" ]; then' "$makefile"
  assert_contains 'get "gateway/$$RELEASE" >/dev/null' "$makefile"
  assert_contains 'get "httproute/$$RELEASE" >/dev/null' "$makefile"
  assert_contains 'Unexpected frontend ingress found: $$RELEASE' "$makefile"
  assert_contains 'Unexpected backend ingress found: $$RELEASE-backend' "$makefile"
  assert_contains 'Frontend service type must be ClusterIP in AKS gateway mode' "$makefile"
  assert_contains 'Frontend service type must be LoadBalancer on AKS publicService mode' "$makefile"
}

run_makefile_port_forward_e2e_targets_check() {
  local makefile="$ROOT_DIR/Makefile"

  assert_contains 'AKS_LOCAL_PORT_FORWARD_PORT ?= 38080' "$makefile"
  assert_contains 'AKS_E2E_EXPOSURE_MODE ?= none' "$makefile"
  assert_contains 'export AKS_SKIP_GATEWAY_BOOTSTRAP AKS_LOCAL_PORT_FORWARD_PORT' "$makefile"
  assert_contains 'echo "  AKS_EXPOSURE_MODE: $(call e2e_var_source,AKS_EXPOSURE_MODE)"' "$makefile"
  assert_contains 'echo "  AKS_E2E_EXPOSURE_MODE: $(call e2e_var_source,AKS_E2E_EXPOSURE_MODE)"' "$makefile"
  assert_contains 'if [ "$(CLUSTER_FLAVOR)" = "aks" ] && [ -z "$(AKS_EXPOSURE_MODE_EXPLICIT)" ]; then \' "$makefile"
  assert_contains 'export AKS_EXPOSURE_MODE="$(AKS_E2E_EXPOSURE_MODE)"; \' "$makefile"
  assert_contains 'elif [ "$(CLUSTER_FLAVOR)" = "aks" ] && [ -z "$(AKS_EXPOSURE_MODE_EXPLICIT)" ]; then \' "$makefile"
  assert_contains 'DEPLOYED_AKS_EXPOSURE_MODE=%s\n' "$makefile"
  assert_contains 'PORT_FORWARD_PID=%s\nPORT_FORWARD_LOG=%s\n' "$makefile"
  assert_contains 'cleanup_port_forward() {' "$makefile"
  assert_contains 'stop_port_forward() {' "$makefile"
  assert_contains "trap 'cleanup_port_forward' EXIT INT TERM" "$makefile"
  assert_contains 'KEEP_PORT_FORWARD=true' "$makefile"
  assert_contains 'ps -p "$$PORT_FORWARD_PID" -o args=' "$makefile"
  assert_contains 'Skipping stale or unexpected port-forward PID $$PORT_FORWARD_PID' "$makefile"
  assert_contains 'port-forward "svc/$(E2E_RELEASE)-frontend" "$(AKS_LOCAL_PORT_FORWARD_PORT):$(FRONTEND_PORT)"' "$makefile"
  assert_contains 'Local frontend port-forward failed to start.' "$makefile"
}

run_geneva_suppression_gate_scope_check() {
  local aks_output aro_output aro_enabled_output

  aks_output="$TMP_DIR/geneva-aks.out"
  aro_output="$TMP_DIR/geneva-aro.out"
  aro_enabled_output="$TMP_DIR/geneva-aro-enabled.out"

  if ! env -u GENEVA_SUPPRESSION_RULE_ACTIVE \
    make -s -C "$ROOT_DIR" geneva-suppression-check \
      CLUSTER_FLAVOR=aks >"$aks_output" 2>&1; then
    cat "$aks_output" >&2 || true
    fail "geneva-suppression-check should be skipped for AKS deployments"
  fi

  if env -u GENEVA_SUPPRESSION_RULE_ACTIVE \
    make -s -C "$ROOT_DIR" geneva-suppression-check \
      CLUSTER_FLAVOR=aro >"$aro_output" 2>&1; then
    fail "geneva-suppression-check should still require explicit confirmation for ARO deployments"
  fi

  assert_contains 'Set GENEVA_SUPPRESSION_RULE_ACTIVE=true after verifying Geneva suppression is active for the target ARO cluster/resource group' "$aro_output"

  if ! env GENEVA_SUPPRESSION_RULE_ACTIVE=true \
    make -s -C "$ROOT_DIR" geneva-suppression-check \
      CLUSTER_FLAVOR=aro >"$aro_enabled_output" 2>&1; then
    cat "$aro_enabled_output" >&2 || true
    fail "geneva-suppression-check should pass for ARO when Geneva suppression is explicitly confirmed"
  fi
}

main() {
  run_latest_tag_check
  run_gateway_values_check
  run_gateway_deploy_path_check
  run_gateway_deploy_skip_bootstrap_check
  run_none_values_check
  run_none_deploy_path_check
  run_immutable_tag_check
  run_frontend_auth_secret_flag_check
  run_clusterissuer_manifest_check
  run_clusterissuer_manifest_requires_email_check
  run_gatewayclass_manifest_check
  run_cert_manager_gateway_api_enable_check
  run_gateway_ready_missing_gateway_check
  run_gateway_ready_stale_status_check
  run_gateway_ready_listener_conditions_check
  run_gateway_stack_cleanup_check
  run_gateway_stack_existing_issuers_without_email_check
  run_tempfile_collision_check
  run_wait_for_rollout_gateway_tls_check
  run_prod_status_metadata_publicservice_check
  run_public_exposure_audit_metadata_publicservice_check
  run_public_exposure_audit_operator_override_check
  run_public_exposure_audit_gateway_frontend_ingress_rejection_check
  run_public_exposure_audit_gateway_backend_ingress_rejection_check
  run_e2e_route_up_default_none_mode_check
  run_e2e_route_up_explicit_override_check
  run_e2e_route_refresh_metadata_mode_check
  run_makefile_gateway_defaults_check
  run_makefile_gateway_audit_targets_check
  run_makefile_port_forward_e2e_targets_check
  run_geneva_suppression_gate_scope_check
  echo "AKS deploy helper tests passed."
}

main "$@"
