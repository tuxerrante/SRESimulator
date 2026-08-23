#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOW="$ROOT_DIR/.github/workflows/ci.yml"
DEPENDABOT_BUILD_WORKFLOW="$ROOT_DIR/.github/workflows/dependabot-e2e-build.yml"
DEPENDABOT_WORKFLOW="$ROOT_DIR/.github/workflows/dependabot-e2e.yml"
MAKEFILE="$ROOT_DIR/Makefile"

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

assert_contains "playwright-install:" "$MAKEFILE"
assert_contains "test-e2e-live:" "$MAKEFILE"
assert_contains "LIVE_E2E_AUTH_SESSION_SECRET is required." "$MAKEFILE"

echo "live E2E gate checks passed."
