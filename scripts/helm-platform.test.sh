#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="${ROOT_DIR}/helm/sre-simulator"

route_render="$(mktemp)"
lb_render="$(mktemp)"
lb_no_db_render="$(mktemp)"
trap 'rm -f "${route_render}" "${lb_render}" "${lb_no_db_render}"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

helm template sre-simulator "${CHART_DIR}" \
  --set exposure.mode=route \
  --set exposure.host=route.example.com >"${route_render}"

grep -Eq '^kind: Route$' "${route_render}" || \
  fail "Route mode should render an OpenShift Route."

grep -Eq 'host: route\.example\.com' "${route_render}" || \
  fail "Route mode should preserve the route host."

grep -Eq 'value: "https://route\.example\.com"' "${route_render}" || \
  fail "Route mode should derive backend CORS origin from the public route host."

helm template sre-simulator "${CHART_DIR}" \
  --set exposure.mode=publicService \
  --set exposure.host=public.example.com \
  --set exposure.scheme=http \
  --set frontend.service.public.loadBalancerIP=203.0.113.10 \
  --set frontend.autoscaling.enabled=true \
  --set frontend.autoscaling.minReplicas=1 \
  --set frontend.autoscaling.maxReplicas=3 \
  --set backend.autoscaling.enabled=true \
  --set backend.autoscaling.minReplicas=1 \
  --set backend.autoscaling.maxReplicas=4 \
  --set database.enabled=true \
  --set database.existingSecretName=sre-sql-creds >"${lb_render}"

grep -Eq 'type: LoadBalancer' "${lb_render}" || \
  fail "AKS mode should render a public LoadBalancer service for the frontend."

grep -Eq 'loadBalancerIP: "?203\.0\.113\.10"?' "${lb_render}" || \
  fail "AKS mode should preserve the requested static public IP."

grep -Eq '^[[:space:]]+- port: 80$' "${lb_render}" || \
  fail "AKS public service mode should expose the frontend on port 80."

grep -Eq 'targetPort: 3000' "${lb_render}" || \
  fail "AKS public service mode should still target the frontend container port."

if grep -Eq '^kind: Ingress$' "${lb_render}"; then
  fail "AKS mode must not render a Kubernetes Ingress."
fi

if grep -Eq '^kind: Route$' "${lb_render}"; then
  fail "AKS mode must not render an OpenShift Route."
fi

grep -Eq 'value: "http://public\.example\.com"' "${lb_render}" || \
  fail "Public service mode should derive backend CORS origin from exposure.host and exposure.scheme."

frontend_hpa_count="$(grep -Ec '^kind: HorizontalPodAutoscaler$' "${lb_render}")"
if [[ "${frontend_hpa_count}" -lt 2 ]]; then
  fail "AKS mode with frontend/backend autoscaling enabled should render two HPAs."
fi

if grep -Eq '^  replicas:' "${lb_render}"; then
  fail "Autoscaled AKS deployments should omit spec.replicas so the HPA owns the scale subresource."
fi

checksum_count="$(grep -Ec 'checksum/config:' "${lb_render}" || true)"
if [[ "${checksum_count}" -lt 2 ]]; then
  fail "Autoscaled AKS deployments should include a config checksum annotation so config changes trigger rollouts."
fi

grep -Eq 'name: sre-simulator-frontend-hpa' "${lb_render}" || \
  fail "Frontend autoscaling should render the frontend HPA."

grep -Eq 'name: sre-simulator-backend-hpa' "${lb_render}" || \
  fail "Backend autoscaling with database mode should render the backend HPA."

helm template sre-simulator "${CHART_DIR}" \
  --set exposure.mode=publicService \
  --set exposure.host=public.example.com \
  --set exposure.scheme=http \
  --set frontend.service.public.loadBalancerIP=203.0.113.10 \
  --set backend.autoscaling.enabled=true \
  --set backend.autoscaling.minReplicas=2 \
  --set backend.autoscaling.maxReplicas=4 \
  --set database.enabled=false >"${lb_no_db_render}"

if grep -Eq 'name: sre-simulator-backend-hpa' "${lb_no_db_render}"; then
  fail "Backend HPA must not render when database mode is disabled."
fi

grep -Eq 'replicas: 1' "${lb_no_db_render}" || \
  fail "Backend replicas must stay at the fixed replica count when database mode is disabled."

echo "Helm platform rendering checks passed."
