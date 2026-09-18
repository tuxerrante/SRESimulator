#!/usr/bin/env bash
# Regression locks for the credential-free `terraform-validate` CI job and the
# infra/oci/ free-tier root it guards.
#
# The job is only useful if three properties hold, and all three are easy to
# break with a well-meaning edit:
#
#   1. ci-gate counts its result. ci-gate is the *only* status check the
#      branch ruleset requires, so a job missing from that aggregation is a
#      job nobody has to pass.
#   2. It stays credential-free. The moment it grows a `secrets.` reference it
#      can no longer run on fork PRs, and it acquires a blast radius that a
#      fmt/validate/test job has no business having.
#   3. infra/oci/traefik-config.yaml stays a single shared file. cloud-init
#      and the oci-shape-e2e job must consume the same bytes; a private copy
#      would green-light a Traefik config the box never runs.
#
# shellcheck disable=SC2016
# Every single-quoted string below is a literal to search for in another file,
# not a shell expression: `${{ needs... }}`, `$(date +%F)` and `$(OWNER_ALIAS)`
# are the exact bytes the workflow, the runbook and the makefile must contain.
# Expanding any of them here would assert on this script's environment instead
# of on the file under test, which is the one thing these checks must not do.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOW="$ROOT_DIR/.github/workflows/ci.yml"
GITIGNORE="$ROOT_DIR/.gitignore"
COMPUTE_TF="$ROOT_DIR/infra/oci/compute.tf"
TRAEFIK_CONFIG="$ROOT_DIR/infra/oci/traefik-config.yaml"
OCI_MAKEFILE="$ROOT_DIR/infra/oci/Makefile"
OCI_OUTPUTS="$ROOT_DIR/infra/oci/outputs.tf"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local expected=$1 file=$2
  grep -Fq -- "$expected" "$file" ||
    fail "expected '$expected' in $file"
}

assert_matches() {
  local pattern=$1 file=$2
  grep -Eq -- "$pattern" "$file" ||
    fail "expected /$pattern/ in $file"
}

assert_not_contains() {
  local unexpected=$1 file=$2
  if grep -Fq -- "$unexpected" "$file"; then
    fail "did not expect '$unexpected' in $file"
  fi
}

# Extract a single top-level job block from ci.yml so the assertions below
# cannot be satisfied by an unrelated job elsewhere in the file.
job_block() {
  local job=$1
  awk -v job="  ${job}:" '
    $0 == job { inblock = 1; next }
    inblock && /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { inblock = 0 }
    inblock { print }
  ' "$WORKFLOW"
}

TERRAFORM_JOB="$(job_block terraform-validate)"
[ -n "$TERRAFORM_JOB" ] || fail "terraform-validate job not found in $WORKFLOW"

JOB_FILE="$(mktemp)"
trap 'rm -f "$JOB_FILE"' EXIT
printf '%s\n' "$TERRAFORM_JOB" > "$JOB_FILE"

# --- 1. ci-gate must count the result -------------------------------------
assert_contains "  terraform-validate:" "$WORKFLOW"
assert_contains "      - terraform-validate" "$WORKFLOW"
assert_contains 'TERRAFORM_RESULT: ${{ needs.terraform-validate.result }}' \
  "$WORKFLOW"
assert_contains '"terraform-validate:${TERRAFORM_RESULT}"' "$WORKFLOW"

# --- 2. the job must stay credential-free ---------------------------------
assert_not_contains 'secrets.' "$JOB_FILE"
assert_not_contains 'environment:' "$JOB_FILE"
assert_not_contains 'azure/login' "$JOB_FILE"
# No apply path. Provisioning the box is a manual, operator-run step; wiring
# it here would mean storing a tenancy-wide API signing key as a repo secret.
assert_not_contains 'terraform apply' "$JOB_FILE"
assert_not_contains 'terraform destroy' "$JOB_FILE"
# -backend=false is what keeps the unit runs off the real OCI state bucket.
assert_contains 'terraform init -backend=false -input=false' "$JOB_FILE"

