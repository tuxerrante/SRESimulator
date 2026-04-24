#!/usr/bin/env bash
# ARO-specific deployment helpers. Sourced (not executed) by Make recipes.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KUBE_CLI=oc
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/kube-deploy-common.sh"

aro_login() {
  require_cli az
  require_cli oc
  ensure_azure_login
  az account set -s "$AZURE_SUBSCRIPTION_ID" >/dev/null
  local api pass
  api=$(az aro show -g "$ARO_RG" -n "$ARO_CLUSTER" \
    --query apiserverProfile.url -o tsv)
  pass=$(az aro list-credentials -g "$ARO_RG" -n "$ARO_CLUSTER" \
    --query kubeadminPassword -o tsv)
  oc login "$api" -u kubeadmin -p "$pass" \
    --insecure-skip-tls-verify=true >/dev/null
}

print_aro_login_summary() {
  local account_name account_id oc_user oc_server
  account_name=$(az account show --query name -o tsv)
  account_id=$(az account show --query id -o tsv)
  oc_user=$(oc whoami)
  oc_server=$(oc whoami --show-server)

  echo "Azure subscription: $account_name ($account_id)"
  echo "OpenShift user: $oc_user"
  echo "OpenShift server: $oc_server"
}

cluster_login() {
  aro_login
}

print_cluster_login_summary() {
  print_aro_login_summary
}

# Usage: patch_bc_strategy <namespace> <bc-name> <dockerfile-path>
patch_bc_strategy() {
  local ns=$1 name=$2 dockerfile=$3
  oc -n "$ns" patch "bc/$name" --type=merge \
    -p "{\"spec\":{\"strategy\":{\"dockerStrategy\":{\"dockerfilePath\":\"$dockerfile\",\"buildArgs\":[{\"name\":\"NPM_VERSION\",\"value\":\"$NPM_VERSION\"}]}}}}" \
    >/dev/null
}

# Usage: oc_build_timed <namespace> <bc-name>
# Retries up to OC_BUILD_MAX_RETRIES (default 3) on transient FetchSourceFailed
# errors from the cluster image registry. Non-retryable failures (e.g. Dockerfile
# errors) abort immediately.
oc_build_timed() {
  local ns=$1 name=$2
  local max_retries=${OC_BUILD_MAX_RETRIES:-3}
  if ! [[ "$max_retries" =~ ^[1-9][0-9]*$ ]]; then
    max_retries=3
  fi
  echo "Building $name image (upload + build)..."
  local t0 t1 archive
  archive="$(mktemp "${TMPDIR:-/tmp}/oc-build-XXXXXX").tar.gz"
  local tar_extra_flags=()
  # BSD tar on macOS embeds PAX headers (xattrs, resource forks) that
  # OpenShift builder pods cannot extract. Probe whether the local tar accepts
  # --no-mac-metadata by creating a throwaway archive.
  if tar cf /dev/null --no-mac-metadata /dev/null 2>/dev/null; then
    tar_extra_flags+=(--no-mac-metadata --no-xattrs --no-fflags)
  fi
  COPYFILE_DISABLE=1 tar czf "$archive" \
    "${tar_extra_flags[@]}" \
    --exclude-from=.dockerignore .
  local size
  size=$(du -h "$archive" | cut -f1)
  echo "  Archive: $size (filtered via .dockerignore)"
  t0=$(date +%s)
  local attempt=1
  while true; do
    if oc -n "$ns" start-build "$name" --from-archive="$archive" --follow --wait >/dev/null; then
      break
    fi
    local last_build reason
    last_build=$(oc -n "$ns" get builds --selector="buildconfig=$name" \
      --sort-by=.metadata.creationTimestamp -o name 2>/dev/null | tail -n 1 || true)
    if [ -z "$last_build" ]; then
      echo "  $name build failed and no Build object was found; not retrying."
      rm -f "$archive"
      return 1
    fi
    reason=$(oc -n "$ns" get "$last_build" -o jsonpath='{.status.reason}' 2>/dev/null || true)
    if [ "$reason" != "FetchSourceFailed" ]; then
      echo "  $name build failed with non-retryable reason: ${reason:-unknown}"
      rm -f "$archive"
      return 1
    fi
    if [ "$attempt" -ge "$max_retries" ]; then
      echo "  $name build failed with FetchSourceFailed after $max_retries attempt(s)"
      rm -f "$archive"
      return 1
    fi
    local delay=$(( attempt * 10 ))
    echo "  Attempt $attempt/$max_retries failed (FetchSourceFailed), retrying in ${delay}s..."
    sleep "$delay"
    attempt=$(( attempt + 1 ))
  done
  t1=$(date +%s)
  rm -f "$archive"
  echo "  $name build completed in $(( t1 - t0 ))s (attempt $attempt/$max_retries)"
}

