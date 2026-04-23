#!/usr/bin/env bash
# Select the platform-specific deployment helpers for the active cluster flavor.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
    echo "error: unsupported CLUSTER_FLAVOR='${CLUSTER_FLAVOR:-}' (expected aks or aro)" >&2
    return 1
    ;;
esac
