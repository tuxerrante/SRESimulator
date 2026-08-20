#!/usr/bin/env bash
# Claim and release a dedicated Dependabot E2E namespace.
#
# Dependabot E2E used to deploy into one fixed namespace guarded by a single
# global Actions concurrency group. GitHub keeps only one pending run per
# group, so simultaneous Dependabot pull requests evicted each other and the
# ci-gate wait expired without ever seeing a dependabot-e2e status.
#
# The namespaces are pre-provisioned by infra/scripts/dependabot-e2e-pool.sh
# rather than created on demand, because creating a namespace needs
# cluster-scoped RBAC and granting the namespaced verbs would require a
# ClusterRoleBinding that also reaches the production namespace. A fixed pool
# keeps the namespace-only identity intact and caps how much of the cluster
# Dependabot can consume at once.
set -euo pipefail

CLAIM_NAME="${CLAIM_NAME:-dependabot-e2e-claim}"
RUNTIME_SECRET_NAME="${RUNTIME_SECRET_NAME:-dependabot-e2e-runtime}"
CLAIM_STALE_MINUTES="${CLAIM_STALE_MINUTES:-45}"
CLAIM_WAIT_SECONDS="${CLAIM_WAIT_SECONDS:-1800}"
CLAIM_POLL_SECONDS="${CLAIM_POLL_SECONDS:-15}"

usage() {
  cat >&2 <<'EOF'
Usage:
  dependabot-e2e-namespace.sh claim  <pr-number> <run-id>
  dependabot-e2e-namespace.sh release <namespace> [release-name]

Environment:
  DEPENDABOT_E2E_NAMESPACE_POOL  space-separated namespaces (required for claim)
  CLAIM_STALE_MINUTES            reclaim age for abandoned claims (default 45)
  CLAIM_WAIT_SECONDS             total time to wait for a free slot (default 1800)
EOF
  exit 2
}

log() {
  echo "[dependabot-e2e-namespace] $*" >&2
}

claim_age_minutes() {
  local namespace=$1 created created_epoch age_seconds now
  created="$(
    kubectl -n "${namespace}" get "configmap/${CLAIM_NAME}" \
      -o jsonpath='{.metadata.creationTimestamp}' 2>/dev/null || true
  )"
  if [[ -z "${created}" ]]; then
    echo ""
    return 0
  fi
  # BSD date needs an explicit format; GNU date accepts -d.
  if ! created_epoch="$(date -u -d "${created}" +%s 2>/dev/null)"; then
    if ! created_epoch="$(
      date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "${created}" +%s 2>/dev/null
    )"; then
      echo ""
      return 0
    fi
  fi
  now="$(date -u +%s)"
  age_seconds=$((now - created_epoch))
  if [[ "${age_seconds}" -lt 0 ]]; then
    age_seconds=0
  fi
  echo $((age_seconds / 60))
}

create_claim() {
  local namespace=$1 pr_number=$2 run_id=$3
  kubectl -n "${namespace}" create configmap "${CLAIM_NAME}" \
    --from-literal=pr="${pr_number}" \
    --from-literal=run-id="${run_id}" \
    >/dev/null 2>&1
}

try_claim_namespace() {
  local namespace=$1 pr_number=$2 run_id=$3 age

  if create_claim "${namespace}" "${pr_number}" "${run_id}"; then
    return 0
  fi

  # Do not parse the kubectl error text: the wording differs between kubectl
  # versions and the API server, and kubectl exits 1 for every failure. Decide
  # on observable state instead. A lost race is the only case where the claim
  # exists right after our create failed.
  age="$(claim_age_minutes "${namespace}")"

  if [[ -z "${age}" ]]; then
    # No claim is visible, so this was not a lost race. It is either a claim
    # released in the microseconds since our create, or a real problem such as
    # a missing configmap grant. Retry once to tell the two apart.
    if create_claim "${namespace}" "${pr_number}" "${run_id}"; then
      return 0
    fi
    age="$(claim_age_minutes "${namespace}")"
    if [[ -z "${age}" ]]; then
      log "cannot claim ${namespace}: create failed and no claim is readable."
      log "check that the identity may create and get configmaps there:"
      kubectl -n "${namespace}" create configmap "${CLAIM_NAME}" \
        --from-literal=pr="${pr_number}" \
        --from-literal=run-id="${run_id}" >/dev/null || true
      exit 1
    fi
  fi

  if [[ "${age}" -lt "${CLAIM_STALE_MINUTES}" ]]; then
    return 1
  fi

  log "reclaiming ${namespace}: claim is ${age}m old (stale after ${CLAIM_STALE_MINUTES}m)"
  release_namespace "${namespace}" "${RELEASE_NAME:-sre-dependabot-e2e}"
  create_claim "${namespace}" "${pr_number}" "${run_id}"
}

claim() {
  local pr_number=$1 run_id=$2 namespace deadline

  if [[ -z "${DEPENDABOT_E2E_NAMESPACE_POOL:-}" ]]; then
    log "DEPENDABOT_E2E_NAMESPACE_POOL is empty."
    exit 1
  fi

  deadline=$(( $(date -u +%s) + CLAIM_WAIT_SECONDS ))
  while true; do
    for namespace in ${DEPENDABOT_E2E_NAMESPACE_POOL}; do
      if try_claim_namespace "${namespace}" "${pr_number}" "${run_id}"; then
        log "claimed ${namespace} for PR ${pr_number}"
        echo "${namespace}"
        return 0
      fi
    done

    if [[ "$(date -u +%s)" -ge "${deadline}" ]]; then
      log "no free namespace in pool after ${CLAIM_WAIT_SECONDS}s: ${DEPENDABOT_E2E_NAMESPACE_POOL}"
      exit 1
    fi
    log "pool busy, retrying in ${CLAIM_POLL_SECONDS}s"
    sleep "${CLAIM_POLL_SECONDS}"
  done
}

release_namespace() {
  local namespace=$1 release_name=$2
  helm uninstall "${release_name}" --namespace "${namespace}" \
    >/dev/null 2>&1 || true
  kubectl -n "${namespace}" delete secret "${RUNTIME_SECRET_NAME}" \
    --ignore-not-found >/dev/null 2>&1 || true
  kubectl -n "${namespace}" delete "configmap/${CLAIM_NAME}" \
    --ignore-not-found >/dev/null 2>&1 || true
}

main() {
  local command=${1:-}
  case "${command}" in
    claim)
      [[ $# -eq 3 ]] || usage
      claim "$2" "$3"
      ;;
    release)
      [[ $# -ge 2 ]] || usage
      release_namespace "$2" "${3:-sre-dependabot-e2e}"
      log "released $2"
      ;;
    *)
      usage
      ;;
  esac
}

main "$@"
