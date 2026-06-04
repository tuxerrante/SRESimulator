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
  if grep -Fq "secrets \"${DB_SECRET_NAME}\" not found" "$err_file" || \
     grep -Fq "secret \"${DB_SECRET_NAME}\" not found" "$err_file"; then
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
  if [ "${CLUSTER_FLAVOR:-}" = "aks" ] && [ "${AKS_EXPOSURE_MODE:-gateway}" = "gateway" ]; then
    wait_for_gateway_ready "$ns" "${E2E_RELEASE}"
    wait_for_certificate_ready "$ns" "${AKS_GATEWAY_TLS_SECRET_NAME:-sre-simulator-gateway-tls}"
  fi
}

gateway_wait_append_requirement() {
  local requirement=$1
  if [ -n "${GATEWAY_WAIT_PENDING:-}" ]; then
    GATEWAY_WAIT_PENDING="${GATEWAY_WAIT_PENDING}; ${requirement}"
  else
    GATEWAY_WAIT_PENDING="${requirement}"
  fi
}

gateway_wait_compact_error() {
  local err_file=$1
  sed -n '1,20p' "$err_file" 2>/dev/null \
    | tr '\n' ' ' \
    | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//'
}

gateway_wait_read_jsonpath() {
  local ns=$1 gateway_name=$2 query=$3 err_file=$4 output

  if ! output="$("$KUBE_CLI" -n "$ns" get "gateway/${gateway_name}" -o "jsonpath=${query}" 2>"$err_file")"; then
    return 1
  fi

  printf '%s' "$output"
}

