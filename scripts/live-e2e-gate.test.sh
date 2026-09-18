#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOW="$ROOT_DIR/.github/workflows/ci.yml"
DEPENDABOT_BUILD_WORKFLOW="$ROOT_DIR/.github/workflows/dependabot-e2e-build.yml"
DEPENDABOT_WORKFLOW="$ROOT_DIR/.github/workflows/dependabot-e2e.yml"
MAKEFILE="$ROOT_DIR/Makefile"
CI_K3D_VALUES="$ROOT_DIR/helm/sre-simulator/values-ci-k3d.yaml"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local expected=$1 file=$2
  grep -Fq -- "$expected" "$file" || \
    fail "expected '$expected' in $file"
}

assert_not_contains() {
  local unexpected=$1 file=$2
  if grep -Fq -- "$unexpected" "$file"; then
    fail "did not expect '$unexpected' in $file"
  fi
}

node --check "$ROOT_DIR/scripts/playwright-live-e2e.mjs"
assert_contains "Promise.allSettled" "$ROOT_DIR/scripts/playwright-live-e2e.mjs"
assert_contains "Parallel users did not receive distinct scenarios" "$ROOT_DIR/scripts/playwright-live-e2e.mjs"

assert_contains "live-e2e:" "$WORKFLOW"
assert_contains "name: live-e2e" "$WORKFLOW"
assert_contains "github.event.pull_request.head.repo.full_name == github.repository" "$WORKFLOW"
assert_contains "github.event.pull_request.user.login != 'dependabot[bot]'" "$WORKFLOW"
assert_contains "github.event.pull_request.user.login == 'dependabot[bot]'" "$WORKFLOW"
assert_not_contains "github.actor != 'dependabot[bot]'" "$WORKFLOW"
assert_not_contains "github.actor == 'dependabot[bot]'" "$WORKFLOW"
assert_contains "E2E_NAMESPACE_PREFIX: sre-pr-" "$WORKFLOW"
assert_contains 'group: sresimulator-live-e2e-pr-${{ github.event.pull_request.number }}' "$WORKFLOW"
assert_contains "make test-e2e-live" "$WORKFLOW"
assert_contains "make e2e-azure-route-down" "$WORKFLOW"
assert_contains "LIVE_E2E_RESULT:" "$WORKFLOW"
assert_contains 'failed_jobs+=("live-e2e (${LIVE_E2E_RESULT})")' "$WORKFLOW"
assert_contains 'select(.context == "dependabot-e2e")' "$WORKFLOW"
assert_contains '"on":' "$DEPENDABOT_BUILD_WORKFLOW"
assert_contains "pull_request:" "$DEPENDABOT_BUILD_WORKFLOW"
assert_contains "permissions:" "$DEPENDABOT_BUILD_WORKFLOW"
assert_contains "contents: read" "$DEPENDABOT_BUILD_WORKFLOW"
assert_contains "Checkout Dependabot head without credentials" "$DEPENDABOT_BUILD_WORKFLOW"
assert_contains "Build unprivileged PR image artifact" "$DEPENDABOT_BUILD_WORKFLOW"
assert_contains 'ghcr.io/${{ github.repository_owner }}/sre-simulator-' \
  "$DEPENDABOT_BUILD_WORKFLOW"
assert_not_contains "ghcr.io/tuxerrante/" "$DEPENDABOT_BUILD_WORKFLOW"
assert_contains "Upload immutable image artifact" "$DEPENDABOT_BUILD_WORKFLOW"
assert_contains "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a" \
  "$DEPENDABOT_BUILD_WORKFLOW"
