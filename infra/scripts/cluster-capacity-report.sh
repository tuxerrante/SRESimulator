#!/usr/bin/env bash
# Read-only capacity report for the shared AKS cluster.
#
# The number that matters for this repository is not how busy the nodes look,
# it is how much *schedulable* room is left, because every end-to-end namespace
# has to fit in what pod requests have not already reserved. A node can sit at
# 60% memory and still have plenty of room, and it can sit at 10% CPU while
# being unable to schedule a single extra pod. This script reports the second
# number and fails when it gets too small, so the cluster running out of room
# is noticed before a pull request sees an unschedulable pod.
#
# It only reads. It never deletes, patches or scales anything.
set -euo pipefail

MIN_FREE_CPU_PERCENT="${MIN_FREE_CPU_PERCENT:-15}"
MIN_FREE_MEMORY_PERCENT="${MIN_FREE_MEMORY_PERCENT:-15}"
# One end-to-end release is a frontend (2 replicas) and a backend (1 replica),
# each container requesting 100m / 128Mi in helm/sre-simulator/values.yaml.
E2E_POD_CPU_M="${E2E_POD_CPU_M:-100}"
E2E_POD_MEMORY_MI="${E2E_POD_MEMORY_MI:-128}"
E2E_PODS_PER_NAMESPACE="${E2E_PODS_PER_NAMESPACE:-3}"
STRICT="${STRICT:-true}"

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

require kubectl
require jq

for value in MIN_FREE_CPU_PERCENT MIN_FREE_MEMORY_PERCENT E2E_POD_CPU_M \
  E2E_POD_MEMORY_MI E2E_PODS_PER_NAMESPACE; do
  if ! [[ "${!value}" =~ ^[0-9]+$ ]]; then
    echo "${value} must be a non-negative integer, got '${!value}'" >&2
    exit 1
  fi
done

if [[ "${E2E_PODS_PER_NAMESPACE}" -lt 1 ]]; then
  echo "E2E_PODS_PER_NAMESPACE must be at least 1" >&2
  exit 1
fi

# Kubernetes quantities are not plain numbers, and getting the units wrong here
# would quietly turn the whole report into fiction, so both scales are parsed
# explicitly rather than by stripping suffixes.
# shellcheck disable=SC2016  # $-prefixed names below are jq variables, not
# shell ones, so this block must stay unexpanded.
JQ_UNITS='
def cpum:
  if . == null then 0
  elif type == "number" then . * 1000
  elif test("m$") then (rtrimstr("m") | tonumber)
  else (tonumber * 1000) end;
def memmi:
  if . == null then 0
  elif type == "number" then . / 1048576
  elif test("Ki$") then (rtrimstr("Ki") | tonumber) / 1024
  elif test("Mi$") then (rtrimstr("Mi") | tonumber)
  elif test("Gi$") then (rtrimstr("Gi") | tonumber) * 1024
  elif test("Ti$") then (rtrimstr("Ti") | tonumber) * 1048576
  elif test("^[0-9]+$") then (tonumber) / 1048576
  else 0 end;
