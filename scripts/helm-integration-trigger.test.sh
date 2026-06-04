#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOW_FILE="${ROOT_DIR}/.github/workflows/helm-integration.yml"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

if [[ ! -f "${WORKFLOW_FILE}" ]]; then
  fail "Expected workflow file at ${WORKFLOW_FILE}"
fi

if ! rg -q '^[[:space:]]+push:[[:space:]]*$' "${WORKFLOW_FILE}"; then
  fail "Helm integration workflow must define a push trigger."
fi

if ! rg -q '^[[:space:]]+branches:[[:space:]]*\[main\][[:space:]]*$' "${WORKFLOW_FILE}"; then
  fail "Helm integration workflow push trigger must target main."
fi

# If a paths filter is ever added back, it must include scripts/**
if rg -q '^[[:space:]]+paths:[[:space:]]*$' "${WORKFLOW_FILE}"; then
  if ! rg -q '^[[:space:]]+-[[:space:]]+"?scripts/\*\*"?[[:space:]]*$' "${WORKFLOW_FILE}"; then
    fail "When push.paths is configured, scripts/** must be included."
  fi
fi

echo "Helm integration trigger checks passed."
