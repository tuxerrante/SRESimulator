#!/usr/bin/env bash
# Delete leftover ephemeral E2E namespaces and orphaned pool releases.
#
# Temporary namespaces are normally removed by the always() cleanup step of the
# job that created them. A cancelled run, an expired runner token or a cluster
# hiccup can still leave one behind, and those namespaces keep holding CPU and
# memory requests forever. This script reclaims them on a schedule.
#
# Safety model, in order of application:
#   1. Only namespaces whose name starts with an allow-listed prefix are ever
#      considered. Every prefix must itself start with the "sre-" project
#      prefix and be long enough that it cannot match unrelated namespaces.
#   2. Protected namespaces are removed from the candidate list afterwards, so
#      production and the Dependabot pool survive even if a prefix is widened
#      by mistake.
#   3. A candidate must be older than CLEANUP_MIN_AGE_HOURS, which is far above
#      the runtime of any job that creates one of these namespaces.
#   4. A namespace belonging to a pull request is skipped while that pull
#      request still has a workflow run in flight.
#   5. Nothing is deleted unless DRY_RUN is explicitly set to false.
set -euo pipefail

DRY_RUN="${DRY_RUN:-true}"
CLEANUP_MIN_AGE_HOURS="${CLEANUP_MIN_AGE_HOURS:-24}"
CLEANUP_NAMESPACE_PREFIXES="${CLEANUP_NAMESPACE_PREFIXES:-sre-pr- sre-manual-e2e-}"
POOL_NAMESPACE_PREFIX="${POOL_NAMESPACE_PREFIX:-sre-dependabot-e2e}"
CLAIM_NAME="${CLAIM_NAME:-dependabot-e2e-claim}"
PROD_NAMESPACE="${PROD_NAMESPACE:-sre-simulator}"
CLEANUP_EXTRA_PROTECTED="${CLEANUP_EXTRA_PROTECTED:-default kube-system kube-public kube-node-lease}"
# Namespaces are named sre-pr-<number> by the live E2E job.
PR_NAMESPACE_PREFIX="${PR_NAMESPACE_PREFIX:-sre-pr-}"
GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-}"

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require kubectl

if [[ "${DRY_RUN}" != "true" && "${DRY_RUN}" != "false" ]]; then
  echo "DRY_RUN must be 'true' or 'false', got '${DRY_RUN}'." >&2
  exit 1
fi

if ! [[ "${CLEANUP_MIN_AGE_HOURS}" =~ ^[0-9]+$ ]] ||
  [[ "${CLEANUP_MIN_AGE_HOURS}" -lt 1 ]]; then
  echo "CLEANUP_MIN_AGE_HOURS must be a positive integer." >&2
  exit 1
fi

read -r -a prefixes <<<"${CLEANUP_NAMESPACE_PREFIXES}"
if [[ "${#prefixes[@]}" -eq 0 ]]; then
  echo "CLEANUP_NAMESPACE_PREFIXES is empty, nothing to do." >&2
  exit 1
fi

# A short or unanchored prefix is the one mistake that could delete the whole
# cluster, so it is rejected before any namespace is listed.
for prefix in "${prefixes[@]}"; do
  if [[ "${prefix}" != sre-* ]]; then
    echo "Refusing prefix '${prefix}': must start with 'sre-'." >&2
    exit 1
  fi
  if [[ "${#prefix}" -lt 7 ]]; then
    echo "Refusing prefix '${prefix}': too short to be selective." >&2
    exit 1
  fi
done

protected=()
read -r -a protected <<<"${CLEANUP_EXTRA_PROTECTED}"
protected+=("${PROD_NAMESPACE}")

is_protected() {
  local namespace=$1 entry
  for entry in "${protected[@]}"; do
    [[ -n "${entry}" && "${namespace}" == "${entry}" ]] && return 0
  done
  # The pool namespaces are long lived infrastructure, never ephemeral.
  [[ "${namespace}" == "${POOL_NAMESPACE_PREFIX}"* ]] && return 0
  return 1
}

matches_prefix() {
  local namespace=$1 prefix
  for prefix in "${prefixes[@]}"; do
    [[ "${namespace}" == "${prefix}"* ]] && return 0
  done
  return 1
}

to_epoch() {
  local timestamp=$1 epoch
  # BSD date needs an explicit format; GNU date accepts -d.
  if ! epoch="$(date -u -d "${timestamp}" +%s 2>/dev/null)"; then
    if ! epoch="$(
      date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "${timestamp}" +%s 2>/dev/null
    )"; then
      echo ""
      return 0
    fi
  fi
  echo "${epoch}"
}

