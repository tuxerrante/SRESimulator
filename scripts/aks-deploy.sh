#!/usr/bin/env bash
# AKS-specific deployment helpers. Sourced (not executed) by Make recipes.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KUBE_CLI=kubectl
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/kube-deploy-common.sh"

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

write_aks_frontend_service_values() {
  local values_file
  values_file="$(mktemp "${TMPDIR:-/tmp}/sre-aks-frontend-service-XXXXXX.yaml")"
  if ! cat >"$values_file" <<EOF
frontend:
  service:
    public:
      enabled: true
      loadBalancerIP: "${AKS_FRONTEND_PUBLIC_IP}"
      annotations:
        service.beta.kubernetes.io/azure-load-balancer-resource-group: "${AKS_RG}"
        service.beta.kubernetes.io/azure-pip-name: "${AKS_FRONTEND_PUBLIC_IP_NAME}"
EOF
  then
    rm -f "$values_file"
    return 1
  fi
  printf '%s\n' "$values_file"
}

prepare_release_images() {
  # AKS deploys consume GHCR-published images directly.
  return 0
}

# Usage: helm_deploy_sre <namespace> <tag> <probe-token>
# Sets DEPLOY_HOST/DEPLOY_SCHEME for use by caller.
helm_deploy_sre() {
  local ns=$1 tag=$2 probe_token=$3

  require_cli helm
  ensure_namespace "$ns"
  resolve_aks_public_endpoint

  local frontend_service_values_file
  if ! frontend_service_values_file="$(write_aks_frontend_service_values)"; then
    return 1
  fi

  DEPLOY_HOST="$AKS_FRONTEND_PUBLIC_ENDPOINT_HOST"
  DEPLOY_SCHEME="${AKS_FRONTEND_PUBLIC_ORIGIN_SCHEME:-http}"

  local db_flags=()
  local image_pull_flags=()
  local aoai_route_flags=()

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
    -f "$frontend_service_values_file" \
    --set route.enabled=false \
    --set ingress.enabled=false \
    --set "publicOrigin=${DEPLOY_SCHEME}://${DEPLOY_HOST}" \
    --set "frontend.image.repository=${AKS_FRONTEND_IMAGE_REPO:-ghcr.io/tuxerrante/sre-simulator-frontend}" \
    --set "frontend.image.tag=${tag}" \
    --set frontend.image.pullPolicy=IfNotPresent \
    --set frontend.replicas=1 \
    --set frontend.autoscaling.enabled=true \
    --set "frontend.autoscaling.minReplicas=${AKS_FRONTEND_MIN_REPLICAS:-1}" \
    --set "frontend.autoscaling.maxReplicas=${AKS_FRONTEND_MAX_REPLICAS:-3}" \
    --set "backend.image.repository=${AKS_BACKEND_IMAGE_REPO:-ghcr.io/tuxerrante/sre-simulator-backend}" \
    --set "backend.image.tag=${tag}" \
    --set backend.image.pullPolicy=IfNotPresent \
    --set backend.replicas=1 \
    --set "backend.port=${BACKEND_PORT:-8080}" \
    --set "frontend.port=${FRONTEND_PORT:-3000}" \
    --set "ai.azureOpenai.existingSecretName=azure-openai-creds" \
    --set "ai.azureOpenai.deployment=${AOAI_DEPLOYMENT}" \
    --set "ai.liveProbeToken=${probe_token}" \
    "${aoai_route_flags[@]}" \
    "${image_pull_flags[@]}" \
    "${db_flags[@]}" \
    --wait --timeout 15m >/dev/null; then
    rm -f "$frontend_service_values_file"
    return 1
  fi

  rm -f "$frontend_service_values_file"
}
