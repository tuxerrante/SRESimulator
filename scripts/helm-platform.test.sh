#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="${ROOT_DIR}/helm/sre-simulator"

route_render="$(mktemp)"
auth_render="$(mktemp)"
auth_guard_render="$(mktemp)"
auth_disabled_render="$(mktemp)"
lb_render="$(mktemp)"
lb_no_db_render="$(mktemp)"
ingress_render="$(mktemp)"
gw_render="$(mktemp)"
hostless_render="$(mktemp)"
legacy_kv_render="$(mktemp)"
gw_bad_scheme_err="$(mktemp)"
gw_missing_host_err="$(mktemp)"
gw_route_host_bypass_err="$(mktemp)"
gw_ingress_host_bypass_err="$(mktemp)"
gw_whitespace_host_err="$(mktemp)"
trap 'rm -f "${route_render}" "${auth_render}" "${auth_guard_render}" "${auth_disabled_render}" "${lb_render}" "${lb_no_db_render}" "${ingress_render}" "${gw_render}" "${hostless_render}" "${legacy_kv_render}" "${gw_bad_scheme_err}" "${gw_missing_host_err}" "${gw_route_host_bypass_err}" "${gw_ingress_host_bypass_err}" "${gw_whitespace_host_err}"' EXIT

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

grep -Eq 'haproxy\.router\.openshift\.io/set-forwarded-headers: replace' "${route_render}" || \
  fail "Route mode should replace untrusted forwarded headers."

grep -Fq 'FRONTEND="sre-simulator-frontend:3000"' "${route_render}" || \
  fail "Helm test should use the configured internal frontend Service port."

grep -Eq 'value: "https://route\.example\.com"' "${route_render}" || \
  fail "Route mode should derive backend CORS origin from the public route host."

grep -Eq 'AI_COMMAND_TIMEOUT_MS: "12000"' "${route_render}" || \
  fail "Backend command timeout should remain below the public edge request budget."

grep -Eq 'AI_SCENARIO_TIMEOUT_MS: "12000"' "${route_render}" || \
  fail "Backend scenario timeout should remain below the public edge request budget."

grep -Eq 'ALLOW_DEPLOYED_JSON_STORAGE_FOR_TESTS: "false"' "${route_render}" || \
  fail "Deployed JSON storage test mode must default to false."

helm template sre-simulator "${CHART_DIR}" \
  --set exposure.mode=route \
  --set exposure.host=route.example.com \
  --set ai.mockMode=true \
  --set backend.allowDeployedJsonStorageForTests=true >"${legacy_kv_render}"

grep -Eq 'ALLOW_DEPLOYED_JSON_STORAGE_FOR_TESTS: "true"' "${legacy_kv_render}" || \
  fail "Mock Helm integration should be able to opt into deployed JSON storage."

helm template sre-simulator "${CHART_DIR}" \
  --set exposure.mode=route \
  --set exposure.host=route.example.com \
  --set frontend.auth.existingSecretName=sre-auth-secrets >"${auth_render}"

grep -Eq 'name: GITHUB_CLIENT_ID' "${auth_render}" || \
  fail "Frontend auth should expose GITHUB_CLIENT_ID when auth secret is configured."

grep -Eq 'name: GITHUB_CLIENT_SECRET' "${auth_render}" || \
  fail "Frontend auth should expose GITHUB_CLIENT_SECRET when auth secret is configured."

grep -Eq 'name: AUTH_SESSION_SECRET' "${auth_render}" || \
  fail "Frontend auth should expose AUTH_SESSION_SECRET when auth secret is configured."

grep -Eq 'name: "?sre-auth-secrets"?' "${auth_render}" || \
  fail "Frontend auth env vars should reference the configured auth secret."

grep -Eq 'secretKeyRef:' "${auth_render}" || \
  fail "Frontend auth env vars should be populated via secretKeyRef."

grep -Eq 'key: "github-client-id"' "${auth_render}" || \
  fail "Frontend auth should reference the configured github client id key."

grep -Eq 'key: "github-client-secret"' "${auth_render}" || \
  fail "Frontend auth should reference the configured github client secret key."

grep -Eq 'key: "auth-session-secret"' "${auth_render}" || \
  fail "Frontend auth should reference the configured auth session secret key."

helm template sre-simulator "${CHART_DIR}" \
  --set exposure.mode=route \
  --set exposure.host=e2e.example.com \
  --set frontend.auth.existingSecretName=sre-e2e-auth-secrets \
  --set frontend.auth.githubCallbackUrlKey=github-callback-url \
  --set frontend.auth.requireGithubCallbackMatch=true >"${auth_guard_render}"

grep -Eq 'name: GITHUB_OAUTH_CALLBACK_URL' "${auth_guard_render}" || \
  fail "Frontend auth should expose the callback declaration when configured."