assert_contains 'workflows: ["Dependabot E2E Build"]' "$DEPENDABOT_WORKFLOW"
assert_contains "author" "$DEPENDABOT_WORKFLOW"
assert_contains 'dependabot[bot]' "$DEPENDABOT_WORKFLOW"
assert_contains "environment:" "$DEPENDABOT_WORKFLOW"
assert_contains "name: dependabot-e2e" "$DEPENDABOT_WORKFLOW"
assert_contains "DEPENDABOT_E2E_KUBECONFIG" "$DEPENDABOT_WORKFLOW"
assert_contains "for verb in get list watch" "$DEPENDABOT_WORKFLOW"
assert_contains 'kubectl auth can-i "${verb}" secrets' "$DEPENDABOT_WORKFLOW"
assert_contains "E2E identity must not" "$DEPENDABOT_WORKFLOW"
assert_contains "Unable to verify" "$DEPENDABOT_WORKFLOW"
assert_contains 'ghcr.io/${{ github.repository_owner }}/sre-simulator-frontend' \
  "$DEPENDABOT_WORKFLOW"
assert_not_contains "ghcr.io/tuxerrante/" "$DEPENDABOT_WORKFLOW"
assert_contains "Download unprivileged image artifact" "$DEPENDABOT_WORKFLOW"
assert_contains "Validate and load image artifact" "$DEPENDABOT_WORKFLOW"
assert_contains "Login to GHCR after artifact validation" "$DEPENDABOT_WORKFLOW"
assert_contains "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a" \
  "$DEPENDABOT_WORKFLOW"
assert_contains "SOURCE_BUILD_RESULT:" "$DEPENDABOT_WORKFLOW"
assert_contains "Unprivileged image build failed" "$DEPENDABOT_WORKFLOW"
assert_contains 'echo "::add-mask::${anti_abuse_secret}"' \
  "$DEPENDABOT_WORKFLOW"
assert_contains 'KUBECONFIG=${RUNNER_TEMP}/dependabot-e2e-kubeconfig' \
  "$DEPENDABOT_WORKFLOW"
assert_not_contains "Checkout Dependabot head" "$DEPENDABOT_WORKFLOW"
assert_not_contains "docker/build-push-action" "$DEPENDABOT_WORKFLOW"
assert_not_contains '${{ runner.temp }}/dependabot-e2e-kubeconfig' \
  "$DEPENDABOT_WORKFLOW"
assert_not_contains "043fb46d1a93c77aae656e7c1c64a875d1fc6a0b" \
  "$DEPENDABOT_WORKFLOW"
assert_contains "dependabot-e2e-default-deny-egress" "$DEPENDABOT_WORKFLOW"
assert_contains '[[ "${state}" != "open" ]]' "$DEPENDABOT_WORKFLOW"
assert_contains '[[ "${head_sha}" != "${WORKFLOW_HEAD_SHA}" ]]' "$DEPENDABOT_WORKFLOW"
assert_contains "ai.mockMode=true" "$DEPENDABOT_WORKFLOW"
assert_contains "database.enabled=false" "$DEPENDABOT_WORKFLOW"
assert_contains "storage.enabled=false" "$DEPENDABOT_WORKFLOW"
assert_contains "turnstile-secret-key" "$DEPENDABOT_WORKFLOW"
assert_contains "sre-simulator" "$DEPENDABOT_WORKFLOW"
assert_contains "dependabot-e2e-runtime" "$DEPENDABOT_WORKFLOW"
assert_contains "context=dependabot-e2e" "$DEPENDABOT_WORKFLOW"
# Chart resource names come from sre-simulator.fullname, which prefixes the
# release name with the chart name unless the release name already contains it.
# The browser step port-forwards "${E2E_RELEASE}-frontend", so the chart must be
# pinned to the release name or the service does not exist.
assert_contains 'fullnameOverride=${E2E_RELEASE}' "$DEPENDABOT_WORKFLOW"
assert_contains 'create pods/portforward' "$DEPENDABOT_WORKFLOW"

# --- free-e2e: the credential-free k3d browser gate -------------------------
# live-e2e stays in the workflow (and keeps every assertion above green) but
# only runs when vars.LIVE_E2E_ENABLED is set, so free-e2e is what actually
# blocks merges.
assert_contains "free-e2e:" "$WORKFLOW"
assert_contains "vars.LIVE_E2E_ENABLED == 'true'" "$WORKFLOW"
assert_contains 'FREE_E2E_RESULT: ${{ needs.free-e2e.result }}' "$WORKFLOW"
assert_contains 'LIVE_E2E_ENABLED: ${{ vars.LIVE_E2E_ENABLED }}' "$WORKFLOW"
assert_contains 'failed_jobs+=("free-e2e (${FREE_E2E_RESULT})")' "$WORKFLOW"
assert_contains "values-oci.yaml" "$WORKFLOW"
assert_contains "values-ci-k3d.yaml" "$WORKFLOW"

