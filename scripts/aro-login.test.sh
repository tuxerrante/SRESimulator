#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

AZ_LOG="$TMP_DIR/az.log"
OC_LOG="$TMP_DIR/oc.log"
AZ_STATE="$TMP_DIR/az.state"
AZ_SUB_ID="00000000-0000-0000-0000-000000000000"
AZ_SUB_NAME="Example Subscription"
ARO_API_SERVER="https://api.example-aro:6443"
KUBEADMIN_PASSWORD="redacted-test-password"
OC_USER="kube:admin"

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
printf '%s\n' "$*" >>"$AZ_LOG"

case "${1:-}" in
  account)
    case "${2:-}" in
      show)
        if [[ "$(cat "$AZ_STATE")" != "logged_in" ]]; then
          echo "ERROR: Azure CLI not logged in" >&2
          exit 1
        fi
        if [[ "${3:-}" == "--query" && "${4:-}" == "id" && "${5:-}" == "-o" && "${6:-}" == "tsv" ]]; then
          printf '%s\n' "$AZ_SUB_ID"
          exit 0
        fi
        if [[ "${3:-}" == "--query" && "${4:-}" == "name" && "${5:-}" == "-o" && "${6:-}" == "tsv" ]]; then
          printf '%s\n' "$AZ_SUB_NAME"
          exit 0
        fi
        printf '{"id":"%s","name":"%s"}\n' "$AZ_SUB_ID" "$AZ_SUB_NAME"
        ;;
      set)
        if [[ "$(cat "$AZ_STATE")" != "logged_in" ]]; then
          echo "ERROR: Azure CLI not logged in" >&2
          exit 1
        fi
        [[ "${3:-}" == "-s" ]] || exit 1
        [[ "${4:-}" == "$AZ_SUB_ID" ]] || exit 1
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  login)
    [[ "${2:-}" == "--use-device-code" ]] || exit 1
    printf 'logged_in\n' >"$AZ_STATE"
    echo "Interactive device-code login completed."
    ;;
  aro)
    if [[ "$(cat "$AZ_STATE")" != "logged_in" ]]; then
      echo "ERROR: Azure CLI not logged in" >&2
      exit 1
    fi
    case "${2:-}" in
      show)
        [[ "${4:-}" == "example-aro-rg" ]] || exit 1
        [[ "${6:-}" == "example-aro-cluster" ]] || exit 1
        [[ "${8:-}" == "apiserverProfile.url" ]] || exit 1
        [[ "${10:-}" == "tsv" ]] || exit 1
        printf '%s\n' "$ARO_API_SERVER"
        ;;
      list-credentials)
        [[ "${4:-}" == "example-aro-rg" ]] || exit 1
        [[ "${6:-}" == "example-aro-cluster" ]] || exit 1
        [[ "${8:-}" == "kubeadminPassword" ]] || exit 1
        [[ "${10:-}" == "tsv" ]] || exit 1
        printf '%s\n' "$KUBEADMIN_PASSWORD"
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  *)
    exit 1
    ;;
esac
EOF

  cat >"$TMP_DIR/oc" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$OC_LOG"

case "${1:-}" in
  login)
    [[ "${2:-}" == "$ARO_API_SERVER" ]] || exit 1
    [[ "${3:-}" == "-u" && "${4:-}" == "kubeadmin" ]] || exit 1
    [[ "${5:-}" == "-p" && "${6:-}" == "$KUBEADMIN_PASSWORD" ]] || exit 1
    [[ "${7:-}" == "--insecure-skip-tls-verify=true" ]] || exit 1
    ;;
  whoami)
    if [[ "${2:-}" == "--show-server" ]]; then
      printf '%s\n' "$ARO_API_SERVER"
    else
      printf '%s\n' "$OC_USER"
    fi
    ;;
  *)
    exit 1
    ;;
esac
EOF

  chmod +x "$TMP_DIR/az" "$TMP_DIR/oc"
}

