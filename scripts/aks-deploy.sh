#!/usr/bin/env bash
# AKS-specific deployment helpers. Sourced (not executed) by Make recipes.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KUBE_CLI=kubectl
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/kube-deploy-common.sh"

ENVOY_GATEWAY_CHART="oci://docker.io/envoyproxy/gateway-helm"
ENVOY_GATEWAY_VERSION="v1.6.5"
ENVOY_GATEWAY_CONTROLLER_NAME="gateway.envoyproxy.io/gatewayclass-controller"
CERT_MANAGER_CHART="jetstack/cert-manager"
CERT_MANAGER_VERSION="v1.20.1"

cleanup_manifest_files() {
  if [ "$#" -gt 0 ]; then
    rm -f "$@"
  fi
}

apply_aks_gateway_defaults() {
  AKS_EXPOSURE_MODE="${AKS_EXPOSURE_MODE:-gateway}"
  AKS_SKIP_GATEWAY_BOOTSTRAP="${AKS_SKIP_GATEWAY_BOOTSTRAP:-false}"
  AKS_GATEWAY_HOST="${AKS_GATEWAY_HOST:-play.sresimulator.osadev.cloud}"
  AKS_GATEWAY_CLASS_NAME="${AKS_GATEWAY_CLASS_NAME:-eg}"
  AKS_GATEWAY_TLS_SECRET_NAME="${AKS_GATEWAY_TLS_SECRET_NAME:-sre-simulator-gateway-tls}"
  AKS_CLUSTER_ISSUER_NAME="${AKS_CLUSTER_ISSUER_NAME:-letsencrypt-azuredns-prod}"
  AKS_DNS_ZONE_NAME="${AKS_DNS_ZONE_NAME:-osadev.cloud}"
  AKS_DNS_ZONE_RESOURCE_GROUP="${AKS_DNS_ZONE_RESOURCE_GROUP:-dns}"
  AKS_CERT_MANAGER_ACME_EMAIL="${AKS_CERT_MANAGER_ACME_EMAIL:-}"
  if [ -z "${AKS_CERT_MANAGER_IDENTITY_NAME:-}" ] && [ -n "${AKS_CLUSTER:-}" ]; then
    AKS_CERT_MANAGER_IDENTITY_NAME="${AKS_CLUSTER}-cert-manager-dns"
  fi
}

require_aks_gateway_acme_email() {
  apply_aks_gateway_defaults
  if [ -n "${AKS_CERT_MANAGER_ACME_EMAIL}" ]; then
    return 0
  fi

  echo "error: AKS_CERT_MANAGER_ACME_EMAIL is required to render AKS cert-manager ClusterIssuers" >&2
  return 1
}

aks_gateway_bootstrap_enabled() {
  apply_aks_gateway_defaults
  case "${AKS_SKIP_GATEWAY_BOOTSTRAP}" in
    1|true|TRUE|yes|YES)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

aks_gateway_issuers_exist() {
  "$KUBE_CLI" get "clusterissuer/letsencrypt-azuredns-staging" >/dev/null 2>&1 && \
    "$KUBE_CLI" get "clusterissuer/letsencrypt-azuredns-prod" >/dev/null 2>&1
}

aks_login() {
  require_cli az
  require_cli kubectl

  ensure_azure_login
  az account set -s "$AZURE_SUBSCRIPTION_ID"
  az aks get-credentials \
    --resource-group "$AKS_RG" \
    --name "$AKS_CLUSTER" \
    --overwrite-existing >/dev/null
}

print_aks_login_summary() {
  local sub_name kube_context kube_server
  sub_name=$(az account show --query name -o tsv)
  kube_context=$(kubectl config current-context)
  kube_server=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')

  echo "Azure subscription: $sub_name ($AZURE_SUBSCRIPTION_ID)"
  echo "Kubernetes context: $kube_context"
  echo "Kubernetes server: $kube_server"
}

cluster_login() {
  aks_login
}

print_cluster_login_summary() {
  print_aks_login_summary
}