# The gate host must stay a *.localhost name in both the workflow and the
# overlay it deploys. Only loopback and *.localhost are browser secure
# contexts; off one, Chromium hides crypto.randomUUID and crypto.subtle, which
# the chat and the anonymous fingerprint call unguarded, and the suite then
# times out with no 5xx, no failed request and no console error.
assert_contains "E2E_HOST: sre-simulator.localhost" "$WORKFLOW"
assert_contains 'LIVE_E2E_BASE_URL: http://${{ env.E2E_HOST }}' "$WORKFLOW"
assert_contains "host: sre-simulator.localhost" "$CI_K3D_VALUES"

# dependabot-e2e needs the AKS cluster, so ci-gate must only wait on its status
# when the path is explicitly switched on. Without the guard every bot PR polls
# a status that can never arrive.
assert_contains 'DEPENDABOT_E2E_ENABLED: ${{ vars.DEPENDABOT_E2E_ENABLED }}' \
  "$WORKFLOW"
assert_contains '"${DEPENDABOT_E2E_ENABLED}" == "true" ]]; then' "$WORKFLOW"

# The whole point of free-e2e is that it needs nothing privileged: no GitHub
# Environment, no cloud login, no repository secret. Assert that block-scoped,
# because a `secrets.` reference anywhere else in ci.yml is legitimate.
free_e2e_block="$(
  awk '
    /^  free-e2e:$/ { inside = 1 }
    inside && /^  [a-z0-9-]+:$/ && !/^  free-e2e:$/ { inside = 0 }
    inside { print }
  ' "$WORKFLOW"
)"
[[ -n "$free_e2e_block" ]] || fail "could not extract the free-e2e job block"
for forbidden in "secrets." "environment:" "azure/login"; do
  if grep -Fq -- "$forbidden" <<<"$free_e2e_block"; then
    fail "free-e2e must stay credential-free but references '$forbidden'"
  fi
done

# The job block is only half of the job. A composite action it `uses:` runs in
# the same runner with the same permissions, so a credential could be picked up
# there instead and the block-scoped scan above would never see it. Follow every
# local action the block references and scan it too. `environment:` is not
# checked in action files: it is a job-level key that cannot appear there, and
# the word occurs in prose ("environment variable") in one of the descriptions.
free_e2e_actions="$(
  grep -Eo 'uses: \./[^[:space:]]+' <<<"$free_e2e_block" |
    sed 's|^uses: \./||' | sort -u
)"
[[ -n "$free_e2e_actions" ]] || \
  fail "expected free-e2e to reuse the repository's composite actions"
while IFS= read -r action_dir; do
  action_file="$ROOT_DIR/$action_dir/action.yml"
  [[ -f "$action_file" ]] || action_file="$ROOT_DIR/$action_dir/action.yaml"
  [[ -f "$action_file" ]] || \
    fail "free-e2e uses ./$action_dir but no action.yml exists there"
  for forbidden in "secrets." "azure/login"; do
    if grep -Fq -- "$forbidden" "$action_file"; then
      fail "free-e2e runs ./$action_dir, which references '$forbidden'"
    fi
  done
done <<<"$free_e2e_actions"
grep -Fq -- "make test-e2e-live" <<<"$free_e2e_block" || \
  fail "free-e2e must run the browser suite via make test-e2e-live"

assert_contains "playwright-install:" "$MAKEFILE"
assert_contains "test-e2e-live:" "$MAKEFILE"
assert_contains "LIVE_E2E_AUTH_SESSION_SECRET is required." "$MAKEFILE"

echo "live E2E gate checks passed."