age_hours() {
  local timestamp=$1 epoch now
  epoch="$(to_epoch "${timestamp}")"
  if [[ -z "${epoch}" ]]; then
    echo ""
    return 0
  fi
  now="$(date -u +%s)"
  if [[ "${epoch}" -gt "${now}" ]]; then
    echo 0
    return 0
  fi
  echo $(((now - epoch) / 3600))
}

# A pull request namespace is only safe to remove once no workflow run for that
# pull request can still be using it. Without gh the age threshold is the only
# guard, which is why it defaults well above the 60 minute job timeout.
pr_run_active() {
  local pr_number=$1 active
  [[ -z "${GITHUB_REPOSITORY}" ]] && return 1
  command -v gh >/dev/null 2>&1 || return 1
  active="$(
    gh api "repos/${GITHUB_REPOSITORY}/pulls/${pr_number}" \
      --jq '.head.sha' 2>/dev/null || true
  )"
  [[ -z "${active}" ]] && return 1
  active="$(
    gh api "repos/${GITHUB_REPOSITORY}/actions/runs?head_sha=${active}" \
      --jq '[.workflow_runs[] | select(.status != "completed")] | length' \
      2>/dev/null || echo 0
  )"
  [[ "${active}" =~ ^[0-9]+$ ]] && [[ "${active}" -gt 0 ]]
}

echo "==> E2E namespace cleanup (dry-run: ${DRY_RUN})"
echo "    prefixes:      ${prefixes[*]}"
echo "    min age:       ${CLEANUP_MIN_AGE_HOURS}h"
echo "    protected:     ${protected[*]} ${POOL_NAMESPACE_PREFIX}*"

namespaces="$(
  kubectl get namespaces \
    -o go-template='{{range .items}}{{.metadata.name}} {{.metadata.creationTimestamp}}{{"\n"}}{{end}}'
)"

deleted=0
skipped=0

while read -r namespace created; do
  [[ -z "${namespace}" ]] && continue
  matches_prefix "${namespace}" || continue

  if is_protected "${namespace}"; then
    echo "    keep   ${namespace}: protected"
    skipped=$((skipped + 1))
    continue
  fi

  age="$(age_hours "${created}")"
  if [[ -z "${age}" ]]; then
    echo "    keep   ${namespace}: unreadable creation timestamp '${created}'"
    skipped=$((skipped + 1))
    continue
  fi

  if [[ "${age}" -lt "${CLEANUP_MIN_AGE_HOURS}" ]]; then
    echo "    keep   ${namespace}: age ${age}h below threshold"
    skipped=$((skipped + 1))
    continue
  fi

  if [[ "${namespace}" == "${PR_NAMESPACE_PREFIX}"* ]]; then
    pr_number="${namespace#"${PR_NAMESPACE_PREFIX}"}"
    if [[ "${pr_number}" =~ ^[0-9]+$ ]] && pr_run_active "${pr_number}"; then
      echo "    keep   ${namespace}: pull request ${pr_number} still has a run in flight"
      skipped=$((skipped + 1))
      continue
    fi
  fi

  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "    would delete ${namespace}: age ${age}h"
  else
    echo "    delete ${namespace}: age ${age}h"
    kubectl delete namespace "${namespace}" --wait=false >/dev/null
  fi
  deleted=$((deleted + 1))
done <<<"${namespaces}"

# An orphaned release inside a pool namespace is the other way capacity leaks:
# the claim was released but the helm uninstall did not complete. Without a
# claim no run owns the namespace, so leftover workloads are safe to remove.
released=0
if command -v helm >/dev/null 2>&1; then
  while read -r namespace _; do
    [[ -z "${namespace}" ]] && continue
    [[ "${namespace}" == "${POOL_NAMESPACE_PREFIX}"* ]] || continue

    if kubectl -n "${namespace}" get "configmap/${CLAIM_NAME}" \
      >/dev/null 2>&1; then
      echo "    keep   ${namespace}: claimed"
      continue
    fi

    while read -r release; do
      [[ -z "${release}" ]] && continue
      if [[ "${DRY_RUN}" == "true" ]]; then
        echo "    would uninstall ${release} in ${namespace}: unclaimed"
      else
        echo "    uninstall ${release} in ${namespace}: unclaimed"
        helm uninstall "${release}" -n "${namespace}" --wait >/dev/null 2>&1 ||
          echo "    warn   could not uninstall ${release} in ${namespace}" >&2
      fi
      released=$((released + 1))
    done < <(
      helm list -n "${namespace}" -q 2>/dev/null || true
    )
  done <<<"${namespaces}"
fi

if [[ "${DRY_RUN}" == "true" ]]; then
  echo "==> Dry run: ${deleted} namespace(s) and ${released} release(s) would be removed, ${skipped} kept."
else
  echo "==> Removed ${deleted} namespace(s) and ${released} release(s), kept ${skipped}."
fi