resolve_aks_public_endpoint() {
  local pip_name fqdn ip
  pip_name="${AKS_FRONTEND_PUBLIC_IP_NAME:-${AKS_CLUSTER}-aks-frontend-pip}"

  ip=$(az network public-ip show \
    -g "$AKS_RG" -n "$pip_name" \
    --query ipAddress -o tsv)
  fqdn=$(az network public-ip show \
    -g "$AKS_RG" -n "$pip_name" \
    --query dnsSettings.fqdn -o tsv 2>/dev/null || true)

  if [ -z "$ip" ]; then
    echo "error: failed to resolve AKS public IP '$pip_name' in resource group '$AKS_RG'" >&2
    return 1
  fi

  AKS_FRONTEND_PUBLIC_IP_NAME="$pip_name"
  AKS_FRONTEND_PUBLIC_IP="$ip"
  AKS_FRONTEND_PUBLIC_FQDN="$fqdn"
  AKS_FRONTEND_PUBLIC_ENDPOINT_HOST="${AKS_FRONTEND_PUBLIC_HOST:-${fqdn:-$ip}}"
}

resolve_aks_gateway_identity_client_id() {
  local client_id identity_name

  require_cli az
  apply_aks_gateway_defaults
  identity_name="${AKS_CERT_MANAGER_IDENTITY_NAME}"

  if [ -z "$identity_name" ]; then
    echo "error: AKS_CERT_MANAGER_IDENTITY_NAME or AKS_CLUSTER is required to resolve the AKS gateway identity client ID" >&2
    return 1
  fi

  client_id="$(az identity show \
    -g "$AKS_RG" \
    -n "$identity_name" \
    --query clientId -o tsv)"

  if [ -z "$client_id" ]; then
    echo "error: failed to resolve AKS gateway identity client ID for '$identity_name' in resource group '$AKS_RG'" >&2
    return 1
  fi

  AKS_CERT_MANAGER_IDENTITY_CLIENT_ID="$client_id"
}

write_aks_clusterissuer_manifest() {
  local manifest_file

  apply_aks_gateway_defaults
  require_aks_gateway_acme_email || return 1
  manifest_file="$(mktemp "${TMPDIR:-/tmp}/sre-aks-clusterissuer.XXXXXX")"
  if ! cat >"$manifest_file" <<EOF
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-azuredns-staging
spec:
  acme:
    email: ${AKS_CERT_MANAGER_ACME_EMAIL}
    server: https://acme-staging-v02.api.letsencrypt.org/directory
    privateKeySecretRef:
      name: letsencrypt-azuredns-staging-account-key
    solvers:
      - dns01:
          azureDNS:
            subscriptionID: ${AZURE_SUBSCRIPTION_ID}
            resourceGroupName: ${AKS_DNS_ZONE_RESOURCE_GROUP}
            hostedZoneName: ${AKS_DNS_ZONE_NAME}
            environment: AzurePublicCloud
            managedIdentity:
              clientID: ${AKS_CERT_MANAGER_IDENTITY_CLIENT_ID}
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-azuredns-prod
spec:
  acme:
    email: ${AKS_CERT_MANAGER_ACME_EMAIL}
    server: https://acme-v02.api.letsencrypt.org/directory
    privateKeySecretRef:
      name: letsencrypt-azuredns-prod-account-key
    solvers:
      - dns01:
          azureDNS:
            subscriptionID: ${AZURE_SUBSCRIPTION_ID}
            resourceGroupName: ${AKS_DNS_ZONE_RESOURCE_GROUP}
            hostedZoneName: ${AKS_DNS_ZONE_NAME}
            environment: AzurePublicCloud
            managedIdentity:
              clientID: ${AKS_CERT_MANAGER_IDENTITY_CLIENT_ID}
EOF
  then
    rm -f "$manifest_file"
    return 1
  fi

  printf '%s\n' "$manifest_file"
}