run_logged_out_flow() {
  : >"$AZ_LOG"
  : >"$OC_LOG"
  printf 'logged_out\n' >"$AZ_STATE"

  if ! PATH="$TMP_DIR:$PATH" \
    AZ_LOG="$AZ_LOG" \
    OC_LOG="$OC_LOG" \
    AZ_STATE="$AZ_STATE" \
    AZ_SUB_ID="$AZ_SUB_ID" \
    AZ_SUB_NAME="$AZ_SUB_NAME" \
    ARO_API_SERVER="$ARO_API_SERVER" \
    KUBEADMIN_PASSWORD="$KUBEADMIN_PASSWORD" \
    OC_USER="$OC_USER" \
    make -C "$ROOT_DIR" aro-login \
      AZURE_SUBSCRIPTION_ID="$AZ_SUB_ID" \
      ARO_RG=example-aro-rg \
      ARO_CLUSTER=example-aro-cluster >"$TMP_DIR/logged-out.txt" 2>&1; then
    cat "$TMP_DIR/logged-out.txt" >&2
    echo "--- az log ---" >&2
    cat "$AZ_LOG" >&2 || true
    echo "--- oc log ---" >&2
    cat "$OC_LOG" >&2 || true
    fail "logged-out aro-login flow failed"
  fi

  assert_contains "login --use-device-code" "$AZ_LOG"
  assert_contains "account set -s $AZ_SUB_ID" "$AZ_LOG"
  assert_contains "aro show -g example-aro-rg -n example-aro-cluster --query apiserverProfile.url -o tsv" "$AZ_LOG"
  assert_contains "aro list-credentials -g example-aro-rg -n example-aro-cluster --query kubeadminPassword -o tsv" "$AZ_LOG"
  assert_contains "login $ARO_API_SERVER -u kubeadmin -p $KUBEADMIN_PASSWORD --insecure-skip-tls-verify=true" "$OC_LOG"
  assert_contains "whoami --show-server" "$OC_LOG"
  assert_contains "Azure subscription: $AZ_SUB_NAME ($AZ_SUB_ID)" "$TMP_DIR/logged-out.txt"
  assert_contains "OpenShift user: $OC_USER" "$TMP_DIR/logged-out.txt"
}

run_logged_in_flow() {
  : >"$AZ_LOG"
  : >"$OC_LOG"
  printf 'logged_in\n' >"$AZ_STATE"

  if ! PATH="$TMP_DIR:$PATH" \
    AZ_LOG="$AZ_LOG" \
    OC_LOG="$OC_LOG" \
    AZ_STATE="$AZ_STATE" \
    AZ_SUB_ID="$AZ_SUB_ID" \
    AZ_SUB_NAME="$AZ_SUB_NAME" \
    ARO_API_SERVER="$ARO_API_SERVER" \
    KUBEADMIN_PASSWORD="$KUBEADMIN_PASSWORD" \
    OC_USER="$OC_USER" \
    make -C "$ROOT_DIR" aro-login \
      AZURE_SUBSCRIPTION_ID="$AZ_SUB_ID" \
      ARO_RG=example-aro-rg \
      ARO_CLUSTER=example-aro-cluster >"$TMP_DIR/logged-in.txt" 2>&1; then
    cat "$TMP_DIR/logged-in.txt" >&2
    echo "--- az log ---" >&2
    cat "$AZ_LOG" >&2 || true
    echo "--- oc log ---" >&2
    cat "$OC_LOG" >&2 || true
    fail "logged-in aro-login flow failed"
  fi

  assert_not_contains "login --use-device-code" "$AZ_LOG"
  assert_contains "account set -s $AZ_SUB_ID" "$AZ_LOG"
  assert_contains "OpenShift server: $ARO_API_SERVER" "$TMP_DIR/logged-in.txt"
}

run_cluster_login_helper_flow() {
  : >"$AZ_LOG"
  : >"$OC_LOG"
  printf 'logged_out\n' >"$AZ_STATE"

  if ! PATH="$TMP_DIR:$PATH" \
    AZ_LOG="$AZ_LOG" \
    OC_LOG="$OC_LOG" \
    AZ_STATE="$AZ_STATE" \
    AZ_SUB_ID="$AZ_SUB_ID" \
    AZ_SUB_NAME="$AZ_SUB_NAME" \
    ARO_API_SERVER="$ARO_API_SERVER" \
    KUBEADMIN_PASSWORD="$KUBEADMIN_PASSWORD" \
    OC_USER="$OC_USER" \
    AZURE_SUBSCRIPTION_ID="$AZ_SUB_ID" \
    ARO_RG=example-aro-rg \
    ARO_CLUSTER=example-aro-cluster \
    bash -c 'set -euo pipefail; source "$1"; cluster_login' _ \
    "$ROOT_DIR/scripts/aro-deploy.sh" >"$TMP_DIR/cluster-login.txt" 2>&1; then
    cat "$TMP_DIR/cluster-login.txt" >&2 || true
    echo "--- az log ---" >&2
    cat "$AZ_LOG" >&2 || true
    echo "--- oc log ---" >&2
    cat "$OC_LOG" >&2 || true
    fail "cluster_login should authenticate Azure before querying the ARO cluster"
  fi

  assert_contains "login --use-device-code" "$AZ_LOG"
  assert_contains "account set -s $AZ_SUB_ID" "$AZ_LOG"
  assert_contains "login $ARO_API_SERVER -u kubeadmin -p $KUBEADMIN_PASSWORD --insecure-skip-tls-verify=true" "$OC_LOG"
}

main() {
  write_stubs
  run_logged_out_flow
  run_logged_in_flow
  run_cluster_login_helper_flow
  echo "aro-login target tests passed."
}

main "$@"