# --- 3. both roots are actually covered -----------------------------------
# infra/tests/*.tftest.hcl was run by no workflow before this job existed.
# Anchored: a substring match for 'working-directory: infra' is also satisfied
# by 'working-directory: infra/oci', so the plain form would let the Azure root
# fall out of the job while the test stayed green.
assert_matches '^[[:space:]]*working-directory: infra$' "$JOB_FILE"
assert_matches '^[[:space:]]*working-directory: infra/oci$' "$JOB_FILE"
assert_contains 'terraform -chdir=infra fmt -check -recursive' "$JOB_FILE"

# --- 4. action pinned by SHA, wrapper off ---------------------------------
# terraform_wrapper: true would wrap stdout in a GitHub Actions output block
# and corrupt the `terraform console` render the next step parses.
assert_contains \
  'hashicorp/setup-terraform@dfe3c3f87815947d99a8997f908cb6525fc44e9e' \
  "$JOB_FILE"
assert_contains 'terraform_wrapper: false' "$JOB_FILE"

# --- 5. the rendered bootstrap script is linted, not the template ---------
# Linting cloud-init.yaml.tftpl directly would lint Terraform directives, not
# shell. Going through local.cloud_init is what makes bash -n and shellcheck
# meaningful.
assert_contains 'local.cloud_init' "$JOB_FILE"
assert_contains 'yamldecode' "$JOB_FILE"
assert_contains 'shellcheck' "$JOB_FILE"
assert_contains 'bash -n' "$JOB_FILE"
# Rendering with -var-file is what makes terraform.tfvars.example a tested
# artefact rather than a comment: this step is the only thing anywhere that
# feeds the documented example through the variable validations. Tightening
# ssh_public_key broke the example and this step is what reported it. Switch
# the render to inline -var flags and the example silently stops being checked.
assert_contains '-var-file=terraform.tfvars.example' "$JOB_FILE"
# ...and an empty render must fail the job rather than lint an empty file:
# linting zero bytes reports SC2148 and nothing else, which reads as a finding
# about the template instead of as the broken extraction it actually is.
assert_contains 'Rendered bootstrap script is empty' "$JOB_FILE"

# --- 6. the shared Traefik config contract --------------------------------
[ -f "$TRAEFIK_CONFIG" ] || fail "missing $TRAEFIK_CONFIG"
assert_contains 'traefik-config.yaml' "$COMPUTE_TF"
assert_contains 'ACME_EMAIL_PLACEHOLDER' "$COMPUTE_TF"
assert_contains 'ACME_EMAIL_PLACEHOLDER' "$TRAEFIK_CONFIG"
# The three bugs found on the aarch64 dry-run VM, locked here as well as in
# infra/oci/tests/traefik_config.tftest.hcl.
assert_contains 'updateStrategy:' "$TRAEFIK_CONFIG"
assert_contains 'type: Recreate' "$TRAEFIK_CONFIG"
assert_contains 'redirections:' "$TRAEFIK_CONFIG"
assert_contains 'hostNetwork: true' "$TRAEFIK_CONFIG"
# Anchored, because the file's own comments name both forbidden keys.
if grep -Eq '^[[:space:]]*redirectTo:' "$TRAEFIK_CONFIG"; then
  fail "redirectTo was removed in Traefik chart v34; use redirections"
fi
if grep -Eq '^[[:space:]]*strategy:' "$TRAEFIK_CONFIG"; then
  fail "the chart reads .Values.updateStrategy; deployment.strategy is ignored"
fi

# --- 7. OCI state and local overrides stay out of git ---------------------
# .gitignore's terraform block hardcodes one directory level, so infra/oci/
# needs its own entries or a tfstate can be committed by accident.
assert_contains 'infra/oci/.terraform/' "$GITIGNORE"
assert_contains 'infra/oci/*.tfstate*' "$GITIGNORE"
assert_contains 'infra/oci/terraform.tfvars' "$GITIGNORE"
assert_contains 'infra/oci/*_override.tf' "$GITIGNORE"

# --- 8. The destroy guard and the operator-facing strings -----------------
# These three are shell-level: terraform never sees a malformed make
# invocation, and it cannot tell a working runbook line from a broken one.

