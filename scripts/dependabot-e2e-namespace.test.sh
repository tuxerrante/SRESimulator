#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/dependabot-e2e-namespace.sh"
POOL_SCRIPT="$ROOT_DIR/infra/scripts/dependabot-e2e-pool.sh"
WORKFLOW="$ROOT_DIR/.github/workflows/dependabot-e2e.yml"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dependabot-e2e-ns.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local expected=$1 file=$2
  grep -Fq -- "$expected" "$file" || fail "expected '$expected' in $file"
}

bash -n "$SCRIPT" || fail "$SCRIPT is not valid bash"
bash -n "$POOL_SCRIPT" || fail "$POOL_SCRIPT is not valid bash"

# Fake kubectl backed by the filesystem: a claim is a file under CLAIM_DIR, and
# "create configmap" fails when the file already exists, mirroring the atomic
# create the real claim relies on.
mkdir -p "$WORK_DIR/bin" "$WORK_DIR/claims"
cat > "$WORK_DIR/bin/kubectl" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
namespace=""
verb=""
target=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[i]}" in
    -n|--namespace)
      namespace="${args[i + 1]}"
      ((i++))
      ;;
    -o|--from-literal|--dry-run)
      ((i++))
      ;;
    -*)
      ;;
    *)
      if [[ -z "${verb}" ]]; then
        verb="${args[i]}"
      elif [[ -z "${target}" ]]; then
        target="${args[i]}"
      fi
      ;;
  esac
done
claim_file="${CLAIM_DIR}/${namespace}"
case "${verb}" in
  create)
    if [[ "${target}" == configmap* ]]; then
      if [[ "${FORCE_FORBIDDEN:-0}" == "1" ]]; then
        echo 'Error from server (Forbidden): configmaps is forbidden' >&2
        exit 1
      fi
      if [[ -e "${claim_file}" ]]; then
        # Real kubectl exits 1 for every failure, so the script must not
        # depend on this wording.
        echo "${CONFLICT_MESSAGE:-error: failed to create configmap: configmaps \"dependabot-e2e-claim\" already exists}" >&2
        exit 1
      fi
      : > "${claim_file}"
      exit 0
    fi
    ;;
  get)
    if [[ "${FORCE_FORBIDDEN:-0}" == "1" ]]; then
      echo 'Error from server (Forbidden): configmaps is forbidden' >&2
      exit 1
    fi
    if [[ -e "${claim_file}" ]]; then
      cat "${CLAIM_DIR}/${namespace}.timestamp" 2>/dev/null || \
        date -u +%Y-%m-%dT%H:%M:%SZ
      exit 0
    fi
    exit 1
    ;;
  delete)
    if [[ "${target}" == configmap* ]]; then
      rm -f "${claim_file}" "${CLAIM_DIR}/${namespace}.timestamp"
    fi
    exit 0
    ;;
esac
exit 0
STUB
cat > "$WORK_DIR/bin/helm" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$WORK_DIR/bin/kubectl" "$WORK_DIR/bin/helm"

export PATH="$WORK_DIR/bin:$PATH"
export CLAIM_DIR="$WORK_DIR/claims"

run_claim() {
  DEPENDABOT_E2E_NAMESPACE_POOL="ns-a ns-b" \
  CLAIM_WAIT_SECONDS=0 \
  CLAIM_POLL_SECONDS=0 \
    bash "$SCRIPT" claim "$1" "$2" 2>/dev/null
}

first="$(run_claim 101 1)"
[[ "$first" == "ns-a" ]] || fail "expected first claim to take ns-a, got '$first'"

second="$(run_claim 102 2)"
[[ "$second" == "ns-b" ]] || \
  fail "expected concurrent claim to take a different namespace, got '$second'"

# A third concurrent run must fail rather than silently reuse a busy namespace.
if run_claim 103 3 >/dev/null 2>&1; then
  fail "expected claim to fail when the whole pool is busy"
fi

# Releasing frees the slot for the next pull request.
bash "$SCRIPT" release ns-a sre-dependabot-e2e >/dev/null 2>&1
third="$(run_claim 103 3)"
[[ "$third" == "ns-a" ]] || fail "expected released ns-a to be reusable, got '$third'"

# An abandoned claim older than CLAIM_STALE_MINUTES is reclaimed.
printf '%s' "$(date -u -d '3 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
  date -u -v-3H +%Y-%m-%dT%H:%M:%SZ)" > "$CLAIM_DIR/ns-b.timestamp"
stale="$(
  DEPENDABOT_E2E_NAMESPACE_POOL="ns-b" \
  CLAIM_WAIT_SECONDS=0 CLAIM_POLL_SECONDS=0 \
    bash "$SCRIPT" claim 104 4 2>/dev/null
)"
[[ "$stale" == "ns-b" ]] || fail "expected stale claim on ns-b to be reclaimed"

