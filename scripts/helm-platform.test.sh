#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="${ROOT_DIR}/helm/sre-simulator"

route_render="$(mktemp)"
lb_render="$(mktemp)"
lb_no_db_render="$(mktemp)"
gw_render="$(mktemp)"
legacy_kv_render="$(mktemp)"
gw_bad_scheme_err="$(mktemp)"
gw_missing_host_err="$(mktemp)"
gw_route_host_bypass_err="$(mktemp)"
gw_ingress_host_bypass_err="$(mktemp)"
gw_whitespace_host_err="$(mktemp)"
trap 'rm -f "${route_render}" "${lb_render}" "${lb_no_db_render}" "${gw_render}" "${legacy_kv_render}" "${gw_bad_scheme_err}" "${gw_missing_host_err}" "${gw_route_host_bypass_err}" "${gw_ingress_host_bypass_err}" "${gw_whitespace_host_err}"' EXIT

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
  --set exposure.mode=gateway \
  --set-string exposure.host="  play.sresimulator.osadev.cloud  " \
  --set exposure.scheme=https \
  --set gateway.className=eg \
  --set gateway.tls.secretName=sre-simulator-gateway-tls \
  --set gateway.certManager.clusterIssuer=letsencrypt-azuredns-prod \
  --set gateway.envoyProxy.name=sre-simulator-public-edge >"${gw_render}"

grep -Eq '^kind: Gateway$' "${gw_render}" || \
  fail "Gateway mode should render a Gateway resource."

grep -Eq '^kind: HTTPRoute$' "${gw_render}" || \
  fail "Gateway mode should render HTTPRoute resources."

grep -Eq 'type: ClusterIP' "${gw_render}" || \
  fail "Gateway mode should keep the frontend Service internal."

if grep -Eq 'type: LoadBalancer' "${gw_render}"; then
  fail "Gateway mode must not expose the frontend directly as a LoadBalancer."
fi

grep -Eq 'hostname: "play\.sresimulator\.osadev\.cloud"' "${gw_render}" || \
  fail "Gateway mode should trim surrounding whitespace from rendered Gateway hostnames."

grep -Eq '^[[:space:]]+- "play\.sresimulator\.osadev\.cloud"$' "${gw_render}" || \
  fail "Gateway mode should trim surrounding whitespace from rendered HTTPRoute hostnames."

grep -Eq 'value: "https://play\.sresimulator\.osadev\.cloud"' "${gw_render}" || \
  fail "Gateway mode should derive a HTTPS public origin for backend CORS."

if helm template sre-simulator "${CHART_DIR}" \
  --set exposure.mode=gateway \
  --set exposure.host=play.sresimulator.osadev.cloud \
  --set exposure.scheme=http \
  --set gateway.className=eg \
  --set gateway.tls.secretName=sre-simulator-gateway-tls \
  --set gateway.certManager.clusterIssuer=letsencrypt-azuredns-prod \
  --set gateway.envoyProxy.name=sre-simulator-public-edge > /dev/null 2>"${gw_bad_scheme_err}"; then
  fail "Gateway mode must reject non-HTTPS exposure.scheme overrides."
fi

grep -Eq 'exposure\.scheme must be empty or https when exposure\.mode=gateway' "${gw_bad_scheme_err}" || \
  fail "Gateway mode should fail with a clear scheme validation error."

if helm template sre-simulator "${CHART_DIR}" \
  --set exposure.mode=gateway \
  --set-string exposure.host= \
  --set gateway.className=eg \
  --set gateway.tls.secretName=sre-simulator-gateway-tls \
  --set gateway.certManager.clusterIssuer=letsencrypt-azuredns-prod \
  --set gateway.envoyProxy.name=sre-simulator-public-edge > /dev/null 2>"${gw_missing_host_err}"; then
  fail "Gateway mode must require exposure.host."
fi

grep -Eq 'exposure\.host is required when exposure\.mode=gateway' "${gw_missing_host_err}" || \
  fail "Gateway mode should fail with a clear host validation error."

if helm template sre-simulator "${CHART_DIR}" \
  --set exposure.mode=gateway \
  --set-string exposure.host="   " \
  --set gateway.className=eg \
  --set gateway.tls.secretName=sre-simulator-gateway-tls \
  --set gateway.certManager.clusterIssuer=letsencrypt-azuredns-prod \
  --set gateway.envoyProxy.name=sre-simulator-public-edge > /dev/null 2>"${gw_whitespace_host_err}"; then
  fail "Gateway mode must reject whitespace-only exposure.host."
fi

grep -Eq 'exposure\.host is required when exposure\.mode=gateway' "${gw_whitespace_host_err}" || \
  fail "Gateway mode should fail with a clear validation error for whitespace-only hosts."

if helm template sre-simulator "${CHART_DIR}" \
  --set exposure.mode=gateway \
  --set-string exposure.host= \
  --set route.host=legacy-route.example.com \
  --set gateway.className=eg \
  --set gateway.tls.secretName=sre-simulator-gateway-tls \
  --set gateway.certManager.clusterIssuer=letsencrypt-azuredns-prod \
  --set gateway.envoyProxy.name=sre-simulator-public-edge > /dev/null 2>"${gw_route_host_bypass_err}"; then
  fail "Gateway mode must not fall back to route.host when exposure.host is blank."
fi

grep -Eq 'exposure\.host is required when exposure\.mode=gateway' "${gw_route_host_bypass_err}" || \
  fail "Gateway mode should reject route.host as a host fallback bypass."

if helm template sre-simulator "${CHART_DIR}" \
  --set exposure.mode=gateway \
  --set-string exposure.host= \
  --set ingress.host=legacy-ingress.example.com \
  --set gateway.className=eg \
  --set gateway.tls.secretName=sre-simulator-gateway-tls \
  --set gateway.certManager.clusterIssuer=letsencrypt-azuredns-prod \
  --set gateway.envoyProxy.name=sre-simulator-public-edge > /dev/null 2>"${gw_ingress_host_bypass_err}"; then
  fail "Gateway mode must not fall back to ingress.host when exposure.host is blank."
fi

grep -Eq 'exposure\.host is required when exposure\.mode=gateway' "${gw_ingress_host_bypass_err}" || \
  fail "Gateway mode should reject ingress.host as a host fallback bypass."

helm template sre-simulator "${CHART_DIR}" \
  --set keyvault.name=legacy-vault \
  --set keyvault.tenantId=00000000-0000-0000-0000-000000000000 >"${legacy_kv_render}"

if grep -Eq '^kind: SecretProviderClass$' "${legacy_kv_render}"; then
  fail "The chart must not render the legacy Key Vault SecretProviderClass path."
fi

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
