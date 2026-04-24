#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local needle=$1 file=$2
  grep -Fq "$needle" "$file" || fail "expected '$needle' in $file"
}

assert_not_contains() {
  local needle=$1 file=$2
  if grep -Fq "$needle" "$file"; then
    fail "did not expect '$needle' in $file"
  fi
}

write_stubs() {
  cat >"$TMP_DIR/az" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

resolve_name_arg() {
  local idx
  for ((idx = 1; idx <= $#; idx++)); do
    if [[ "${!idx}" == "--name" ]]; then
      idx=$((idx + 1))
      printf '%s\n' "${!idx}"
      return 0
    fi
  done
  return 1
}

case "${1:-}" in
  account)
    case "${2:-}" in
      show)
        if [[ "${3:-}" == "--query" && "${4:-}" == "id" ]]; then
          printf '%s\n' "${AZ_SUB_ID}"
        elif [[ "${3:-}" == "--query" && "${4:-}" == "user.name" ]]; then
          printf '%s\n' "${AZ_ASSIGNEE}"
        else
          printf '{"id":"%s","user":{"name":"%s"}}\n' "${AZ_SUB_ID}" "${AZ_ASSIGNEE}"
        fi
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  storage)
    case "${2:-} ${3:-}" in
      "account show"|"container show")
        exit 0
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  role)
    [[ "${2:-}" == "assignment" && "${3:-}" == "list" ]] || exit 1
    printf 'Owner\n'
    ;;
  provider)
    [[ "${2:-}" == "show" ]] || exit 1
    printf 'Registered\n'
    ;;
  group)
    [[ "${2:-}" == "exists" ]] || exit 1
    name="$(resolve_name_arg "$@")"
    if [[ "$name" == "${TEST_EXISTING_NODE_RG}" ]]; then
      printf 'true\n'
    else
      printf 'false\n'
    fi
    ;;
  rest)
    printf 'true\t\n'
    ;;
  vm)
    [[ "${2:-}" == "list-usage" ]] || exit 1
    printf 'B-series vCPUs\t0\t10\n'
    ;;
  cognitiveservices)
    [[ "${2:-}" == "model" && "${3:-}" == "list" ]] || exit 1
    printf 'GlobalStandard\n'
    ;;
  *)
    exit 1
    ;;
esac
EOF

  cat >"$TMP_DIR/terraform" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exit 0
EOF

  chmod +x "$TMP_DIR/az" "$TMP_DIR/terraform"
}

run_custom_node_rg_override_check() {
  local output_file="$TMP_DIR/preflight.txt"

  if PATH="$TMP_DIR:$PATH" \
    AZ_SUB_ID="00000000-0000-0000-0000-000000000000" \
    AZ_ASSIGNEE="operator@example.com" \
    TEST_EXISTING_NODE_RG="custom-aks-nodes-rg" \
    OWNER_ALIAS="aaffinit" \
    LOCATION="westeurope" \
    CLUSTER_FLAVOR="aks" \
    TF_STATE_ACCOUNT="aaffinitstate" \
    TF_STATE_RG="tfstate-rg" \
    TF_STATE_CONTAINER="tfstate" \
    TF_STATE_KEY="aaffinit-test-sre-simulator.tfstate" \
    TF_BACKEND_ENV_FILE="$TMP_DIR/.tf-backend.env" \
    GENEVA_SUPPRESSION_ACCESS_CONFIRMED="true" \
    AKS_NODE_RESOURCE_GROUP_NAME="custom-aks-nodes-rg" \
    bash "$ROOT_DIR/infra/scripts/tf-preflight.sh" >"$output_file" 2>&1; then
    cat "$output_file" >&2 || true
    fail "tf-preflight should fail when the overridden AKS node resource group already exists"
  fi

  assert_contains "AKS node resource group custom-aks-nodes-rg already exists." "$output_file"
  assert_not_contains "AKS node resource group aaffinit-test-aks-nodes-rg already exists." "$output_file"
}

main() {
  write_stubs
  run_custom_node_rg_override_check
  echo "tf-preflight tests passed."
}

main "$@"
