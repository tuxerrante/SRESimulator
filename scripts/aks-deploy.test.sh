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

run_immutable_tag_check() {
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
  AOAI_MODEL="gpt-4.1"

  if ! helm_deploy_sre "sre-simulator" "v1.2.3" "probe-token" >"$TMP_DIR/immutable.txt" 2>&1; then
    cat "$TMP_DIR/immutable.txt" >&2 || true
    fail "helm_deploy_sre should succeed for an immutable semver tag"
  fi

  assert_contains "frontend.image.pullPolicy=IfNotPresent" "$TMP_DIR/helm-args.txt"
  assert_contains "backend.image.pullPolicy=IfNotPresent" "$TMP_DIR/helm-args.txt"
  assert_contains "ai.model=gpt-4.1" "$TMP_DIR/helm-args.txt"
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

run_makefile_gateway_defaults_check() {
  local makefile="$ROOT_DIR/Makefile"

  assert_contains 'AKS_EXPOSURE_MODE ?= gateway' "$makefile"
  assert_contains 'AKS_GATEWAY_HOST ?= play.sresimulator.osadev.cloud' "$makefile"
  assert_contains 'AKS_GATEWAY_CLASS_NAME ?= eg' "$makefile"
  assert_contains 'AKS_GATEWAY_TLS_SECRET_NAME ?= sre-simulator-gateway-tls' "$makefile"
  assert_contains 'AKS_CLUSTER_ISSUER_NAME ?= letsencrypt-azuredns-prod' "$makefile"
  assert_contains 'AKS_DNS_ZONE_NAME ?= osadev.cloud' "$makefile"
  assert_contains 'AKS_DNS_ZONE_RESOURCE_GROUP ?= dns' "$makefile"
  assert_contains 'AKS_CERT_MANAGER_IDENTITY_NAME ?= $(if $(strip $(AKS_CLUSTER)),$(AKS_CLUSTER)-cert-manager-dns,)' "$makefile"
  assert_contains 'AKS_CERT_MANAGER_ACME_EMAIL ?= aaffinit@redhat.com' "$makefile"
  assert_contains 'AKS_SKIP_GATEWAY_BOOTSTRAP ?= false' "$makefile"
  assert_contains 'export AKS_EXPOSURE_MODE AKS_GATEWAY_HOST AKS_GATEWAY_CLASS_NAME' "$makefile"
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
  run_immutable_tag_check
  run_clusterissuer_manifest_check
  run_gatewayclass_manifest_check
  run_cert_manager_gateway_api_enable_check
  run_gateway_ready_missing_gateway_check
  run_gateway_ready_stale_status_check
  run_gateway_ready_listener_conditions_check
  run_gateway_stack_cleanup_check
  run_tempfile_collision_check
  run_wait_for_rollout_gateway_tls_check
  run_prod_status_metadata_publicservice_check
  run_public_exposure_audit_metadata_publicservice_check
  run_public_exposure_audit_operator_override_check
  run_public_exposure_audit_gateway_frontend_ingress_rejection_check
  run_public_exposure_audit_gateway_backend_ingress_rejection_check
  run_makefile_gateway_defaults_check
  run_makefile_gateway_audit_targets_check
  run_geneva_suppression_gate_scope_check
  echo "AKS deploy helper tests passed."
}

main "$@"