# terraform accepts both -auto-approve and -auto-approve=true. The original
# guard matched on a trailing space, so the assignment form walked straight
# past the confirmation on a destroy.
assert_matches '\*" -auto-approve"\*' "$OCI_MAKEFILE"
if grep -Eq '\*" -auto-approve "\*' "$OCI_MAKEFILE"; then
  fail "the -auto-approve guard requires a trailing space, so -auto-approve=true bypasses it"
fi

# TF_VAR_FLAGS expands into an unquoted shell command line, so an OWNER_ALIAS
# containing a semicolon would run a second command and one containing a space
# would split into two terraform arguments.
assert_contains "owner_alias='\$(OWNER_ALIAS)'" "$OCI_MAKEFILE"

# ...but quoting alone is not the guarantee, which is why this one is executed
# rather than grepped. Single quotes do not escape an embedded apostrophe: the
# payload below closes the quote the recipe just opened and runs while the shell
# is still assembling terraform's argv, long before any terraform validation.
# A string assertion approved exactly that Makefile, so the lock has to be
# behavioural. `-n` and the `help` target keep this free of terraform.
owner_alias_is_refused() {
  local payload=$1 label=$2
  if make -C "$ROOT_DIR/infra/oci" -n help OWNER_ALIAS="$payload" \
    >/dev/null 2>&1; then
    fail "infra/oci/Makefile accepted a $label OWNER_ALIAS"
  fi
}

owner_alias_is_refused "x'; touch /tmp/pwned; echo '" "quote-closing"
owner_alias_is_refused 'x; id' "command-separating"
owner_alias_is_refused 'x y' "argument-splitting"
owner_alias_is_refused 'x`id`' "backquoted"
owner_alias_is_refused 'x&&id' "and-listed"

# The guard has to stay narrow enough to pass the value an operator really uses,
# or it would be discovered by breaking a release rather than by this test.
make -C "$ROOT_DIR/infra/oci" -n help OWNER_ALIAS=aaffinit >/dev/null 2>&1 ||
  fail "infra/oci/Makefile rejected a well-formed OWNER_ALIAS"
make -C "$ROOT_DIR/infra/oci" -n help >/dev/null 2>&1 ||
  fail "infra/oci/Makefile failed with no OWNER_ALIAS set"

# Terraform only escapes %{, so a bare %% survives into the rendered output and
# the shell then prints a literal %F. The state-backup line is the one an
# operator copy-pastes mid-incident, which is the worst time to hand them a
# file called backup-%F.tfstate.
assert_contains 'backup-$(date +%F).tfstate' "$OCI_OUTPUTS"
assert_not_contains 'date +%%F' "$OCI_OUTPUTS"

# Same class: README.md's workflow cds into infra/oci before running any of
# these, so a `-C infra/oci` in an output resolves to infra/oci/infra/oci for
# the one reader guaranteed to copy the line verbatim. The bare target is
# defined in both makefiles and works from either directory.
assert_contains 'make tf-oci-kubeconfig' "$OCI_OUTPUTS"
assert_not_contains 'make -C infra/oci' "$OCI_OUTPUTS"

# --- 9. the documented assertion count is the real one --------------------
# README.md's CI table states how much the credential-free job covers. That
# number was written once and was wrong by half within two review rounds,
# which is the failure mode of every hand-maintained count: nothing reads it,
# so nothing contradicts it. Deriving it here makes the next stale edit fail.
OCI_TESTS_DIR="$ROOT_DIR/infra/oci/tests"
OCI_README="$ROOT_DIR/infra/oci/README.md"

actual_runs="$(cat "$OCI_TESTS_DIR"/*.tftest.hcl | grep -c '^run "')"
documented_runs="$(
  grep -oE '\| [0-9]+ assertions, all on `mock_provider` \|' "$OCI_README" |
    grep -oE '[0-9]+'
)"

[ -n "$documented_runs" ] ||
  fail "could not find the assertion count in $OCI_README"

if [ "$actual_runs" != "$documented_runs" ]; then
  fail "$OCI_README documents $documented_runs assertions; $OCI_TESTS_DIR has $actual_runs"
fi

echo "terraform gate checks passed."
