#!/usr/bin/env bash
# Shared functions for ARO deployment Makefile targets.
# Sourced (not executed) by Make recipes; expects these environment
# variables exported from the Makefile:
#   AZURE_SUBSCRIPTION_ID, ARO_RG, ARO_CLUSTER
#   AOAI_RG, AOAI_ACCOUNT, AOAI_DEPLOYMENT
#   E2E_RELEASE, NPM_VERSION
#   PROD_NAMESPACE, DB_SECRET_NAME, DB_SECRET_SOURCE_NAMESPACE

require_cli() {
  local cli=$1
  if ! command -v "$cli" >/dev/null 2>&1; then
    echo "error: required CLI '$cli' is not installed or not in PATH" >&2
    return 1
  fi
}

ensure_azure_login() {
  require_cli az
  if az account show --query id -o tsv >/dev/null 2>&1; then
    return 0
  fi

  echo "Azure CLI is not logged in. Starting interactive device-code login..."
  az login --use-device-code
}

aro_login() {
  require_cli az
  require_cli oc
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

aoai_fetch_creds() {
  AOAI_ENDPOINT=$(az cognitiveservices account show \
    -g "$AOAI_RG" -n "$AOAI_ACCOUNT" \
    --query properties.endpoint -o tsv | sed 's:/*$::')
  AOAI_KEY=$(az cognitiveservices account keys list \
    -g "$AOAI_RG" -n "$AOAI_ACCOUNT" \
    --query key1 -o tsv)
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
  # OpenShift builder pods cannot extract.  Probe whether the local tar
  # accepts --no-mac-metadata by creating a throwaway archive (--help
  # on newer bsdtar no longer lists the flag).
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

# Usage: copy_secret_across_namespaces <src_ns> <dst_ns> <secret_name>
# Re-applies the Secret in dst_ns from a live object in src_ns. Strips
# server-populated metadata with jq. Does not echo .data or stringData
# (stdout from oc apply is discarded).
copy_secret_across_namespaces() {
  local src_ns=$1 dst_ns=$2 secret_name=$3
  if [ "$src_ns" = "$dst_ns" ]; then
    if ! oc -n "$src_ns" get "secret/$secret_name" >/dev/null 2>&1; then
      echo "error: secret '$secret_name' not found in namespace '$src_ns'" >&2
      return 1
    fi
    return 0
  fi
  if ! oc -n "$src_ns" get "secret/$secret_name" >/dev/null 2>&1; then
    echo "error: secret '$secret_name' not found in namespace '$src_ns' (cannot copy into '$dst_ns')" >&2
    return 1
  fi
  if ! command -v jq >/dev/null 2>&1; then
    echo "error: jq is required to copy secret '$secret_name' from namespace '$src_ns' to '$dst_ns'" >&2
    return 1
  fi
  oc -n "$src_ns" get "secret/$secret_name" -o json \
    | jq '
        .metadata |= (
          del(
            .namespace,
            .uid,
            .resourceVersion,
            .creationTimestamp,
            .managedFields,
            .ownerReferences,
            .generation
          )
          | if .annotations then
              .annotations |= del(.["kubectl.kubernetes.io/last-applied-configuration"])
            else
              .
            end
        )
        | del(.status)
      ' \
    | oc -n "$dst_ns" apply -f - >/dev/null
}

# Usage: ensure_db_secret_for_e2e_namespace <dst_ns>
# When DB_SECRET_NAME is set, copies that secret from DB_SECRET_SOURCE_NAMESPACE
# if set, otherwise from PROD_NAMESPACE (default sre-simulator). No-op when
# DB_SECRET_NAME is unset. Skips copy when source and destination namespaces match.
ensure_db_secret_for_e2e_namespace() {
  local dst_ns=$1
  if [ -z "${DB_SECRET_NAME:-}" ]; then
    return 0
  fi
  local src_ns="${DB_SECRET_SOURCE_NAMESPACE:-${PROD_NAMESPACE:-sre-simulator}}"
  echo "Ensuring DB secret in '$dst_ns' (from namespace '$src_ns', secret '${DB_SECRET_NAME}'; payload not logged)."
  copy_secret_across_namespaces "$src_ns" "$dst_ns" "$DB_SECRET_NAME"
}

# Usage: require_prod_db_secret_name
# Production releases must opt into Azure SQL explicitly; refuse silent
# fallback to JSON/PVC mode when DB_SECRET_NAME is missing.
require_prod_db_secret_name() {
  if [ -n "${DB_SECRET_NAME:-}" ]; then
    return 0
  fi
  echo "DB_SECRET_NAME is required for production deployment with STORAGE_BACKEND=mssql." >&2
  return 1
}

# Usage: require_db_secret_exists_in_namespace <namespace>
require_db_secret_exists_in_namespace() {
  local ns=$1
  require_cli oc
  local err_file
  err_file="$(mktemp "${TMPDIR:-/tmp}/sre-db-secret-check-XXXXXX")"
  if oc -n "$ns" get "secret/${DB_SECRET_NAME}" >/dev/null 2>"$err_file"; then
    rm -f "$err_file"
    return 0
  fi
  if grep -Fq "secrets \"${DB_SECRET_NAME}\" not found" "$err_file" || \
     grep -Fq "secret \"${DB_SECRET_NAME}\" not found" "$err_file" || \
     grep -Fq "secret/${DB_SECRET_NAME}\" not found" "$err_file"; then
    echo "DB secret '${DB_SECRET_NAME}' was not found in namespace '${ns}'." >&2
    echo "Create or copy it before running a production deployment." >&2
  else
    echo "Failed to verify DB secret '${DB_SECRET_NAME}' in namespace '${ns}'." >&2
    cat "$err_file" >&2
  fi
  rm -f "$err_file"
  return 1
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
    --set route.host="$DEPLOY_HOST" \
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

# Usage: wait_for_rollout <namespace>
wait_for_rollout() {
  local ns=$1
  oc -n "$ns" rollout status "deployment/${E2E_RELEASE}-frontend" --timeout=6m >/dev/null
  oc -n "$ns" rollout status "deployment/${E2E_RELEASE}-backend" --timeout=6m >/dev/null
}

# Usage: probe_readiness <host> <probe-token>
# Returns non-zero on failure.
probe_readiness() {
  local host=$1 probe_token=$2
  local code="" i=0
  while [ "$i" -lt 10 ]; do
    code=$(curl -ksS -H "x-ai-probe-token: $probe_token" \
      -o /dev/null -w '%{http_code}' \
      "https://$host/api/ai/probe?live=true" || true)
    if [ "$code" = "200" ]; then break; fi
    i=$((i + 1))
    sleep 2
  done
  if [ "$code" != "200" ]; then
    echo "Probe failed with status $code"
    curl -ksS -H "x-ai-probe-token: $probe_token" \
      "https://$host/api/ai/probe?live=true" || true
    echo
    return 1
  fi
}
