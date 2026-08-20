#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/infra/scripts/cleanup-e2e-namespaces.sh"
WORKFLOW="$ROOT_DIR/.github/workflows/cleanup-e2e-namespaces.yml"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cleanup-e2e-ns.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local expected=$1 file=$2
  grep -Fq -- "$expected" "$file" || fail "expected '$expected' in $file"
}

assert_missing() {
  local unexpected=$1 file=$2
  grep -Fq -- "$unexpected" "$file" && fail "did not expect '$unexpected' in $file"
  return 0
}

bash -n "$SCRIPT" || fail "$SCRIPT is not valid bash"

# Fake kubectl backed by the filesystem. NS_DIR holds one file per namespace
# whose contents are the creation timestamp, and deletions remove the file, so
# assertions can check what the script actually removed rather than what it
# printed.
mkdir -p "$WORK_DIR/bin" "$WORK_DIR/ns" "$WORK_DIR/claims"
cat > "$WORK_DIR/bin/kubectl" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
verb=""
target=""
name=""
namespace=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[i]}" in
    -n|--namespace)
      namespace="${args[i + 1]}"
      ((i++))
      ;;
    -o)
      ((i++))
      ;;
    -*)
      ;;
    *)
      if [[ -z "${verb}" ]]; then
        verb="${args[i]}"
      elif [[ -z "${target}" ]]; then
        target="${args[i]}"
      elif [[ -z "${name}" ]]; then
        name="${args[i]}"
      fi
      ;;
  esac
