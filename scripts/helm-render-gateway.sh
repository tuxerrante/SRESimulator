#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="${ROOT_DIR}/helm/sre-simulator"

helm template sre-simulator "${CHART_DIR}" \
  --values "${CHART_DIR}/values.yaml" \
  --set exposure.mode=gateway \
  --set exposure.host=play.sresimulator.osadev.cloud \
  --set exposure.scheme=https \
  --set gateway.className=eg \
  --set gateway.tls.secretName=sre-simulator-gateway-tls \
  --set gateway.certManager.clusterIssuer=letsencrypt-azuredns-prod \
  --set gateway.envoyProxy.name=sre-simulator-public-edge \
  "$@"