write_aks_envoyproxy_manifest() {
  local ns=$1 manifest_file release_name

  release_name="${E2E_RELEASE:-sre-simulator}"
  manifest_file="$(mktemp "${TMPDIR:-/tmp}/sre-aks-envoyproxy.XXXXXX")"
  if ! cat >"$manifest_file" <<EOF
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: ${release_name}-public-edge
  namespace: ${ns}
spec:
  provider:
    type: Kubernetes
    kubernetes:
      envoyService:
        patch:
          type: StrategicMerge
          value:
            metadata:
              annotations:
                service.beta.kubernetes.io/azure-load-balancer-resource-group: "${AKS_RG}"
                service.beta.kubernetes.io/azure-pip-name: "${AKS_FRONTEND_PUBLIC_IP_NAME}"
            spec:
              loadBalancerIP: "${AKS_FRONTEND_PUBLIC_IP}"
EOF
  then
    rm -f "$manifest_file"
    return 1
  fi

  printf '%s\n' "$manifest_file"
}

write_aks_gatewayclass_manifest() {
  local manifest_file

  apply_aks_gateway_defaults
  manifest_file="$(mktemp "${TMPDIR:-/tmp}/sre-aks-gatewayclass.XXXXXX")"
  if ! cat >"$manifest_file" <<EOF
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: ${AKS_GATEWAY_CLASS_NAME}
spec:
  controllerName: ${ENVOY_GATEWAY_CONTROLLER_NAME}
EOF
  then
    rm -f "$manifest_file"
    return 1
  fi

  printf '%s\n' "$manifest_file"
}

write_aks_exposure_values() {
  local mode release_name values_file

  apply_aks_gateway_defaults
  mode="${AKS_EXPOSURE_MODE}"
  release_name="${E2E_RELEASE:-sre-simulator}"
  values_file="$(mktemp "${TMPDIR:-/tmp}/sre-aks-exposure.XXXXXX")"
  if ! cat >"$values_file" <<EOF
exposure:
  mode: "${mode}"
  host: "${DEPLOY_HOST}"
  scheme: "${DEPLOY_SCHEME}"
gateway:
  className: "${AKS_GATEWAY_CLASS_NAME}"
  tls:
    secretName: "${AKS_GATEWAY_TLS_SECRET_NAME}"
  certManager:
    clusterIssuer: "${AKS_CLUSTER_ISSUER_NAME}"
  envoyProxy:
    name: "${release_name}-public-edge"
EOF
  then
    rm -f "$values_file"
    return 1
  fi

  if [ "$mode" = "publicService" ]; then
    if ! cat >>"$values_file" <<EOF
frontend:
  service:
    public:
      loadBalancerIP: "${AKS_FRONTEND_PUBLIC_IP}"
      annotations:
        service.beta.kubernetes.io/azure-load-balancer-resource-group: "${AKS_RG}"
        service.beta.kubernetes.io/azure-pip-name: "${AKS_FRONTEND_PUBLIC_IP_NAME}"
EOF
    then
      rm -f "$values_file"
      return 1
    fi
  fi

  printf '%s\n' "$values_file"
}

write_aks_public_exposure_values() {
  write_aks_exposure_values "$@"
}

ensure_cert_manager() {
  local validating_webhook_selector

  require_cli helm
  validating_webhook_selector='{"matchExpressions":[{"key":"cert-manager.io/disable-validation","operator":"NotIn","values":["true"]},{"key":"control-plane","operator":"NotIn","values":["true"]},{"key":"kubernetes.azure.com/managedby","operator":"NotIn","values":["aks"]}]}'

  helm repo add jetstack https://charts.jetstack.io --force-update >/dev/null
  helm upgrade --install cert-manager "$CERT_MANAGER_CHART" \
    --namespace cert-manager \
    --create-namespace \
    --version "$CERT_MANAGER_VERSION" \
    --set crds.enabled=true \
    --set config.enableGatewayAPI=true \
    --set-json "webhook.validatingWebhookConfiguration.namespaceSelector=${validating_webhook_selector}" \
    --set-string podLabels.azure\\.workload\\.identity/use=true \
    --set-string serviceAccount.annotations.azure\\.workload\\.identity/client-id="${AKS_CERT_MANAGER_IDENTITY_CLIENT_ID}" \
    --wait --timeout 10m >/dev/null
}