gateway_wait_lookup_condition() {
  local conditions=$1 target_type=$2 line condition_type condition_fields

  GATEWAY_WAIT_CONDITION_STATUS=""
  GATEWAY_WAIT_CONDITION_OBSERVED=""

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    condition_type=${line%%=*}
    condition_fields=${line#*=}
    if [ "$condition_type" = "$target_type" ]; then
      GATEWAY_WAIT_CONDITION_STATUS=${condition_fields%%:*}
      GATEWAY_WAIT_CONDITION_OBSERVED=${condition_fields#*:}
      return 0
    fi
  done <<<"$conditions"

  return 1
}

gateway_wait_lookup_csv_condition() {
  local conditions_csv=$1 target_type=$2 entry condition_type condition_fields
  local old_ifs=$IFS

  GATEWAY_WAIT_CONDITION_STATUS=""
  GATEWAY_WAIT_CONDITION_OBSERVED=""
  IFS=','
  for entry in $conditions_csv; do
    [ -n "$entry" ] || continue
    condition_type=${entry%%=*}
    condition_fields=${entry#*=}
    if [ "$condition_type" = "$target_type" ]; then
      GATEWAY_WAIT_CONDITION_STATUS=${condition_fields%%:*}
      GATEWAY_WAIT_CONDITION_OBSERVED=${condition_fields#*:}
      IFS=$old_ifs
      return 0
    fi
  done
  IFS=$old_ifs

  return 1
}

gateway_wait_require_condition() {
  local scope=$1 source=$2 generation=$3 target_type=$4 source_kind=$5
  local found_condition=1

  if [ "$source_kind" = "csv" ]; then
    gateway_wait_lookup_csv_condition "$source" "$target_type" || found_condition=0
  else
    gateway_wait_lookup_condition "$source" "$target_type" || found_condition=0
  fi

  if [ "$found_condition" -eq 1 ] && \
     [ "$GATEWAY_WAIT_CONDITION_STATUS" = "True" ] && \
     [ "$GATEWAY_WAIT_CONDITION_OBSERVED" = "$generation" ]; then
    return 0
  fi

  if [ "$found_condition" -eq 1 ] && \
     [ -n "$GATEWAY_WAIT_CONDITION_OBSERVED" ] && \
     [ "$GATEWAY_WAIT_CONDITION_OBSERVED" != "$generation" ]; then
    GATEWAY_WAIT_STALE=1
  fi

  gateway_wait_append_requirement \
    "${scope} ${target_type}=True@${generation} (actual: ${GATEWAY_WAIT_CONDITION_STATUS:-<missing>}@${GATEWAY_WAIT_CONDITION_OBSERVED:-<missing>})"
  return 1
}

gateway_wait_evaluate_status() {
  local generation=$1 gateway_conditions=$2 listener_conditions=$3
  local listener_line listener_name listener_condition_csv saw_listener_status=0

  GATEWAY_WAIT_PENDING=""
  GATEWAY_WAIT_STALE=0

  gateway_wait_require_condition "gateway" "$gateway_conditions" "$generation" "Accepted" "lines" || true
  gateway_wait_require_condition "gateway" "$gateway_conditions" "$generation" "Programmed" "lines" || true

  while IFS='|' read -r listener_name listener_condition_csv; do
    [ -n "$listener_name" ] || continue
    saw_listener_status=1
    gateway_wait_require_condition "listener '${listener_name}'" "$listener_condition_csv" "$generation" "Accepted" "csv" || true
    gateway_wait_require_condition "listener '${listener_name}'" "$listener_condition_csv" "$generation" "Programmed" "csv" || true
    gateway_wait_require_condition "listener '${listener_name}'" "$listener_condition_csv" "$generation" "ResolvedRefs" "csv" || true
  done <<<"$listener_conditions"

  if [ "$saw_listener_status" -ne 1 ]; then
    gateway_wait_append_requirement "listener status entries at generation ${generation}"
  fi

  [ -z "$GATEWAY_WAIT_PENDING" ]
}

# Usage: wait_for_gateway_ready <namespace> <gateway-name>
wait_for_gateway_ready() {
  local ns=$1 gateway_name=$2
  local err_file gateway_conditions="" generation="" i=0 listener_conditions="" poll_seconds total_seconds
  local max_polls="${WAIT_FOR_GATEWAY_READY_MAX_POLLS:-72}"

  poll_seconds="${WAIT_FOR_GATEWAY_READY_POLL_SECONDS:-5}"
  total_seconds=$((max_polls * poll_seconds))
  err_file="$(mktemp "${TMPDIR:-/tmp}/sre-gateway-ready-XXXXXX")"

  while [ "$i" -lt "$max_polls" ]; do
    if ! generation="$(gateway_wait_read_jsonpath "$ns" "$gateway_name" '{.metadata.generation}' "$err_file")"; then
      echo "Gateway '${gateway_name}' in namespace '${ns}' could not be fetched: $(gateway_wait_compact_error "$err_file")" >&2
      rm -f "$err_file"
      return 1
    fi

    if ! gateway_conditions="$(gateway_wait_read_jsonpath "$ns" "$gateway_name" '{range .status.conditions[*]}{.type}={.status}:{.observedGeneration}{"\n"}{end}' "$err_file")"; then
      echo "Gateway '${gateway_name}' in namespace '${ns}' could not be fetched: $(gateway_wait_compact_error "$err_file")" >&2
      rm -f "$err_file"
      return 1
    fi

    if ! listener_conditions="$(gateway_wait_read_jsonpath "$ns" "$gateway_name" '{range .status.listeners[*]}{.name}{"|"}{range .conditions[*]}{.type}={.status}:{.observedGeneration}{","}{end}{"\n"}{end}' "$err_file")"; then
      echo "Gateway '${gateway_name}' in namespace '${ns}' could not be fetched: $(gateway_wait_compact_error "$err_file")" >&2
      rm -f "$err_file"
      return 1
    fi

    if gateway_wait_evaluate_status "$generation" "$gateway_conditions" "$listener_conditions"; then
      rm -f "$err_file"
      return 0
    fi

    i=$((i + 1))
    sleep "$poll_seconds"
  done

  echo "Gateway '${gateway_name}' in namespace '${ns}' did not become ready within ${total_seconds} seconds." >&2
  if [ "${GATEWAY_WAIT_STALE:-0}" -eq 1 ]; then
    echo "Gateway '${gateway_name}' status is stale: observedGeneration does not match metadata.generation." >&2
  fi
  if [ -n "${GATEWAY_WAIT_PENDING:-}" ]; then
    echo "Still waiting on: ${GATEWAY_WAIT_PENDING}" >&2
  fi
  "$KUBE_CLI" -n "$ns" get "gateway/${gateway_name}" -o yaml >&2 || true
  rm -f "$err_file"
  return 1
}

# Usage: wait_for_certificate_ready <namespace> <tls-secret-name>
wait_for_certificate_ready() {
  local ns=$1 secret_name=$2
  local certificate_list="" certificate_name="" certificate_entry="" certificate_secret=""
  local err_file i=0 poll_seconds total_seconds
  local max_polls="${WAIT_FOR_CERTIFICATE_READY_MAX_POLLS:-72}"
  local wait_timeout="${WAIT_FOR_CERTIFICATE_READY_WAIT_TIMEOUT:-10m}"

  poll_seconds="${WAIT_FOR_CERTIFICATE_READY_POLL_SECONDS:-5}"
  total_seconds=$((max_polls * poll_seconds))
  err_file="$(mktemp "${TMPDIR:-/tmp}/sre-certificate-ready-XXXXXX")"

  while [ "$i" -lt "$max_polls" ]; do
    if ! certificate_list="$("$KUBE_CLI" -n "$ns" get certificate -o jsonpath='{range .items[*]}{.metadata.name}{"|"}{.spec.secretName}{"\n"}{end}' 2>"$err_file")"; then
      echo "Certificates in namespace '${ns}' could not be fetched: $(gateway_wait_compact_error "$err_file")" >&2
      rm -f "$err_file"
      return 1
    fi

    certificate_name=""
    for certificate_entry in $certificate_list; do
      certificate_secret=${certificate_entry#*|}
      if [ "$certificate_secret" = "$secret_name" ]; then
        certificate_name=${certificate_entry%%|*}
        break
      fi
    done

    if [ -n "$certificate_name" ]; then
      break
    fi

    i=$((i + 1))
    sleep "$poll_seconds"
  done

  if [ -z "$certificate_name" ]; then
    echo "Certificate for TLS secret '${secret_name}' in namespace '${ns}' was not created within ${total_seconds} seconds." >&2
    rm -f "$err_file"
    return 1
  fi

  if ! "$KUBE_CLI" -n "$ns" wait --for=jsonpath='{.status.conditions[?(@.type=="Ready")].status}'=True \
    "certificate/${certificate_name}" --timeout="$wait_timeout" >/dev/null 2>"$err_file"; then
    echo "Certificate '${certificate_name}' in namespace '${ns}' did not become Ready: $(gateway_wait_compact_error "$err_file")" >&2
    "$KUBE_CLI" -n "$ns" get "certificate/${certificate_name}" -o yaml >&2 || true
    rm -f "$err_file"
    return 1
  fi

  rm -f "$err_file"
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
