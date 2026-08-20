#!/usr/bin/env bash
# Unit tests for infra/scripts/cluster-capacity-report.sh.
#
# The script is only useful if its arithmetic is right, so the fixtures below
# use values whose expected result can be worked out by hand, and every
# assertion checks a number rather than just that the script exited zero.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/cluster-capacity-report.sh"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
mkdir -p "$WORK_DIR/bin"
PATH="$WORK_DIR/bin:$PATH"
export PATH

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_contains() {
  grep -qF "$1" "$2" || fail "expected '$1' in output:
$(cat "$2")"
}

refute_contains() {
  grep -qF "$1" "$2" && fail "did not expect '$1' in output:
$(cat "$2")"
  return 0
}

# Two nodes of 1000m / 1024Mi allocatable. Node A carries a pod requesting
# 500m / 512Mi, node B carries nothing schedulable. So cluster requests are
# 500m of 2000m and 512Mi of 2048Mi, which is exactly 75% free on both axes.
write_fixtures() {
  cat >"$WORK_DIR/nodes.json" <<'JSON'
{"items":[
 {"metadata":{"name":"node-a"},"status":{"allocatable":{"cpu":"1000m","memory":"1048576Ki"}}},
 {"metadata":{"name":"node-b"},"status":{"allocatable":{"cpu":"1","memory":"1Gi"}}}
]}
JSON
  cat >"$WORK_DIR/pods.json" <<'JSON'
{"items":[
 {"metadata":{"name":"busy","namespace":"team-a"},
  "spec":{"nodeName":"node-a","containers":[
    {"resources":{"requests":{"cpu":"200m","memory":"256Mi"}}},
    {"resources":{"requests":{"cpu":"300m","memory":"256Mi"}}}]},
  "status":{"phase":"Running"}},
 {"metadata":{"name":"finished","namespace":"team-a"},
  "spec":{"nodeName":"node-b","containers":[
    {"resources":{"requests":{"cpu":"900m","memory":"900Mi"}}}]},
  "status":{"phase":"Succeeded"}},
 {"metadata":{"name":"unscheduled","namespace":"team-b"},
  "spec":{"containers":[
    {"resources":{"requests":{"cpu":"900m","memory":"900Mi"}}}]},
  "status":{"phase":"Pending"}}
]}
JSON
}

write_kubectl() {
  cat >"$WORK_DIR/bin/kubectl" <<STUB
#!/usr/bin/env bash
case "\$*" in
  *"get nodes"*) cat "$WORK_DIR/nodes.json" ;;
  *"get pods --all-namespaces -o json"*) cat "$WORK_DIR/pods.json" ;;
  *"top pods"*) [[ "\${TOP_FAIL:-0}" == "1" ]] && exit 1; cat "$WORK_DIR/top.txt" ;;
  *) exit 1 ;;
esac
exit 0
STUB
  chmod +x "$WORK_DIR/bin/kubectl"
}

write_fixtures
write_kubectl
printf 'team-a busy 5m 100Mi\n' >"$WORK_DIR/top.txt"

run_report() {
  ( cd "$WORK_DIR" && env "$@" bash "$SCRIPT" ) >"$WORK_DIR/out.txt" 2>&1
}

# --- headroom arithmetic ---------------------------------------------------
run_report E2E_POD_CPU_M=100 E2E_POD_MEMORY_MI=128 || fail "report failed: $(cat "$WORK_DIR/out.txt")"
assert_contains "schedulable headroom: CPU 75%, memory 75%" "$WORK_DIR/out.txt"

# Units must be honoured: 1048576Ki and 1Gi are both 1024Mi, and "1" cpu is
# 1000m. If any of those were parsed by stripping the suffix the two nodes
# would not report identical allocatable figures.
assert_contains "0m/ 1000m     0Mi/ 1024Mi" "$WORK_DIR/out.txt"

# Completed pods and pods with no node must not consume capacity. Both fixture
# pods above request 900m, so counting either one would break the 75% result.
assert_contains "500m/ 1000m" "$WORK_DIR/out.txt"

# --- pod-level fit, not summed free capacity -------------------------------
# Node A has 500m free, node B has 1000m free. A pod needing 600m fits only on
# node B, so exactly 1 pod fits even though 1500m is free in total.
run_report E2E_POD_CPU_M=600 E2E_POD_MEMORY_MI=1 E2E_PODS_PER_NAMESPACE=1 \
  || fail "report failed: $(cat "$WORK_DIR/out.txt")"
assert_contains "room for about 1 more end-to-end namespace" "$WORK_DIR/out.txt"

