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
test_pod_render="$(mktemp)"
gw_xff_render="$(mktemp)"
trusted_ip_blank_render="$(mktemp)"
trusted_ip_padded_render="$(mktemp)"
openrouter_render="$(mktemp)"
trap 'rm -f "${route_render}" "${auth_render}" "${auth_guard_render}" "${auth_disabled_render}" "${lb_render}" "${lb_no_db_render}" "${ingress_render}" "${gw_render}" "${hostless_render}" "${legacy_kv_render}" "${gw_bad_scheme_err}" "${gw_missing_host_err}" "${gw_route_host_bypass_err}" "${gw_ingress_host_bypass_err}" "${gw_whitespace_host_err}" "${test_pod_render}" "${gw_xff_render}" "${trusted_ip_blank_render}" "${trusted_ip_padded_render}" "${openrouter_render}"' EXIT

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

backend_hpa_default="$(
  helm template sre-simulator "${CHART_DIR}" \
    --show-only templates/backend-hpa.yaml \
    --set backend.autoscaling.enabled=true \
    --set database.enabled=true \
    --set database.existingSecretName=sre-sql-creds
)"
grep -Eq '^[[:space:]]+name: cpu$' <<<"${backend_hpa_default}" || \
  fail "Backend HPA should scale on CPU by default."
if grep -Eq '^[[:space:]]+name: memory$' <<<"${backend_hpa_default}"; then
  fail "Backend HPA should not scale on memory by default."
fi

backend_hpa_memory="$(
  helm template sre-simulator "${CHART_DIR}" \
    --show-only templates/backend-hpa.yaml \
    --set backend.autoscaling.enabled=true \
    --set backend.autoscaling.targetMemoryUtilizationPercentage=75 \
    --set database.enabled=true \
    --set database.existingSecretName=sre-sql-creds
)"
grep -Eq '^[[:space:]]+name: cpu$' <<<"${backend_hpa_memory}" || \
  fail "Backend HPA memory opt-in should preserve CPU scaling."
grep -Eq '^[[:space:]]+name: memory$' <<<"${backend_hpa_memory}" || \
  fail "Backend HPA should render the memory metric when explicitly configured."

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

# The AKS edge is a Layer-4 Azure Load Balancer that never sets
# X-Forwarded-For, so trusting that header would let any caller forge a client
# IP. Envoy must derive the client IP from the connection source address
# instead, which is its behaviour when no xForwardedFor policy is rendered.
if grep -Eq '^kind: ClientTrafficPolicy$' "${gw_render}"; then
  fail "Gateway mode must not trust X-Forwarded-For by default."
fi

if grep -Eq 'xForwardedFor:' "${gw_render}"; then
  fail "Gateway mode must not configure X-Forwarded-For client IP detection by default."
fi

helm template sre-simulator "${CHART_DIR}" \
  --set exposure.mode=gateway \
  --set-string exposure.host="play.sresimulator.osadev.cloud" \
  --set gateway.className=eg \
  --set gateway.clientIpDetection.trustXForwardedFor=true >"${gw_xff_render}"

grep -Eq '^kind: ClientTrafficPolicy$' "${gw_xff_render}" || \
  fail "Opting into X-Forwarded-For trust should render a ClientTrafficPolicy."

grep -Eq 'numTrustedHops: 1' "${gw_xff_render}" || \
  fail "Opting into X-Forwarded-For trust should trust only the immediate edge hop."

grep -Eq 'type: ClusterIP' "${gw_render}" || \
  fail "Gateway mode should keep the frontend Service internal."

restricted_container_count="$(
  grep -Ec 'allowPrivilegeEscalation: false' "${gw_render}"
)"
if [[ "${restricted_container_count}" -lt 2 ]]; then
  fail "Frontend and backend containers should disable privilege escalation."
fi

restricted_capability_count="$(
  grep -Ec '^[[:space:]]+- ALL$' "${gw_render}"
)"
if [[ "${restricted_capability_count}" -lt 2 ]]; then
  fail "Frontend and backend containers should drop all Linux capabilities."