prepare_release_images() {
  local ns=$1 tag=$2
  ensure_namespace "$ns"

  if ! oc -n "$ns" get bc/sre-simulator-frontend >/dev/null 2>&1; then
    oc -n "$ns" new-build --name=sre-simulator-frontend --binary=true --strategy=docker --to=sre-simulator-frontend:"$tag" >/dev/null
  fi
  if ! oc -n "$ns" get bc/sre-simulator-backend >/dev/null 2>&1; then
    oc -n "$ns" new-build --name=sre-simulator-backend --binary=true --strategy=docker --to=sre-simulator-backend:"$tag" >/dev/null
  fi

  oc -n "$ns" patch bc/sre-simulator-frontend --type=merge \
    -p "{\"spec\":{\"output\":{\"to\":{\"kind\":\"ImageStreamTag\",\"name\":\"sre-simulator-frontend:$tag\"}}}}" >/dev/null
  patch_bc_strategy "$ns" sre-simulator-frontend frontend/Dockerfile

  oc -n "$ns" patch bc/sre-simulator-backend --type=merge \
    -p "{\"spec\":{\"output\":{\"to\":{\"kind\":\"ImageStreamTag\",\"name\":\"sre-simulator-backend:$tag\"}}}}" >/dev/null
  patch_bc_strategy "$ns" sre-simulator-backend backend/Dockerfile

  oc_build_timed "$ns" sre-simulator-frontend
  oc_build_timed "$ns" sre-simulator-backend
}

# Usage: helm_deploy_sre <namespace> <tag> <probe-token>
# Sets DEPLOY_HOST for use by caller.
# Optional env: DB_SECRET_NAME — when set, enables Azure SQL persistence
#   via database.enabled=true and database.existingSecretName. Callers should
#   run ensure_db_secret_for_e2e_namespace <namespace> first so the secret exists
#   in that namespace when reusing credentials from elsewhere.
helm_deploy_sre() {
  local ns=$1 tag=$2 probe_token=$3
  DEPLOY_DOMAIN=$(oc get ingresses.config/cluster -o jsonpath='{.spec.domain}')
  DEPLOY_HOST="${ns}.${DEPLOY_DOMAIN}"
  DEPLOY_SCHEME="https"

  local db_flags=()
  local aoai_route_flags=()
  if [ -n "${DB_SECRET_NAME:-}" ]; then
    db_flags=(--set database.enabled=true
              --set "database.existingSecretName=$DB_SECRET_NAME")
  fi

  if [ -n "${AOAI_DEPLOYMENT_CHAT:-}" ]; then
    aoai_route_flags+=(--set "ai.azureOpenai.routeDeployments.chat=$AOAI_DEPLOYMENT_CHAT")
  fi
  if [ -n "${AOAI_DEPLOYMENT_COMMAND:-}" ]; then
    aoai_route_flags+=(--set "ai.azureOpenai.routeDeployments.command=$AOAI_DEPLOYMENT_COMMAND")
  fi
  if [ -n "${AOAI_DEPLOYMENT_SCENARIO:-}" ]; then
    aoai_route_flags+=(--set "ai.azureOpenai.routeDeployments.scenario=$AOAI_DEPLOYMENT_SCENARIO")
  fi
  if [ -n "${AOAI_DEPLOYMENT_PROBE:-}" ]; then
    aoai_route_flags+=(--set "ai.azureOpenai.routeDeployments.probe=$AOAI_DEPLOYMENT_PROBE")
  fi

  helm upgrade --install "$E2E_RELEASE" ./helm/sre-simulator -n "$ns" \
    --set-string exposure.mode=route \
    --set-string "exposure.host=$DEPLOY_HOST" \
    --set frontend.image.repository="image-registry.openshift-image-registry.svc:5000/$ns/sre-simulator-frontend" \
    --set frontend.image.tag="$tag" \
    --set frontend.image.pullPolicy=Always \
    --set backend.image.repository="image-registry.openshift-image-registry.svc:5000/$ns/sre-simulator-backend" \
    --set backend.image.tag="$tag" \
    --set backend.image.pullPolicy=Always \
    --set ai.provider=azure-openai \
    --set ai.mockMode=false \
    --set ai.strictStartup=true \
    --set ai.model="$AOAI_DEPLOYMENT" \
    --set-string ai.liveProbeToken="$probe_token" \
    --set ai.azureOpenai.endpointFromSecret.existingSecretName=azure-openai-creds \
    --set ai.azureOpenai.endpointFromSecret.key=endpoint \
    --set ai.azureOpenai.deployment="$AOAI_DEPLOYMENT" \
    --set ai.azureOpenai.apiVersion=2024-10-21 \
    --set ai.azureOpenai.credentials.existingSecretName=azure-openai-creds \
    --set ai.azureOpenai.credentials.key=api-key \
    "${aoai_route_flags[@]}" \
    "${db_flags[@]}" \
    --wait --timeout 15m >/dev/null
}