grep -Eq 'key: "github-callback-url"' "${auth_guard_render}" || \
  fail "Frontend auth should reference the configured callback URL key."

grep -A1 -E 'name: GITHUB_OAUTH_REQUIRE_CALLBACK_MATCH[[:space:]]*$' "${auth_guard_render}" | \
  grep -Fq 'value: "true"' || \
  fail "Frontend auth should enable callback verification when requested."

helm template sre-simulator "${CHART_DIR}" \
  --set exposure.mode=route \
  --set exposure.host=e2e.example.com \
  --set frontend.auth.existingSecretName=sre-auth-secrets \
  --set frontend.auth.githubOAuthEnabled=false \
  --set frontend.auth.requireGithubCallbackMatch=true >"${auth_disabled_render}"

if grep -Eq 'name: GITHUB_CLIENT_(ID|SECRET)' "${auth_disabled_render}"; then
  fail "Frontend auth should omit GitHub OAuth credentials when OAuth is disabled."
fi

grep -Eq 'name: AUTH_SESSION_SECRET' "${auth_disabled_render}" || \
  fail "Disabling GitHub OAuth must preserve the signed session secret."

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

grep -Fq 'FRONTEND="sre-simulator-frontend:80"' "${lb_render}" || \
  fail "Helm test should use frontend Service port 80 in publicService mode."

if grep -Eq '^kind: Ingress$' "${lb_render}"; then
  fail "AKS mode must not render a Kubernetes Ingress."
fi

if grep -Eq '^kind: Route$' "${lb_render}"; then
  fail "AKS mode must not render an OpenShift Route."
fi

grep -Eq 'value: "http://public\.example\.com"' "${lb_render}" || \
  fail "Public service mode should derive backend CORS origin from exposure.host and exposure.scheme."

helm template sre-simulator "${CHART_DIR}" \
  --set exposure.mode=ingress \
  --set exposure.host=ingress.example.com \
  --set exposure.scheme=https \
  --set ingress.className=nginx \
  --set ingress.tls.enabled=true \
  --set ingress.tls.secretName=sre-simulator-ingress-tls >"${ingress_render}"

grep -Eq '^kind: Ingress$' "${ingress_render}" || \
  fail "Ingress mode should render a Kubernetes Ingress resource."

grep -Eq 'host: ingress\.example\.com' "${ingress_render}" || \
  fail "Ingress mode should preserve the ingress host."

grep -Eq 'secretName: sre-simulator-ingress-tls' "${ingress_render}" || \
  fail "Ingress mode should render the configured TLS secret."

grep -Eq 'value: "https://ingress\.example\.com"' "${ingress_render}" || \
  fail "Ingress mode should derive backend CORS origin from the ingress host."

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

grep -Eq '^kind: ClientTrafficPolicy$' "${gw_render}" || \
  fail "Gateway mode should render trusted client IP detection."

grep -A2 -Eq 'xForwardedFor:' "${gw_render}" || \
  fail "Gateway mode should configure X-Forwarded-For client IP detection."

grep -Eq 'numTrustedHops: 1' "${gw_render}" || \
  fail "Gateway mode should trust only the immediate edge hop."

grep -Eq 'type: ClusterIP' "${gw_render}" || \
  fail "Gateway mode should keep the frontend Service internal."

if grep -Eq 'type: LoadBalancer' "${gw_render}"; then
  fail "Gateway mode must not expose the frontend directly as a LoadBalancer."
fi

grep -Eq 'hostname: "play\.sresimulator\.osadev\.cloud"' "${gw_render}" || \
  fail "Gateway mode should trim surrounding whitespace from rendered Gateway hostnames."

grep -Eq '^[[:space:]]+- "play\.sresimulator\.osadev\.cloud"$' "${gw_render}" || \
  fail "Gateway mode should trim surrounding whitespace from rendered HTTPRoute hostnames."

grep -Eq 'value: /api/scenario' "${gw_render}" || \
  fail "Gateway mode should render a dedicated scenario API route."

grep -Eq 'request: "30s"' "${gw_render}" || \
  fail "Gateway mode should keep scenario requests above the backend fallback budget."

grep -Eq 'value: "https://play\.sresimulator\.osadev\.cloud"' "${gw_render}" || \
  fail "Gateway mode should derive a HTTPS public origin for backend CORS."

helm template sre-simulator "${CHART_DIR}" \
  --set exposure.mode=none \
  --set-string exposure.host= \
  --set frontend.port=3100 >"${hostless_render}"

grep -Eq 'value: "http://localhost:3100"' "${hostless_render}" || \
  fail "Hostless exposure modes should derive backend CORS origin from the frontend port."

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