ensure_envoy_gateway() {
  require_cli helm

  helm upgrade --install envoy-gateway "$ENVOY_GATEWAY_CHART" \
    --namespace envoy-gateway-system \
    --create-namespace \
    --version "$ENVOY_GATEWAY_VERSION" \
    --wait --timeout 10m >/dev/null
}

ensure_aks_gateway_stack() {
  local ns=$1 gatewayclass_manifest="" envoyproxy_manifest="" issuer_manifest=""
  local manifest_files=()

  cleanup_aks_gateway_stack_artifacts() {
    cleanup_manifest_files "${manifest_files[@]}"
  }

  resolve_aks_public_endpoint || return 1
  resolve_aks_gateway_identity_client_id || return 1
  ensure_envoy_gateway || return 1
  ensure_cert_manager || return 1

  if ! gatewayclass_manifest="$(write_aks_gatewayclass_manifest)"; then
    cleanup_aks_gateway_stack_artifacts
    return 1
  fi
  manifest_files+=("$gatewayclass_manifest")
  if [ -n "${AKS_CERT_MANAGER_ACME_EMAIL:-}" ] || ! aks_gateway_issuers_exist; then
    if ! issuer_manifest="$(write_aks_clusterissuer_manifest)"; then
      cleanup_aks_gateway_stack_artifacts
      return 1
    fi
    manifest_files+=("$issuer_manifest")
  fi
  if ! envoyproxy_manifest="$(write_aks_envoyproxy_manifest "$ns")"; then
    cleanup_aks_gateway_stack_artifacts
    return 1
  fi
  manifest_files+=("$envoyproxy_manifest")

  if ! "$KUBE_CLI" apply -f "$gatewayclass_manifest" >/dev/null; then
    cleanup_aks_gateway_stack_artifacts
    return 1
  fi
  if [ -n "$issuer_manifest" ]; then
    if ! "$KUBE_CLI" apply -f "$issuer_manifest" >/dev/null; then
      cleanup_aks_gateway_stack_artifacts
      return 1
    fi
  fi
  if ! "$KUBE_CLI" apply -f "$envoyproxy_manifest" >/dev/null; then
    cleanup_aks_gateway_stack_artifacts
    return 1
  fi

  cleanup_aks_gateway_stack_artifacts
}

prepare_release_images() {
  # AKS deploys consume GHCR-published images directly.
  return 0
}

image_pull_policy_for_tag() {
  case "$1" in
    latest)
      printf '%s\n' "Always"
      ;;
    *)
      printf '%s\n' "IfNotPresent"
      ;;
  esac
}