fi

restricted_pod_count="$(grep -Ec 'runAsNonRoot: true' "${gw_render}")"
if [[ "${restricted_pod_count}" -lt 2 ]]; then
  fail "Frontend and backend Pods should require non-root containers."
fi

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

# The helm-test pod's NetworkPolicy wait must finish inside the timeout its
# callers give `helm test`. The bound has to be wall clock, not an attempt
# count: measured in curlimages/curl:8.13.0, the same 6-attempt loop takes
# 12.4s when the peer rejects instantly (the kube-router race this wait exists
# for) and 42.5s when the peer blackholes and every curl runs to --max-time.
# At the shipped iteration count that is ~2 minutes versus ~7, and only the
# second one blows the caller's budget -- so a loop that reads as safe is the
# one that silently turns a reportable failure into a bare Helm timeout.
helm template sre-simulator "${CHART_DIR}" \
  --show-only templates/tests/test-connection.yaml >"${test_pod_render}"

# `|| true`: under `set -euo pipefail` a grep that matches nothing exits 1 and
# takes the script down inside the command substitution, before the explicit
# check below can name what is wrong.
wait_deadline="$(grep -Eo 'DEADLINE_SECONDS=[0-9]+' "${test_pod_render}" | head -1 | cut -d= -f2 || true)"
[ -n "${wait_deadline}" ] || \
  fail "The helm-test NetworkPolicy wait must be bounded by a wall-clock deadline, not an attempt count."

if grep -Eq '\[ "\$\{attempt\}" -lt [0-9]+ \]' "${test_pod_render}"; then
  fail "The helm-test wait must not loop on an attempt count; a blackholed peer makes its wall time unbounded."
fi

helm_test_timeout_minutes="$(grep -Eo 'helm test [^|]*--timeout ([0-9]+)m' \
  "${ROOT_DIR}/.github/workflows/helm-integration.yml" | grep -Eo '[0-9]+m$' | tr -d m | head -1 || true)"
[ -n "${helm_test_timeout_minutes}" ] || \
  fail "Could not read the helm test timeout from .github/workflows/helm-integration.yml."

# ci.yml's free-e2e gate is the second caller, and it is the one that runs on
# k3s, where the kube-router race this wait absorbs actually happens. Its
# invocation spans several lines, so the flag is read out of the step block
# rather than off the `helm test` line.
free_e2e_timeout_minutes="$(awk '/^      - name: Helm test$/,/^      - name: Collect diagnostics$/' \
  "${ROOT_DIR}/.github/workflows/ci.yml" | grep -Eo -- '--timeout [0-9]+m' | grep -Eo '[0-9]+' | head -1 || true)"
[ -n "${free_e2e_timeout_minutes}" ] || \
  fail "Could not read the free-e2e helm test timeout from .github/workflows/ci.yml."

if [ "${free_e2e_timeout_minutes}" -lt "${helm_test_timeout_minutes}" ]; then
  helm_test_timeout_minutes="${free_e2e_timeout_minutes}"
fi

# A final iteration can overshoot the deadline by --max-time plus the sleep,
# and the pod still has to pull its image and run the assertions afterwards.
if [ "$(( wait_deadline + 60 ))" -ge "$(( helm_test_timeout_minutes * 60 ))" ]; then
  fail "The wait deadline (${wait_deadline}s) leaves under 60s of the ${helm_test_timeout_minutes}m helm test timeout for image pull and the assertions."
fi

# frontend.trustedClientIpHeader follows the chart's `| default "" | trim`
# idiom. Without the trim, Go templates treat " " as a truthy string: the env
# var renders with a whitespace value, the frontend trims it back to empty and
# silently falls back to the Envoy default, so an operator's typo reads as a
# working override. Whitespace must render nothing at all, and a padded value
# must reach the container already trimmed.
helm template sre-simulator "${CHART_DIR}" \
  --set exposure.mode=route \
  --set exposure.host=route.example.com \
  --set-string frontend.trustedClientIpHeader="   " >"${trusted_ip_blank_render}"