# --- init containers take the peak, not the sum ----------------------------
cat >"$WORK_DIR/pods.json" <<'JSON'
{"items":[
 {"metadata":{"name":"withinit","namespace":"team-a"},
  "spec":{"nodeName":"node-a",
    "initContainers":[{"resources":{"requests":{"cpu":"400m","memory":"64Mi"}}}],
    "containers":[{"resources":{"requests":{"cpu":"100m","memory":"64Mi"}}}]},
  "status":{"phase":"Running"}}
]}
JSON
# Effective CPU request is max(400m init, 100m containers) = 400m, not 500m.
run_report E2E_POD_CPU_M=100 E2E_POD_MEMORY_MI=128 \
  || fail "report failed: $(cat "$WORK_DIR/out.txt")"
assert_contains "400m/ 1000m" "$WORK_DIR/out.txt"

write_fixtures

# --- per-namespace grouping does not depend on pod ordering ----------------
# The API server returns pods grouped by namespace today, so an ordering bug
# here would stay invisible until it did not. These pods interleave two
# namespaces deliberately.
cat >"$WORK_DIR/pods.json" <<'JSON'
{"items":[
 {"metadata":{"name":"b1","namespace":"team-b"},
  "spec":{"nodeName":"node-a","containers":[
    {"resources":{"requests":{"cpu":"10m","memory":"16Mi"}}}]},
  "status":{"phase":"Running"}},
 {"metadata":{"name":"a1","namespace":"team-a"},
  "spec":{"nodeName":"node-a","containers":[
    {"resources":{"requests":{"cpu":"100m","memory":"64Mi"}}}]},
  "status":{"phase":"Running"}},
 {"metadata":{"name":"b2","namespace":"team-b"},
  "spec":{"nodeName":"node-b","containers":[
    {"resources":{"requests":{"cpu":"20m","memory":"32Mi"}}}]},
  "status":{"phase":"Running"}},
 {"metadata":{"name":"a2","namespace":"team-a"},
  "spec":{"nodeName":"node-b","containers":[
    {"resources":{"requests":{"cpu":"200m","memory":"128Mi"}}}]},
  "status":{"phase":"Running"}}
]}
JSON
run_report || fail "report failed: $(cat "$WORK_DIR/out.txt")"
# Each namespace must appear once, with both of its pods added together.
[[ "$(grep -c '^    team-a ' "$WORK_DIR/out.txt")" == "1" ]] \
  || fail "team-a was split across rows:
$(cat "$WORK_DIR/out.txt")"
[[ "$(grep -c '^    team-b ' "$WORK_DIR/out.txt")" == "1" ]] \
  || fail "team-b was split across rows:
$(cat "$WORK_DIR/out.txt")"
assert_contains "team-a                           300m" "$WORK_DIR/out.txt"
assert_contains "team-b                            30m" "$WORK_DIR/out.txt"

write_fixtures

# --- threshold enforcement -------------------------------------------------
run_report MIN_FREE_CPU_PERCENT=90 && fail "did not fail when below the CPU threshold"
assert_contains "schedulable CPU headroom 75% is below 90%" "$WORK_DIR/out.txt"

run_report MIN_FREE_MEMORY_PERCENT=90 && fail "did not fail when below the memory threshold"
assert_contains "schedulable memory headroom 75% is below 90%" "$WORK_DIR/out.txt"

# STRICT=false must report the same breach without failing the job, so the
# weekly run can be introduced without immediately blocking on it.
run_report MIN_FREE_CPU_PERCENT=90 STRICT=false \
  || fail "STRICT=false still failed the run"
assert_contains "below 90%" "$WORK_DIR/out.txt"

# --- degraded metrics ------------------------------------------------------
# metrics-server being down must not fail a capacity report, because the
# headroom numbers come from the API server and are still trustworthy.
run_report TOP_FAIL=1 || fail "report failed when metrics were unavailable"
assert_contains "metrics unavailable" "$WORK_DIR/out.txt"
assert_contains "schedulable headroom: CPU 75%" "$WORK_DIR/out.txt"

# --- input validation ------------------------------------------------------
run_report MIN_FREE_CPU_PERCENT=abc && fail "accepted a non-numeric threshold"
assert_contains "must be a non-negative integer" "$WORK_DIR/out.txt"

run_report E2E_PODS_PER_NAMESPACE=0 && fail "accepted a zero pods-per-namespace divisor"
assert_contains "at least 1" "$WORK_DIR/out.txt"

# --- read-only guarantee ---------------------------------------------------
# This job runs with cluster credentials on a schedule, so it must never carry
# a verb that could change the cluster.
for verb in delete apply patch scale create replace edit annotate; do
  grep -qE "kubectl[^|]*\b${verb}\b" "$SCRIPT" \
    && fail "capacity report must stay read-only, found kubectl ${verb}"
done

# --- step summary ----------------------------------------------------------
run_report GITHUB_STEP_SUMMARY="$WORK_DIR/summary.md" \
  || fail "report failed while writing a summary"
assert_contains "schedulable CPU headroom | 75%" "$WORK_DIR/summary.md"

echo "cluster-capacity-report tests passed."