done
case "${verb}" in
  get)
    if [[ "${target}" == namespaces ]]; then
      for file in "${NS_DIR}"/*; do
        [[ -e "${file}" ]] || continue
        echo "$(basename "${file}") $(cat "${file}")"
      done
      exit 0
    fi
    if [[ "${target}" == configmap/* ]]; then
      [[ -e "${CLAIM_DIR}/${namespace}" ]] && exit 0
      exit 1
    fi
    exit 1
    ;;
  delete)
    if [[ -n "${FAIL_DELETE:-}" && "${name}" == "${FAIL_DELETE}" ]]; then
      echo 'Error from server: namespaces "'"${name}"'" not found' >&2
      exit 1
    fi
    [[ -n "${name}" ]] && rm -f "${NS_DIR}/${name}"
    exit 0
    ;;
esac
exit 0
STUB
chmod +x "$WORK_DIR/bin/kubectl"

cat > "$WORK_DIR/bin/helm" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
namespace=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [[ "${args[i]}" == -n ]]; then
    namespace="${args[i + 1]}"
  fi
done
case "${1:-}" in
  list)
    [[ -e "${RELEASE_DIR}/${namespace}" ]] && cat "${RELEASE_DIR}/${namespace}"
    exit 0
    ;;
  uninstall)
    rm -f "${RELEASE_DIR}/${namespace}"
    exit 0
    ;;
esac
exit 0
STUB
chmod +x "$WORK_DIR/bin/helm"

export PATH="$WORK_DIR/bin:$PATH"
export NS_DIR="$WORK_DIR/ns"
export CLAIM_DIR="$WORK_DIR/claims"
export RELEASE_DIR="$WORK_DIR/releases"
mkdir -p "$RELEASE_DIR"

old() { date -u -d '10 days ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-10d +%Y-%m-%dT%H:%M:%SZ; }
recent() { date -u +%Y-%m-%dT%H:%M:%SZ; }

reset_cluster() {
  rm -f "$NS_DIR"/* "$CLAIM_DIR"/* "$RELEASE_DIR"/*
  old > "$NS_DIR/sre-pr-101-20260101-010101"
  old > "$NS_DIR/sre-manual-e2e-abc"
  recent > "$NS_DIR/sre-pr-202-20260101-010101"
  old > "$NS_DIR/sre-simulator"
  old > "$NS_DIR/sre-dependabot-e2e-1"
  old > "$NS_DIR/kube-system"
  old > "$NS_DIR/some-other-team"
}

run_cleanup() {
  ( cd "$WORK_DIR" && env GITHUB_REPOSITORY="" "$@" bash "$SCRIPT" ) \
    > "$WORK_DIR/out.txt" 2>&1
}

# A dry run must report the stale namespaces without removing anything.
reset_cluster
run_cleanup DRY_RUN=true || fail "dry run exited non-zero: $(cat "$WORK_DIR/out.txt")"
assert_contains "would delete sre-pr-101-20260101-010101" "$WORK_DIR/out.txt"
assert_contains "would delete sre-manual-e2e-abc" "$WORK_DIR/out.txt"
[[ -e "$NS_DIR/sre-pr-101-20260101-010101" ]] || fail "dry run deleted sre-pr-101-20260101-010101"
[[ -e "$NS_DIR/sre-manual-e2e-abc" ]] || fail "dry run deleted sre-manual-e2e-abc"

# The real run must delete only the stale ephemeral namespaces.
reset_cluster
run_cleanup DRY_RUN=false || fail "cleanup exited non-zero: $(cat "$WORK_DIR/out.txt")"
[[ -e "$NS_DIR/sre-pr-101-20260101-010101" ]] && fail "stale sre-pr-101 was not deleted"
[[ -e "$NS_DIR/sre-manual-e2e-abc" ]] && fail "stale sre-manual-e2e-abc was not deleted"

# Everything else must survive: production, the pool, recent namespaces and any
# namespace outside the allow-listed prefixes.
for keep in sre-simulator sre-dependabot-e2e-1 kube-system some-other-team sre-pr-202-20260101-010101; do
  [[ -e "$NS_DIR/$keep" ]] || fail "cleanup deleted $keep"
done

# Production must survive even if a prefix is widened to match it.
reset_cluster
run_cleanup DRY_RUN=false CLEANUP_NAMESPACE_PREFIXES="sre-pr- sre-sim" || \
  fail "cleanup exited non-zero: $(cat "$WORK_DIR/out.txt")"
[[ -e "$NS_DIR/sre-simulator" ]] || fail "protection did not save production"
assert_contains "protected" "$WORK_DIR/out.txt"

# The pool namespaces must survive even when explicitly targeted.
reset_cluster
run_cleanup DRY_RUN=false CLEANUP_NAMESPACE_PREFIXES="sre-dependabot-e2e" || \
  fail "cleanup exited non-zero: $(cat "$WORK_DIR/out.txt")"
[[ -e "$NS_DIR/sre-dependabot-e2e-1" ]] || fail "pool namespace was deleted"

# A prefix that could match unrelated namespaces must be rejected outright.
reset_cluster
if run_cleanup DRY_RUN=false CLEANUP_NAMESPACE_PREFIXES="sre-"; then
  fail "a too-short prefix was accepted"
fi
assert_contains "too short" "$WORK_DIR/out.txt"

reset_cluster
if run_cleanup DRY_RUN=false CLEANUP_NAMESPACE_PREFIXES="kube-system"; then
  fail "a prefix outside the project namespace was accepted"
fi
assert_contains "must start with 'sre-'" "$WORK_DIR/out.txt"

# An unset or malformed DRY_RUN must never fall through to a deletion.
reset_cluster
if run_cleanup DRY_RUN=yes; then
  fail "an invalid DRY_RUN value was accepted"
fi
[[ -e "$NS_DIR/sre-pr-101-20260101-010101" ]] || fail "invalid DRY_RUN still deleted a namespace"

reset_cluster
( cd "$WORK_DIR" && env -u DRY_RUN GITHUB_REPOSITORY="" bash "$SCRIPT" ) \
  > "$WORK_DIR/out.txt" 2>&1 || fail "default run failed: $(cat "$WORK_DIR/out.txt")"
[[ -e "$NS_DIR/sre-pr-101-20260101-010101" ]] || fail "cleanup defaulted to deleting"
assert_contains "Dry run" "$WORK_DIR/out.txt"

# An unclaimed pool namespace with a leftover release must be reclaimed, and a
# claimed one must be left alone.
reset_cluster
old > "$NS_DIR/sre-dependabot-e2e-2"
echo "sre-simulator" > "$RELEASE_DIR/sre-dependabot-e2e-1"
echo "sre-simulator" > "$RELEASE_DIR/sre-dependabot-e2e-2"
: > "$CLAIM_DIR/sre-dependabot-e2e-2"
run_cleanup DRY_RUN=false || fail "cleanup exited non-zero: $(cat "$WORK_DIR/out.txt")"
[[ -e "$RELEASE_DIR/sre-dependabot-e2e-1" ]] && fail "unclaimed release was not uninstalled"
[[ -e "$RELEASE_DIR/sre-dependabot-e2e-2" ]] || fail "claimed release was uninstalled"
[[ -e "$NS_DIR/sre-dependabot-e2e-1" ]] || fail "pool namespace deleted while reclaiming a release"

# A namespace whose pull request still has a run in flight must be kept.
# The stub answers only paginated requests, and only reports the in-flight run
# under a status that is not queried first, so dropping pagination or narrowing
# the set of active run statuses makes the guard miss the run and fail the test.
cat > "$WORK_DIR/bin/gh" <<'STUB'
#!/usr/bin/env bash
[[ "${GH_FAIL:-0}" == "1" ]] && exit 1
args="$*"
[[ "$args" == *--paginate* ]] || exit 1
case "$args" in
  *actions/runs*status=waiting*) echo "deadbeef" ;;
  *actions/runs*) ;;
  *pulls?state=open*) echo "101 deadbeef" ;;
esac
exit 0
STUB
chmod +x "$WORK_DIR/bin/gh"
reset_cluster
( cd "$WORK_DIR" && env DRY_RUN=false GITHUB_REPOSITORY="o/r" bash "$SCRIPT" ) \
  > "$WORK_DIR/out.txt" 2>&1 || fail "cleanup failed: $(cat "$WORK_DIR/out.txt")"
[[ -e "$NS_DIR/sre-pr-101-20260101-010101" ]] || fail "deleted a namespace whose PR still had a run in flight"
assert_contains "still has a run in flight" "$WORK_DIR/out.txt"
# A namespace with no in-flight run must still be reclaimed in the same pass.
[[ -e "$NS_DIR/sre-manual-e2e-abc" ]] && fail "guard blocked an unrelated namespace"

# If the guard cannot be resolved it must keep pull request namespaces rather
# than silently degrade to the age check alone.
reset_cluster
( cd "$WORK_DIR" && env DRY_RUN=false GITHUB_REPOSITORY="o/r" GH_FAIL=1 bash "$SCRIPT" ) \
  > "$WORK_DIR/out.txt" 2>&1 || fail "cleanup failed: $(cat "$WORK_DIR/out.txt")"
[[ -e "$NS_DIR/sre-pr-101-20260101-010101" ]] || fail "deleted a PR namespace while the guard was unavailable"
assert_contains "cannot confirm no run is in flight" "$WORK_DIR/out.txt"
# Namespaces the guard does not cover must still be reclaimed.
[[ -e "$NS_DIR/sre-manual-e2e-abc" ]] && fail "a failed PR guard blocked unrelated cleanup"
rm -f "$WORK_DIR/bin/gh"

# A namespace that disappears between the listing and the delete must not abort
# the rest of the pass.
reset_cluster
( cd "$WORK_DIR" && env DRY_RUN=false GITHUB_REPOSITORY="" FAIL_DELETE=sre-pr-101-20260101-010101 \
  bash "$SCRIPT" ) > "$WORK_DIR/out.txt" 2>&1 || \
  fail "a failed delete aborted the run: $(cat "$WORK_DIR/out.txt")"
assert_contains "could not delete sre-pr-101-20260101-010101" "$WORK_DIR/out.txt"
[[ -e "$NS_DIR/sre-manual-e2e-abc" ]] && fail "a failed delete stopped later cleanup"

# Negative control: the assertions above must fail if the guards are removed.
BROKEN="$WORK_DIR/broken.sh"
sed 's/^  \[\[ "${namespace}" == "${POOL_NAMESPACE_PREFIX}"\* \]\] \&\& return 0$/  :/' \
  "$SCRIPT" > "$BROKEN"
grep -Fq 'POOL_NAMESPACE_PREFIX}"* ]] && return 0' "$BROKEN" && \
  fail "negative control did not patch the pool guard"
reset_cluster
( cd "$WORK_DIR" && env DRY_RUN=false GITHUB_REPOSITORY="" \
  CLEANUP_NAMESPACE_PREFIXES="sre-dependabot-e2e" bash "$BROKEN" ) \
  > "$WORK_DIR/out.txt" 2>&1 || true
[[ -e "$NS_DIR/sre-dependabot-e2e-1" ]] && \
  fail "negative control did not detect the removed pool guard"

# The workflow must stay wired to the script and must not delete by default.
[[ -f "$WORKFLOW" ]] || fail "missing $WORKFLOW"
assert_contains "cleanup-e2e-namespaces" "$WORKFLOW"
assert_contains "schedule:" "$WORKFLOW"
assert_contains "workflow_dispatch:" "$WORKFLOW"
# The scheduled run is the only one allowed to delete without a human choice.
assert_contains "default: true" "$WORKFLOW"
# workflow_dispatch can be started from any branch, so the job must refuse to
# run anything but the default branch with cluster credentials.
assert_contains "github.event.repository.default_branch" "$WORKFLOW"
assert_missing "sre-simulator" "$WORKFLOW"

echo "cleanup-e2e-namespaces tests passed."
