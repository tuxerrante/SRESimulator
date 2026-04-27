#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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

assert_target_order() {
  local target=$1 first=$2 second=$3 file=$4
  if ! python3 - "$target" "$first" "$second" "$file" <<'PY'
import sys
from pathlib import Path

target, first, second, file_path = sys.argv[1:]
lines = Path(file_path).read_text().splitlines()
in_target = False
first_line = None
second_line = None

for idx, line in enumerate(lines, start=1):
    if not in_target and line.startswith(f"{target}:"):
        in_target = True
        continue
    if in_target and line and not line[0].isspace():
        break
    if in_target and first in line and first_line is None:
        first_line = idx
    if in_target and second in line and second_line is None:
        second_line = idx

if first_line is None or second_line is None or first_line >= second_line:
    raise SystemExit(1)
PY
  then
    fail "expected '$first' before '$second' inside target '$target'"
  fi
}

assert_function_exists() {
  local name=$1
  if ! declare -F "$name" >/dev/null; then
    fail "expected shell helper '$name' to exist"
  fi
}

write_oc_stub() {
  cat >"$TMP_DIR/oc" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "-n" ]]; then
  shift 2
fi

case "${1:-}" in
  get)
    if [[ "${OC_SECRET_ERROR_MODE:-}" == "forbidden" ]]; then
      echo "Error from server (Forbidden): secrets is forbidden" >&2
      exit 1
    fi
    if [[ "${OC_SECRET_ERROR_MODE:-}" == "namespace-not-found" ]]; then
      echo "Error from server (NotFound): namespaces \"sre-simulator\" not found" >&2
      exit 1
    fi
    if [[ "${2:-}" == "secret/sre-sql-creds" || "${2:-}" == "secret" && "${3:-}" == "sre-sql-creds" ]]; then
      exit 0
    fi
    secret_name="${2:-unknown}"
    if [[ "$secret_name" == secret/* ]]; then
      secret_name="${secret_name#secret/}"
    elif [[ "$secret_name" == "secret" ]]; then
      secret_name="${3:-unknown}"
    fi
    echo "Error from server (NotFound): secrets \"$secret_name\" not found" >&2
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
EOF
  chmod +x "$TMP_DIR/oc"
}

run_helper_tests() {
  write_oc_stub
  # shellcheck disable=SC1091
  source "$ROOT_DIR/scripts/aro-deploy.sh"

  assert_function_exists "require_prod_db_secret_name"
  assert_function_exists "require_db_secret_exists_in_namespace"

  if DB_SECRET_NAME="" require_prod_db_secret_name >"$TMP_DIR/missing-db-secret.txt" 2>&1; then
    fail "require_prod_db_secret_name should fail when DB_SECRET_NAME is empty"
  fi
  assert_contains "DB_SECRET_NAME is required for production deployment with STORAGE_BACKEND=mssql." "$TMP_DIR/missing-db-secret.txt"

  if ! PATH="$TMP_DIR:$PATH" DB_SECRET_NAME="sre-sql-creds" require_db_secret_exists_in_namespace "sre-simulator" >"$TMP_DIR/secret-present.txt" 2>&1; then
    cat "$TMP_DIR/secret-present.txt" >&2 || true
    fail "require_db_secret_exists_in_namespace should pass when the secret exists"
  fi

  if PATH="$TMP_DIR:$PATH" DB_SECRET_NAME="missing-secret" require_db_secret_exists_in_namespace "sre-simulator" >"$TMP_DIR/secret-missing.txt" 2>&1; then
    fail "require_db_secret_exists_in_namespace should fail when the secret is absent"
  fi
  assert_contains "DB secret 'missing-secret' was not found in namespace 'sre-simulator'." "$TMP_DIR/secret-missing.txt"

  if PATH="$TMP_DIR:$PATH" OC_SECRET_ERROR_MODE="forbidden" DB_SECRET_NAME="sre-sql-creds" require_db_secret_exists_in_namespace "sre-simulator" >"$TMP_DIR/secret-error.txt" 2>&1; then
    fail "require_db_secret_exists_in_namespace should fail loudly on access errors"
  fi
  assert_contains "Failed to verify DB secret 'sre-sql-creds' in namespace 'sre-simulator'." "$TMP_DIR/secret-error.txt"
  assert_contains "Error from server (Forbidden): secrets is forbidden" "$TMP_DIR/secret-error.txt"

  if PATH="$TMP_DIR:$PATH" OC_SECRET_ERROR_MODE="namespace-not-found" DB_SECRET_NAME="sre-sql-creds" require_db_secret_exists_in_namespace "sre-simulator" >"$TMP_DIR/namespace-error.txt" 2>&1; then
    fail "require_db_secret_exists_in_namespace should fail loudly when the namespace is missing"
  fi
  assert_contains "Failed to verify DB secret 'sre-sql-creds' in namespace 'sre-simulator'." "$TMP_DIR/namespace-error.txt"
  assert_contains 'Error from server (NotFound): namespaces "sre-simulator" not found' "$TMP_DIR/namespace-error.txt"
}

run_static_wiring_checks() {
  assert_contains "require_prod_db_secret_name" "$ROOT_DIR/Makefile"
  assert_contains "require_db_secret_exists_in_namespace" "$ROOT_DIR/Makefile"
  assert_contains "create_or_update_aoai_secret" "$ROOT_DIR/Makefile"
  assert_contains "AKS_FRONTEND_PUBLIC_IP_NAME" "$ROOT_DIR/Makefile"
  assert_contains "AKS_FRONTEND_PUBLIC_HOST" "$ROOT_DIR/Makefile"
  assert_contains "AKS_FRONTEND_PUBLIC_ORIGIN_SCHEME" "$ROOT_DIR/Makefile"
  assert_not_contains "AKS_INGRESS_PUBLIC_IP_NAME" "$ROOT_DIR/Makefile"
  assert_not_contains "AKS_PUBLIC_HOST" "$ROOT_DIR/Makefile"
  assert_not_contains "AKS_PUBLIC_ORIGIN_SCHEME" "$ROOT_DIR/Makefile"
  assert_contains ". scripts/select-deploy.sh" "$ROOT_DIR/Makefile"
  assert_contains "db-mode-check:" "$ROOT_DIR/Makefile"
  assert_contains '$(MAKE) public-exposure-audit NS="$$NS"' "$ROOT_DIR/Makefile"
  assert_contains '$(MAKE) db-mode-check NS="$$NS"' "$ROOT_DIR/Makefile"
  assert_contains '$(MAKE) db-port-forward-check NS="$$NS"' "$ROOT_DIR/Makefile"
  assert_contains 'ensure_namespace "$$NS"' "$ROOT_DIR/Makefile"
  assert_contains '$(MAKE) db-mode-check NS="$(PROD_NAMESPACE)"' "$ROOT_DIR/Makefile"
  assert_target_order "prod-up" 'ensure_namespace "$$NS"' 'require_db_secret_exists_in_namespace "$$NS"' "$ROOT_DIR/Makefile"
  assert_target_order "prod-up-tag" 'ensure_namespace "$$NS"' 'require_db_secret_exists_in_namespace "$$NS"' "$ROOT_DIR/Makefile"
  assert_contains 'DB_SECRET_NAME: ${{ secrets.DB_SECRET_NAME }}' "$ROOT_DIR/.github/workflows/deploy-prod.yml"
  assert_contains "AKS_FRONTEND_PUBLIC_IP_NAME: >-" "$ROOT_DIR/.github/workflows/deploy-prod.yml"
  assert_contains "vars.AKS_FRONTEND_PUBLIC_IP_NAME ||" "$ROOT_DIR/.github/workflows/deploy-prod.yml"
  assert_contains "format('{0}-aks-frontend-pip', secrets.AKS_CLUSTER)" "$ROOT_DIR/.github/workflows/deploy-prod.yml"
  assert_not_contains 'AKS_FRONTEND_PUBLIC_IP_NAME: ${{ secrets.AKS_FRONTEND_PUBLIC_IP_NAME }}' "$ROOT_DIR/.github/workflows/deploy-prod.yml"
  assert_contains 'AKS_CERT_MANAGER_ACME_EMAIL: ${{ vars.AKS_CERT_MANAGER_ACME_EMAIL }}' "$ROOT_DIR/.github/workflows/deploy-prod.yml"
  assert_not_contains 'AKS_INGRESS_PUBLIC_IP_NAME: ${{ secrets.AKS_INGRESS_PUBLIC_IP_NAME }}' "$ROOT_DIR/.github/workflows/deploy-prod.yml"
  assert_contains 'PROD_CLUSTER_FLAVOR: >-' "$ROOT_DIR/.github/workflows/deploy-prod.yml"
  assert_contains '${{ needs.resolve-release-tag.outputs.prod_cluster_flavor }}' "$ROOT_DIR/.github/workflows/deploy-prod.yml"
  assert_contains 'CLUSTER_FLAVOR="${PROD_CLUSTER_FLAVOR}"' "$ROOT_DIR/.github/workflows/deploy-prod.yml"
  assert_contains 'make db-mode-check \' "$ROOT_DIR/.github/workflows/deploy-prod.yml"
  assert_contains 'NS="${PROD_NAMESPACE:-sre-simulator}"' "$ROOT_DIR/.github/workflows/deploy-prod.yml"
  assert_contains 'AKS_FRONTEND_PUBLIC_IP_NAME=' "$ROOT_DIR/infra/outputs.tf"
  assert_contains 'AKS_FRONTEND_PUBLIC_HOST=' "$ROOT_DIR/infra/outputs.tf"
  assert_contains 'output "aks_frontend_public_host"' "$ROOT_DIR/infra/outputs.tf"
  assert_not_contains 'AKS_INGRESS_PUBLIC_IP_NAME=' "$ROOT_DIR/infra/outputs.tf"
  assert_not_contains 'AKS_PUBLIC_HOST=' "$ROOT_DIR/infra/outputs.tf"
  assert_not_contains 'output "public_frontend_host"' "$ROOT_DIR/infra/outputs.tf"
}

main() {
  run_helper_tests
  run_static_wiring_checks
  echo "prod DB guard tests passed."
}

main "$@"