# The effective request of a pod is not the sum of every container: init
# containers run before the others, so the scheduler reserves the larger of
# the init peak and the regular containers total.
def podcpu:
  ((([.spec.containers[]?.resources.requests.cpu] | map(cpum) | add) // 0) as $main
   | (([.spec.initContainers[]?.resources.requests.cpu] | map(cpum) | max) // 0) as $init
   | if $init > $main then $init else $main end);
def podmem:
  ((([.spec.containers[]?.resources.requests.memory] | map(memmi) | add) // 0) as $main
   | (([.spec.initContainers[]?.resources.requests.memory] | map(memmi) | max) // 0) as $init
   | if $init > $main then $init else $main end);
'

# The pod list is far too large to pass through a command line argument, so
# both payloads go to temporary files and are slurped by jq instead.
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT
kubectl get nodes -o json >"${WORK_DIR}/nodes.json"
# Only pods that are actually bound to a node hold a reservation on it.
# Succeeded and Failed pods keep their spec but release their resources.
kubectl get pods --all-namespaces -o json >"${WORK_DIR}/pods.json"

report="$(
  jq -r -n \
    --slurpfile nodes "${WORK_DIR}/nodes.json" \
    --slurpfile pods "${WORK_DIR}/pods.json" \
    "${JQ_UNITS}"'
    ($pods[0].items
      | map(select(.spec.nodeName != null
                   and (.status.phase == "Running" or .status.phase == "Pending")))
    ) as $active
    | $nodes[0].items[]
    | .metadata.name as $node
    | (.status.allocatable.cpu | cpum) as $acpu
    | (.status.allocatable.memory | memmi) as $amem
    | ($active | map(select(.spec.nodeName == $node))) as $on
    | (($on | map(podcpu) | add) // 0) as $rcpu
    | (($on | map(podmem) | add) // 0) as $rmem
    | [$node, ($acpu | floor), ($rcpu | floor), ($amem | floor), ($rmem | floor), ($on | length)]
    | @tsv
  '
)"

echo "==> Cluster capacity report"
echo "    thresholds: free CPU >= ${MIN_FREE_CPU_PERCENT}%, free memory >= ${MIN_FREE_MEMORY_PERCENT}%"
echo
printf '    %-34s %14s %14s %6s\n' NODE CPU MEMORY PODS

total_cpu=0
total_cpu_req=0
total_mem=0
total_mem_req=0
e2e_slots=0

while IFS=$'\t' read -r node acpu rcpu amem rmem pods; do
  [[ -z "${node}" ]] && continue
  cpu_pct=0
  mem_pct=0
  [[ "${acpu}" -gt 0 ]] && cpu_pct=$((rcpu * 100 / acpu))
  [[ "${amem}" -gt 0 ]] && mem_pct=$((rmem * 100 / amem))
  printf '    %-34s %6dm/%5dm %5dMi/%5dMi %6d\n' \
    "${node}" "${rcpu}" "${acpu}" "${rmem}" "${amem}" "${pods}"
  printf '    %-34s %13s%% %13s%%\n' "" "${cpu_pct}" "${mem_pct}"

  total_cpu=$((total_cpu + acpu))
  total_cpu_req=$((total_cpu_req + rcpu))
  total_mem=$((total_mem + amem))
  total_mem_req=$((total_mem_req + rmem))

  # A namespace's pods are scheduled one by one, so free capacity only counts
  # when a whole pod fits on a single node. Summing free capacity across nodes
  # would overstate the room by ignoring fragmentation.
  free_cpu=$((acpu - rcpu))
  free_mem=$((amem - rmem))
  cpu_pods=0
  mem_pods=0
  [[ "${E2E_POD_CPU_M}" -gt 0 ]] && cpu_pods=$((free_cpu / E2E_POD_CPU_M))
  [[ "${E2E_POD_MEMORY_MI}" -gt 0 ]] && mem_pods=$((free_mem / E2E_POD_MEMORY_MI))
  [[ "${cpu_pods}" -lt 0 ]] && cpu_pods=0
  [[ "${mem_pods}" -lt 0 ]] && mem_pods=0
  fit=$((cpu_pods < mem_pods ? cpu_pods : mem_pods))
  e2e_slots=$((e2e_slots + fit))
done <<<"${report}"

free_cpu_pct=0
free_mem_pct=0
[[ "${total_cpu}" -gt 0 ]] && free_cpu_pct=$(((total_cpu - total_cpu_req) * 100 / total_cpu))
[[ "${total_mem}" -gt 0 ]] && free_mem_pct=$(((total_mem - total_mem_req) * 100 / total_mem))
e2e_namespaces=$((e2e_slots / E2E_PODS_PER_NAMESPACE))

echo
echo "    schedulable headroom: CPU ${free_cpu_pct}%, memory ${free_mem_pct}%"
echo "    room for about ${e2e_namespaces} more end-to-end namespace(s)"

# Requests are what the scheduler reserves; usage is what is really consumed.
# A large gap is not an error, but it is the cheapest capacity to reclaim, so
# it is worth surfacing before anyone concludes the cluster needs more nodes.
echo
echo "==> Requested vs actually used, by namespace"
if usage="$(kubectl top pods --all-namespaces --no-headers 2>/dev/null)" && [[ -n "${usage}" ]]; then
  requests="$(
    jq -r -n --slurpfile pods "${WORK_DIR}/pods.json" "${JQ_UNITS}"'
      $pods[0].items
      | map(select(.spec.nodeName != null
                   and (.status.phase == "Running" or .status.phase == "Pending")))
      | group_by(.metadata.namespace)[]
      | [.[0].metadata.namespace, ((map(podcpu) | add) // 0 | floor),
         ((map(podmem) | add) // 0 | floor)]
      | @tsv
    '
  )"
  printf '    %-26s %10s %10s %10s %10s\n' NAMESPACE CPU_REQ CPU_USED MEM_REQ MEM_USED
  while IFS=$'\t' read -r ns rcpu rmem; do
    [[ -z "${ns}" ]] && continue
    used="$(awk -v ns="${ns}" '$1 == ns {
      cpu = $3; mem = $4; sub("m", "", cpu); sub("Mi", "", mem);
      c += cpu; m += mem
    } END { printf "%d %d", c, m }' <<<"${usage}")"
    printf '    %-26s %9dm %9sm %9dMi %8sMi\n' \
      "${ns}" "${rcpu}" "${used%% *}" "${rmem}" "${used##* }"
  done <<<"${requests}"
else
  echo "    warn   metrics unavailable, skipping usage comparison" >&2
fi

status=0
if [[ "${free_cpu_pct}" -lt "${MIN_FREE_CPU_PERCENT}" ]]; then
  echo "    FAIL   schedulable CPU headroom ${free_cpu_pct}% is below ${MIN_FREE_CPU_PERCENT}%" >&2
  status=1
fi
if [[ "${free_mem_pct}" -lt "${MIN_FREE_MEMORY_PERCENT}" ]]; then
  echo "    FAIL   schedulable memory headroom ${free_mem_pct}% is below ${MIN_FREE_MEMORY_PERCENT}%" >&2
  status=1
fi

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### Cluster capacity"
    echo
    echo "| metric | value |"
    echo "| --- | --- |"
    echo "| schedulable CPU headroom | ${free_cpu_pct}% |"
    echo "| schedulable memory headroom | ${free_mem_pct}% |"
    echo "| room for E2E namespaces | ~${e2e_namespaces} |"
  } >>"${GITHUB_STEP_SUMMARY}"
fi

if [[ "${status}" -ne 0 && "${STRICT}" != "true" ]]; then
  echo "    warn   thresholds breached but STRICT is not 'true', reporting only" >&2
  status=0
fi

exit "${status}"