# Usage: helm_deploy_sre <namespace> <tag> <probe-token>
# Sets DEPLOY_HOST/DEPLOY_SCHEME for use by caller.
helm_deploy_sre() {
  local ns=$1 tag=$2 probe_token=$3

  require_cli helm
  ensure_namespace "$ns"
  apply_aks_gateway_defaults

  if [ "$AKS_EXPOSURE_MODE" = "gateway" ]; then
    if aks_gateway_bootstrap_enabled; then
      ensure_aks_gateway_stack "$ns" || return 1
    fi
    DEPLOY_HOST="$AKS_GATEWAY_HOST"
    DEPLOY_SCHEME="https"
  else
    resolve_aks_public_endpoint || return 1
    DEPLOY_HOST="$AKS_FRONTEND_PUBLIC_ENDPOINT_HOST"
    DEPLOY_SCHEME="${AKS_FRONTEND_PUBLIC_ORIGIN_SCHEME:-http}"
  fi

  local exposure_values_file
  if ! exposure_values_file="$(write_aks_exposure_values)"; then
    return 1
  fi

  local db_flags=()
  local image_pull_flags=()
  local aoai_route_flags=()
  local image_pull_policy
  local aoai_model

  image_pull_policy="$(image_pull_policy_for_tag "$tag")"
  aoai_model="${AOAI_MODEL:-${AOAI_DEPLOYMENT}}"

  if [ -n "${GHCR_IMAGE_PULL_SECRET:-}" ]; then
    image_pull_flags+=(--set "imagePullSecrets[0]=${GHCR_IMAGE_PULL_SECRET}")
  fi

  if [ -n "${DB_SECRET_NAME:-}" ]; then
    db_flags=(
      --set database.enabled=true
      --set "database.existingSecretName=${DB_SECRET_NAME}"
      --set backend.autoscaling.enabled=true
      --set "backend.autoscaling.minReplicas=${AKS_BACKEND_MIN_REPLICAS:-1}"
      --set "backend.autoscaling.maxReplicas=${AKS_BACKEND_MAX_REPLICAS:-4}"
    )
  else
    db_flags=(
      --set database.enabled=false
      --set backend.autoscaling.enabled=false
    )
  fi

  if [ -n "${AOAI_DEPLOYMENT_CHAT:-}" ]; then
    aoai_route_flags+=(--set "ai.azureOpenai.routeDeployments.chat=${AOAI_DEPLOYMENT_CHAT}")
  fi
  if [ -n "${AOAI_DEPLOYMENT_COMMAND:-}" ]; then
    aoai_route_flags+=(--set "ai.azureOpenai.routeDeployments.command=${AOAI_DEPLOYMENT_COMMAND}")
  fi
  if [ -n "${AOAI_DEPLOYMENT_SCENARIO:-}" ]; then
    aoai_route_flags+=(--set "ai.azureOpenai.routeDeployments.scenario=${AOAI_DEPLOYMENT_SCENARIO}")
  fi
  if [ -n "${AOAI_DEPLOYMENT_PROBE:-}" ]; then
    aoai_route_flags+=(--set "ai.azureOpenai.routeDeployments.probe=${AOAI_DEPLOYMENT_PROBE}")
  fi

  if ! helm upgrade --install "$E2E_RELEASE" ./helm/sre-simulator -n "$ns" \
    --create-namespace \
    -f "$exposure_values_file" \
    --set "frontend.image.repository=${AKS_FRONTEND_IMAGE_REPO:-ghcr.io/tuxerrante/sre-simulator-frontend}" \
    --set "frontend.image.tag=${tag}" \
    --set "frontend.image.pullPolicy=${image_pull_policy}" \
    --set frontend.replicas=1 \
    --set frontend.autoscaling.enabled=true \
    --set "frontend.autoscaling.minReplicas=${AKS_FRONTEND_MIN_REPLICAS:-1}" \
    --set "frontend.autoscaling.maxReplicas=${AKS_FRONTEND_MAX_REPLICAS:-3}" \
    --set "backend.image.repository=${AKS_BACKEND_IMAGE_REPO:-ghcr.io/tuxerrante/sre-simulator-backend}" \
    --set "backend.image.tag=${tag}" \
    --set "backend.image.pullPolicy=${image_pull_policy}" \
    --set backend.replicas=1 \
    --set "backend.port=${BACKEND_PORT:-8080}" \
    --set "frontend.port=${FRONTEND_PORT:-3000}" \
    --set ai.provider=azure-openai \
    --set ai.mockMode=false \
    --set "ai.model=${aoai_model}" \
    --set "ai.azureOpenai.endpointFromSecret.existingSecretName=azure-openai-creds" \
    --set "ai.azureOpenai.endpointFromSecret.key=endpoint" \
    --set "ai.azureOpenai.deployment=${AOAI_DEPLOYMENT}" \
    --set "ai.azureOpenai.credentials.existingSecretName=azure-openai-creds" \
    --set "ai.azureOpenai.credentials.key=api-key" \
    --set "ai.liveProbeToken=${probe_token}" \
    "${aoai_route_flags[@]}" \
    "${image_pull_flags[@]}" \
    "${db_flags[@]}" \
    --wait --timeout 15m >/dev/null; then
    rm -f "$exposure_values_file"
    return 1
  fi

  rm -f "$exposure_values_file"
}
