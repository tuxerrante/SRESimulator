#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="${ROOT_DIR}/helm/sre-simulator"

route_render="$(mktemp)"
ingress_render="$(mktemp)"
ingress_no_db_render="$(mktemp)"
trap 'rm -f "${route_render}" "${ingress_render}" "${ingress_no_db_render}"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

helm template sre-simulator "${CHART_DIR}" \
  --set route.enabled=true \
  --set route.host=route.example.com \
  --set publicOrigin=https://public.example.com >"${route_render}"

rg -q '^kind: Route$' "${route_render}" || \
  fail "Route mode should render an OpenShift Route."

rg -q 'host: route\.example\.com' "${route_render}" || \
  fail "Route mode should preserve the route host."

rg -q 'value: "https://public\.example\.com"' "${route_render}" || \
  fail "Backend CORS origin should come from publicOrigin, not route.host."

helm template sre-simulator "${CHART_DIR}" \
  --set route.enabled=false \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set ingress.host=public.example.com \
  --set publicOrigin=http://public.example.com \
  --set frontend.autoscaling.enabled=true \
  --set frontend.autoscaling.minReplicas=1 \
  --set frontend.autoscaling.maxReplicas=3 \
  --set backend.autoscaling.enabled=true \
  --set backend.autoscaling.minReplicas=1 \
  --set backend.autoscaling.maxReplicas=4 \
  --set database.enabled=true \
  --set database.existingSecretName=sre-sql-creds >"${ingress_render}"

rg -q '^kind: Ingress$' "${ingress_render}" || \
  fail "Ingress mode should render a Kubernetes Ingress."

if rg -q '^kind: Route$' "${ingress_render}"; then
  fail "Ingress mode must not render an OpenShift Route."
fi

rg -q 'value: "http://public\.example\.com"' "${ingress_render}" || \
  fail "Ingress mode should feed publicOrigin into backend CORS configuration."

frontend_hpa_count="$(rg -c '^kind: HorizontalPodAutoscaler$' "${ingress_render}")"
if [[ "${frontend_hpa_count}" -lt 2 ]]; then
  fail "Ingress mode with frontend/backend autoscaling enabled should render two HPAs."
fi

rg -q 'name: sre-simulator-frontend-hpa' "${ingress_render}" || \
  fail "Frontend autoscaling should render the frontend HPA."

rg -q 'name: sre-simulator-backend-hpa' "${ingress_render}" || \
  fail "Backend autoscaling with database mode should render the backend HPA."

helm template sre-simulator "${CHART_DIR}" \
  --set route.enabled=false \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set ingress.host=public.example.com \
  --set publicOrigin=http://public.example.com \
  --set backend.autoscaling.enabled=true \
  --set backend.autoscaling.minReplicas=1 \
  --set backend.autoscaling.maxReplicas=4 \
  --set database.enabled=false >"${ingress_no_db_render}"

if rg -q 'name: sre-simulator-backend-hpa' "${ingress_no_db_render}"; then
  fail "Backend HPA must not render when database mode is disabled."
fi

echo "Helm platform rendering checks passed."