if grep -Fq 'TRUSTED_CLIENT_IP_HEADER' "${trusted_ip_blank_render}"; then
  fail "A whitespace-only frontend.trustedClientIpHeader must render no env var."
fi

helm template sre-simulator "${CHART_DIR}" \
  --set exposure.mode=route \
  --set exposure.host=route.example.com \
  --set-string frontend.trustedClientIpHeader="  x-real-ip  " >"${trusted_ip_padded_render}"

grep -Fq 'value: "x-real-ip"' "${trusted_ip_padded_render}" || \
  fail "frontend.trustedClientIpHeader must reach the container trimmed."

# ---------------------------------------------------------------------------
# OpenRouter env wiring
# ---------------------------------------------------------------------------
if grep -Fq 'AI_OPENROUTER' "${route_render}"; then
  fail "Every ai.openrouter field is empty by default; no AI_OPENROUTER_* variable may render."
fi

helm template sre-simulator "${CHART_DIR}" \
  --set exposure.mode=ingress \
  --set exposure.host=ingress.example.com \
  --set exposure.scheme=https \
  --set-string ai.openrouter.baseUrl=https://openrouter.example/api/v1 \
  --set-string ai.openrouter.model=vendor/base:free \
  --set-string ai.openrouter.routeModels.chat=vendor/chat:free \
  --set-string ai.openrouter.routeModels.command=vendor/command:free \
  --set-string ai.openrouter.siteUrl=https://sre.example \
  --set-string ai.openrouter.appTitle="SRE Simulator" \
  --set ai.openrouter.credentials.existingSecretName=openrouter-api \
  --set-string ai.openrouter.credentials.key=token >"${openrouter_render}"

for entry in \
  'AI_OPENROUTER_BASE_URL: "https://openrouter.example/api/v1"' \
  'AI_OPENROUTER_MODEL: "vendor/base:free"' \
  'AI_OPENROUTER_MODEL_CHAT: "vendor/chat:free"' \
  'AI_OPENROUTER_MODEL_COMMAND: "vendor/command:free"' \
  'AI_OPENROUTER_SITE_URL: "https://sre.example"' \
  'AI_OPENROUTER_APP_TITLE: "SRE Simulator"'; do
  grep -Fq "${entry}" "${openrouter_render}" || \
    fail "The ConfigMap should carry ${entry%%:*}."
done

# scenario and probe were deliberately left unset: the backend falls back to
# the command model and then to the base model, so rendering them empty would
# override that chain with an empty string.
if grep -Eq 'AI_OPENROUTER_MODEL_(SCENARIO|PROBE)' "${openrouter_render}"; then
  fail "An unset route model must render no variable at all, not an empty one."
fi

# The API key is the one OpenRouter value that is a credential. It must arrive
# by secretKeyRef; a ConfigMap entry would put it in plain `kubectl get cm`.
if grep -Eq '^  AI_OPENROUTER_API_KEY:' "${openrouter_render}"; then
  fail "AI_OPENROUTER_API_KEY must never be a ConfigMap entry."
fi

grep -Fq -e '- name: AI_OPENROUTER_API_KEY' "${openrouter_render}" || \
  fail "An ai.openrouter.credentials.existingSecretName should wire AI_OPENROUTER_API_KEY into the backend."

grep -A 4 -e '- name: AI_OPENROUTER_API_KEY' "${openrouter_render}" | grep -Fq 'name: openrouter-api' || \
  fail "AI_OPENROUTER_API_KEY should read from the configured existing secret."

grep -A 4 -e '- name: AI_OPENROUTER_API_KEY' "${openrouter_render}" | grep -Fq 'key: token' || \
  fail "AI_OPENROUTER_API_KEY should read the configured secret key."

echo "Helm platform rendering checks passed."
