#!/usr/bin/env bash
# Shared helpers for cluster deployment Makefile targets.
# Platform-specific scripts set KUBE_CLI before sourcing this file.

KUBE_CLI="${KUBE_CLI:-kubectl}"

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

aoai_fetch_creds() {
  AOAI_ENDPOINT=$(az cognitiveservices account show \
    -g "$AOAI_RG" -n "$AOAI_ACCOUNT" \
    --query properties.endpoint -o tsv | sed 's:/*$::')
  AOAI_KEY=$(az cognitiveservices account keys list \
    -g "$AOAI_RG" -n "$AOAI_ACCOUNT" \
    --query key1 -o tsv)
}

ensure_namespace() {
  local ns=$1
  "$KUBE_CLI" get namespace "$ns" >/dev/null 2>&1 || \
    "$KUBE_CLI" create namespace "$ns" >/dev/null
}

create_or_update_aoai_secret() {
  local ns=$1
  "$KUBE_CLI" -n "$ns" create secret generic azure-openai-creds \
    --from-literal=endpoint="$AOAI_ENDPOINT" \
    --from-literal=api-key="$AOAI_KEY" \
    --dry-run=client -o yaml | "$KUBE_CLI" apply -f - >/dev/null
}

# Usage: copy_secret_across_namespaces <src_ns> <dst_ns> <secret_name>
# Re-applies the Secret in dst_ns from a live object in src_ns. Strips
# server-populated metadata with jq. Does not echo .data or stringData
# (stdout from apply is discarded).
copy_secret_across_namespaces() {
  local src_ns=$1 dst_ns=$2 secret_name=$3
  if [ "$src_ns" = "$dst_ns" ]; then
    if ! "$KUBE_CLI" -n "$src_ns" get "secret/$secret_name" >/dev/null 2>&1; then
      echo "error: secret '$secret_name' not found in namespace '$src_ns'" >&2
      return 1
    fi
    return 0
  fi
  if ! "$KUBE_CLI" -n "$src_ns" get "secret/$secret_name" >/dev/null 2>&1; then
    echo "error: secret '$secret_name' not found in namespace '$src_ns' (cannot copy into '$dst_ns')" >&2
    return 1
  fi
  if ! command -v jq >/dev/null 2>&1; then
    echo "error: jq is required to copy secret '$secret_name' from namespace '$src_ns' to '$dst_ns'" >&2
    return 1
  fi
  "$KUBE_CLI" -n "$src_ns" get "secret/$secret_name" -o json \
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
    | "$KUBE_CLI" -n "$dst_ns" apply -f - >/dev/null
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
  require_cli "$KUBE_CLI"
  local err_file
  err_file="$(mktemp "${TMPDIR:-/tmp}/sre-db-secret-check-XXXXXX")"
  if "$KUBE_CLI" -n "$ns" get "secret/${DB_SECRET_NAME}" >/dev/null 2>"$err_file"; then
    rm -f "$err_file"
    return 0
  fi
  if rg -Fq "secrets \"${DB_SECRET_NAME}\" not found" "$err_file" || \
     rg -Fq "secret \"${DB_SECRET_NAME}\" not found" "$err_file"; then
    echo "DB secret '${DB_SECRET_NAME}' was not found in namespace '${ns}'." >&2
    echo "Create or copy it before running a production deployment." >&2
  else
    echo "Failed to verify DB secret '${DB_SECRET_NAME}' in namespace '${ns}'." >&2
    sed -n '1,120p' "$err_file" >&2
  fi
  rm -f "$err_file"
  return 1
}

# Usage: wait_for_rollout <namespace>
wait_for_rollout() {
  local ns=$1
  "$KUBE_CLI" -n "$ns" rollout status "deployment/${E2E_RELEASE}-frontend" --timeout=6m >/dev/null
  "$KUBE_CLI" -n "$ns" rollout status "deployment/${E2E_RELEASE}-backend" --timeout=6m >/dev/null
}

# Usage: probe_readiness <scheme> <host> <probe-token>
# Returns non-zero on failure.
probe_readiness() {
  local scheme=$1 host=$2 probe_token=$3
  local code="" i=0
  while [ "$i" -lt 10 ]; do
    code=$(curl -ksS -H "x-ai-probe-token: $probe_token" \
      -o /dev/null -w '%{http_code}' \
      "${scheme}://${host}/api/ai/probe?live=true" || true)
    if [ "$code" = "200" ]; then break; fi
    i=$((i + 1))
    sleep 2
  done
  if [ "$code" != "200" ]; then
    echo "Probe failed with status $code"
    curl -ksS -H "x-ai-probe-token: $probe_token" \
      "${scheme}://${host}/api/ai/probe?live=true" || true
    echo
    return 1
  fi
}