# A fresh claim must never be stolen.
: > "$CLAIM_DIR/ns-c"
printf '%s' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$CLAIM_DIR/ns-c.timestamp"
if DEPENDABOT_E2E_NAMESPACE_POOL="ns-c" CLAIM_WAIT_SECONDS=0 \
  CLAIM_POLL_SECONDS=0 bash "$SCRIPT" claim 105 5 >/dev/null 2>&1; then
  fail "expected a fresh claim to be respected"
fi

# An empty pool must fail loudly instead of defaulting to some namespace.
if DEPENDABOT_E2E_NAMESPACE_POOL="" bash "$SCRIPT" claim 106 6 >/dev/null 2>&1
then
  fail "expected an empty pool to fail"
fi

# An RBAC denial must fail immediately instead of burning the wait window.
forbidden_output="$(
  FORCE_FORBIDDEN=1 DEPENDABOT_E2E_NAMESPACE_POOL="ns-d" \
  CLAIM_WAIT_SECONDS=600 CLAIM_POLL_SECONDS=0 \
    bash "$SCRIPT" claim 107 7 2>&1 || true
)"
case "$forbidden_output" in
  *Forbidden*) ;;
  *) fail "expected an RBAC denial to be reported, got: $forbidden_output" ;;
esac

# A conflict must be detected from cluster state, not from the error wording,
# so an unfamiliar kubectl message must still route to the busy path.
: > "$CLAIM_DIR/ns-e"
printf '%s' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$CLAIM_DIR/ns-e.timestamp"
unfamiliar_output="$(
  CONFLICT_MESSAGE="totally unexpected wording from a future kubectl" \
  DEPENDABOT_E2E_NAMESPACE_POOL="ns-e" CLAIM_WAIT_SECONDS=0 \
  CLAIM_POLL_SECONDS=0 bash "$SCRIPT" claim 108 8 2>&1 || true
)"
case "$unfamiliar_output" in
  *"cannot claim"*)
    fail "an unfamiliar conflict message must not be treated as fatal"
    ;;
  *"no free namespace"*) ;;
  *) fail "unexpected claim output: $unfamiliar_output" ;;
esac

# Workflow wiring.
assert_contains 'group: dependabot-e2e-${{ github.event.workflow_run.head_sha }}' \
  "$WORKFLOW"
assert_contains "DEPENDABOT_E2E_NAMESPACE_POOL" "$WORKFLOW"
assert_contains "Claim a dedicated E2E namespace" "$WORKFLOW"
assert_contains "Release the claimed E2E namespace" "$WORKFLOW"
assert_contains "scripts/dependabot-e2e-namespace.sh" "$WORKFLOW"
assert_contains "kubectl auth can-i create namespaces --quiet" "$WORKFLOW"
assert_contains "E2E identity must not create namespaces." "$WORKFLOW"
assert_contains "dependabot-e2e-default-deny-egress" "$WORKFLOW"

# The pool provisioner must create every guardrail the workflow verifies.
assert_contains "dependabot-e2e-default-deny-egress" "$POOL_SCRIPT"
assert_contains "dependabot-e2e-allow-dns" "$POOL_SCRIPT"
assert_contains "dependabot-e2e-frontend-to-backend" "$POOL_SCRIPT"
assert_contains "pod-security.kubernetes.io/enforce=restricted" "$POOL_SCRIPT"
assert_contains "pod-security.kubernetes.io/enforce-version=latest" "$POOL_SCRIPT"
assert_contains "kind: RoleBinding" "$POOL_SCRIPT"
assert_contains "SERVICE_ACCOUNT_NAME:-gha-e2e-runner" "$POOL_SCRIPT"
assert_contains "name: admin" "$POOL_SCRIPT"
if grep -Fq "kind: ClusterRoleBinding" "$POOL_SCRIPT"; then
  fail "pool provisioner must not create cluster-scoped bindings"
fi

# A misconfigured timing setting must fail with a clear message rather than an
# opaque bash arithmetic error part way through a run.
for setting in CLAIM_STALE_MINUTES CLAIM_WAIT_SECONDS CLAIM_POLL_SECONDS; do
  if out="$(
    env PATH="$WORK_DIR/bin:$PATH" CLAIM_DIR="$WORK_DIR/claims" \
      DEPENDABOT_E2E_NAMESPACE_POOL="ns-a" "$setting=abc" \
      bash "$SCRIPT" claim 1 1 2>&1
  )"; then
    fail "$setting accepted a non-integer value"
  fi
  grep -Fq "$setting must be" <<<"$out" ||
    fail "$setting rejection did not explain the problem: $out"
done

echo "dependabot E2E namespace pool checks passed."
