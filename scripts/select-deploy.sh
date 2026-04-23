#!/usr/bin/env bash
# Select the platform-specific deployment helpers for the active cluster flavor.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail_selection() {
  local message=$1
  echo "$message" >&2
  if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
    return 1
  fi
  exit 1
}

case "${CLUSTER_FLAVOR:-aks}" in
  aks)
    # shellcheck disable=SC1091
    source "${SCRIPT_DIR}/aks-deploy.sh"
    ;;
  aro)
    # shellcheck disable=SC1091
    source "${SCRIPT_DIR}/aro-deploy.sh"
    ;;
  *)
    fail_selection "error: unsupported CLUSTER_FLAVOR='${CLUSTER_FLAVOR:-}' (expected aks or aro)"
    ;;
esac
