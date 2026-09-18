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
# The same three properties are asserted for `oci-shape-e2e`, the companion
# job that boots real k3s on a free arm64 runner and exercises the deployment
# shape statically-checked Terraform cannot reach.
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

SHAPE_JOB="$(job_block oci-shape-e2e)"
[ -n "$SHAPE_JOB" ] || fail "oci-shape-e2e job not found in $WORKFLOW"

JOB_FILE="$(mktemp)"
# Both temp files are declared here so the one trap names both. A trailing
# `rm` after the last assertion would only run on a passing run, and the run
# that leaks is the failing one -- which is exactly when someone is iterating.
K8S_API_FILE="$(mktemp)"
SHAPE_FILE="$(mktemp)"
# Section 11 runs the make targets for real against a recording `terraform`
# stub; both the stub directory and its log belong to the same trap.
TERRAFORM_STUB_DIR="$(mktemp -d)"
TERRAFORM_ARGV_FILE="$(mktemp)"
OCI_MAKE_DIR=""
trap 'rm -f "$JOB_FILE" "$K8S_API_FILE" "$SHAPE_FILE" "$TERRAFORM_ARGV_FILE"; \
      rm -rf "$TERRAFORM_STUB_DIR" ${OCI_MAKE_DIR:+"$OCI_MAKE_DIR"}' EXIT
printf '%s\n' "$TERRAFORM_JOB" > "$JOB_FILE"
printf '%s\n' "$SHAPE_JOB" > "$SHAPE_FILE"

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
# would split into two terraform arguments. Asserted on the emitted recipe
# rather than on the makefile text: the quoting has already survived one
# rename (OWNER_ALIAS -> OWNER_ALIAS_RAW, when the guard moved to parse time),
# and a grep for the old spelling would have failed on a correct makefile
# while a grep for the new one proves nothing about what the shell receives.
plan_recipe="$(
  make -C "$ROOT_DIR/infra/oci" -n tf-oci-plan OWNER_ALIAS=jdoe 2>/dev/null |
    grep -F 'terraform plan' || true
)"
case "$plan_recipe" in
*"owner_alias='jdoe'"*) ;;
*) fail "tf-oci-plan emits [$plan_recipe]; owner_alias must reach terraform single-quoted" ;;
esac

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

# --- 9. the documented test-case count is the real one --------------------
# README.md's CI table states how much the credential-free job covers. That
# number was written once and was wrong by half within two review rounds,
# which is the failure mode of every hand-maintained count: nothing reads it,
# so nothing contradicts it. Deriving it here makes the next stale edit fail.
#
# What is counted is `run` blocks, which is what `terraform test` reports as
# passed/failed. The table used to call them assertions; it is not the same
# number -- a single run carries up to five `assert` blocks -- and calling
# them assertions undersold the coverage by roughly a factor of two while
# reading as if it were precise.
OCI_TESTS_DIR="$ROOT_DIR/infra/oci/tests"
OCI_README="$ROOT_DIR/infra/oci/README.md"

actual_runs="$(cat "$OCI_TESTS_DIR"/*.tftest.hcl | grep -c '^run "')"
documented_runs="$(
  grep -oE '\| [0-9]+ test cases, all on `mock_provider` \|' "$OCI_README" |
    grep -oE '[0-9]+'
)"

[ -n "$documented_runs" ] ||
  fail "could not find the test-case count in $OCI_README"

if [ "$actual_runs" != "$documented_runs" ]; then
  fail "$OCI_README documents $documented_runs test cases; $OCI_TESTS_DIR has $actual_runs"
fi

# --- 10. the 6443 promise carries its own scope ---------------------------
# k8s_api_allowed_cidrs defaults to empty and its description tells the reader
# the Kubernetes API is closed. That is true of the NSG and false of the node:
# an NSG filters traffic crossing the VNIC, pod-to-host traffic never crosses
# one, and cloud-init deliberately flushes the host INPUT chain -- so any
# workload on this cluster can reach 6443 on the node address with the variable
# at its default.
#
# The caveat is not decoration. Unqualified, that description is the sentence
# an operator would rely on when deciding a hostile pod is contained, and the
# answer would be wrong. Terraform has no way to check prose, so this is where
# it is held, next to the other strings in section 8 that nothing else reads.
#
# Scoped to the variable's own block: the same words elsewhere in the file
# would not be the promise being qualified.
OCI_VARIABLES="$ROOT_DIR/infra/oci/variables.tf"

K8S_API_BLOCK="$(
  awk '
    /^variable "k8s_api_allowed_cidrs" \{/ { inblock = 1 }
    inblock { print }
    inblock && /^\}/ { exit }
  ' "$OCI_VARIABLES"
)"
[ -n "$K8S_API_BLOCK" ] ||
  fail "variable \"k8s_api_allowed_cidrs\" not found in $OCI_VARIABLES"

printf '%s\n' "$K8S_API_BLOCK" > "$K8S_API_FILE"

# The distinction itself, and the two facts that make it true -- the host chain
# that cloud-init flushes, and the in-cluster path that makes closing it
# pointless. Losing either one turns the caveat back into a vague hedge.
#
# Matched on one line of the heredoc rather than the whole sentence: the
# description is hard-wrapped, so "not closed absolutely" never appears as
# contiguous bytes and an assertion on it would fail against correct text.
assert_contains 'empty means closed *to the internet*' "$K8S_API_FILE"
assert_contains 'cloud-init.yaml.tftpl' "$K8S_API_FILE"
assert_contains 'kubernetes.default.svc' "$K8S_API_FILE"

# --- 11. the state-key guards fail closed ---------------------------------
# The object key is derived from OWNER_ALIAS and recorded by `init` into
# .terraform/, where every later target reads it back. An earlier revision
# fell back to a shared sre-simulator-free.tfstate when the alias was unset,
# so two operators who each omitted it landed on one state object and the
# second apply proposed destroying the first one's box.
#
# Executed, not grepped, for two reasons. `make -n` cannot see these guards at
# all -- they live inside the recipe, which -n prints rather than runs -- and
# the property worth locking is not the exit code but that terraform is never
# *reached* with a key nobody chose. A recording stub on PATH answers that
# directly and keeps the section free of a real terraform.
cat > "$TERRAFORM_STUB_DIR/terraform" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$TERRAFORM_ARGV_FILE"
STUB
chmod +x "$TERRAFORM_STUB_DIR/terraform"

# The makefile is copied out and run from a scratch directory, not in place.
# A developer running this on their own machine may have a real
# .oci-backend.env beside it -- and, since the guard added below reads
# .terraform/terraform.tfstate, a real initialized backend too. Neither may
# decide whether this section passes, and section 12 has to plant that file.
# The copy is taken fresh from the file under test on every run.
OCI_MAKE_DIR="$(mktemp -d)"
cp "$ROOT_DIR/infra/oci/Makefile" "$OCI_MAKE_DIR/Makefile"

oci_make_run() {
  : > "$TERRAFORM_ARGV_FILE"
  PATH="$TERRAFORM_STUB_DIR:$PATH" make -C "$OCI_MAKE_DIR" \
    OCI_BACKEND_ENV_FILE=/dev/null "$@" >/dev/null 2>&1
}

if oci_make_run tf-oci-init OCI_STATE_BUCKET=b OCI_STATE_NAMESPACE=n; then
  fail "tf-oci-init succeeded with no OWNER_ALIAS"
fi
if [ -s "$TERRAFORM_ARGV_FILE" ]; then
  fail "tf-oci-init reached terraform with no OWNER_ALIAS: $(cat "$TERRAFORM_ARGV_FILE")"
fi

if oci_make_run tf-oci-plan; then
  fail "tf-oci-plan succeeded with no OWNER_ALIAS"
fi
if [ -s "$TERRAFORM_ARGV_FILE" ]; then
  fail "tf-oci-plan reached terraform with no OWNER_ALIAS: $(cat "$TERRAFORM_ARGV_FILE")"
fi

# The happy paths, which are what keep the guards from being discovered by
# breaking a bring-up. Each also asserts terraform was reached -- without that
# the two refusals above could pass for any unrelated make failure.
if ! oci_make_run tf-oci-init OWNER_ALIAS=jdoe \
  OCI_STATE_BUCKET=b OCI_STATE_NAMESPACE=n; then
  fail "tf-oci-init refused a well-formed OWNER_ALIAS"
fi
if ! grep -Fq 'key=jdoe-free-sre-simulator.tfstate' "$TERRAFORM_ARGV_FILE"; then
  fail "tf-oci-init passed [$(cat "$TERRAFORM_ARGV_FILE")]; the key must carry the alias"
fi

if ! oci_make_run tf-oci-plan OWNER_ALIAS=jdoe; then
  fail "tf-oci-plan refused a well-formed OWNER_ALIAS"
fi
if ! grep -Fq -- '-out=tfplan' "$TERRAFORM_ARGV_FILE"; then
  fail "tf-oci-plan did not reach terraform with a well-formed OWNER_ALIAS"
fi

# tf-oci-init-local is the documented way to validate and run `terraform test`
# with no state at all, so it must stay reachable without an alias -- that is
# what makes the two refusals above a redirection rather than a dead end.
if ! oci_make_run tf-oci-init-local; then
  fail "tf-oci-init-local requires an OWNER_ALIAS, but it is the no-state path"
fi

# --- 12. the alias must match the backend init actually recorded ----------
# A non-empty OWNER_ALIAS is a weaker claim than the right one. `init` records
# the state object key in .terraform/terraform.tfstate and every later target
# reads that recording back rather than the flag on the command line, so
# `tf-oci-init OWNER_ALIAS=jdoe` followed by `tf-oci-plan OWNER_ALIAS=alice`
# would plan alice's resources against jdoe's state -- and applying a plan
# computed that way reads as a destroy.
#
# The fixture below is the shape terraform 1.16.3 really writes: captured from
# an actual `terraform init` of the s3 backend (against a stub endpoint), then
# trimmed to the keys this guard reads. Inventing the shape would have tested
# the reader against my own guess -- and the file is where the two halves of
# this check meet.
mkdir -p "$OCI_MAKE_DIR/.terraform"
cat > "$OCI_MAKE_DIR/.terraform/terraform.tfstate" <<'RECORDED'
{
  "version": 3,
  "terraform_version": "1.16.3",
  "backend": {
    "type": "s3",
    "config": {
      "bucket": "tfstate-bucket",
      "key": "jdoe-free-sre-simulator.tfstate",
      "kms_key_id": null,
      "region": "eu-frankfurt-1",
      "sse_customer_key": null,
      "use_path_style": true,
      "workspace_key_prefix": null
    },
    "hash": 2892063586
  }
}
RECORDED

# tf-oci-apply refuses a missing tfplan too, and that refusal would carry this
# assertion on its own: with the state-key guard deleted the target still
# exits non-zero and still never reaches terraform, so the control passed
# against the unfixed makefile -- measured, not supposed. A plan file makes
# the guard the only thing left standing in front of `terraform apply`.
: > "$OCI_MAKE_DIR/tfplan"

for target in tf-oci-plan tf-oci-apply tf-oci-destroy; do
  if oci_make_run "$target" OWNER_ALIAS=alice CONFIRM_APPLY=alice \
      CONFIRM_DESTROY=alice-free; then
    fail "$target ran with an alias that does not own the initialized state"
  fi
  if [ -s "$TERRAFORM_ARGV_FILE" ]; then
    fail "$target reached terraform against another operator's state: $(cat "$TERRAFORM_ARGV_FILE")"
  fi
done

# The owning alias must still get through, or the guard is just a wall.
if ! oci_make_run tf-oci-plan OWNER_ALIAS=jdoe; then
  fail "tf-oci-plan refused the alias that owns the initialized state"
fi

# An explicit OCI_STATE_KEY used to be the documented way to share one object
# on purpose, and this suite locked that in as a happy path. It was the
# state-owner guard's own bypass: the key matched what init recorded, so the
# comparison passed, while TF_VAR_FLAGS still carried owner_alias=alice -- so
# terraform planned alice's names against jdoe's state, which is the exact
# outcome the guard exists to prevent, reached through the guard. Sharing an
# object is now done by sharing the alias, which is what the plan uses too.
if oci_make_run tf-oci-plan OWNER_ALIAS=alice \
    OCI_STATE_KEY=jdoe-free-sre-simulator.tfstate; then
  fail "tf-oci-plan ran with OCI_STATE_KEY naming another operator's state while owner_alias said alice"
fi
if [ -s "$TERRAFORM_ARGV_FILE" ]; then
  fail "a diverging OCI_STATE_KEY reached terraform: $(cat "$TERRAFORM_ARGV_FILE")"
fi

# Set to exactly what the alias derives, it is redundant rather than unsafe,
# and refusing it would break a caller that spells out what it means. The
# state here belongs to jdoe, so the run must get through on jdoe's own key.
if ! oci_make_run tf-oci-plan OWNER_ALIAS=jdoe \
    OCI_STATE_KEY=jdoe-free-sre-simulator.tfstate; then
  fail "an OCI_STATE_KEY agreeing with OWNER_ALIAS was refused"
fi

# An *empty* OCI_STATE_KEY beside an alias is the bypass, and it is the one
# form `?=` cannot catch: a command-line override fires even when it assigns
# nothing, so the key ends up empty while the alias is set, and every guard
# above that compares the key skips itself on an empty one. Asserted
# behaviourally rather than by grepping for the `$(error ...)`, because the
# question is whether the run reaches terraform, not whether a line exists.
if oci_make_run tf-oci-plan OWNER_ALIAS=alice OCI_STATE_KEY=; then
  fail "tf-oci-plan ran with OCI_STATE_KEY set empty alongside OWNER_ALIAS, which disables the state-owner check"
fi
if [ -s "$TERRAFORM_ARGV_FILE" ]; then
  fail "an empty OCI_STATE_KEY reached terraform: $(cat "$TERRAFORM_ARGV_FILE")"
fi

# OCI_STATE_KEY is read at parse time, and a command-line assignment is a
# recursive variable: the first reference expands it. `$(strip $(OCI_STATE_KEY))`
# inside the old guard was that reference, so the payload ran while make was
# still deciding whether to refuse the value -- the guard then reported the
# expansion's *result* as the key. Measured by the side effect, because an
# exit status cannot tell "refused" from "refused after running it".
INJECT_WITNESS="$OCI_MAKE_DIR/parse-time-injection-witness"
rm -f "$INJECT_WITNESS"
# shellcheck disable=SC2016
if oci_make_run tf-oci-plan OWNER_ALIAS=alice \
    OCI_STATE_KEY='$(shell touch '"$INJECT_WITNESS"')'; then
  fail "tf-oci-plan accepted an OCI_STATE_KEY containing a make function call"
fi
if [ -e "$INJECT_WITNESS" ]; then
  fail "OCI_STATE_KEY was expanded by make before being validated: the \$(shell ...) payload ran"
fi

# And with no alias at all there is nothing to check the key against:
# TF_VAR_FLAGS is empty, so terraform prompts for owner_alias and whatever is
# typed becomes the plan's identity regardless of which key holds the state.
if oci_make_run tf-oci-init OWNER_ALIAS= \
    OCI_STATE_KEY=jdoe-free-sre-simulator.tfstate \
    OCI_STATE_BUCKET=b OCI_STATE_NAMESPACE=n; then
  fail "tf-oci-init accepted an explicit OCI_STATE_KEY with no OWNER_ALIAS to bind it to"
fi

# backend.tf must carry no default key. A static one is what any init that
# does not override it would use -- including the manual path the README
# documents -- so it would reinstate the shared object behind the makefile.
# Read block-scoped: `key` appears in kms_key_id and friends elsewhere.
BACKEND_TF="$ROOT_DIR/infra/oci/backend.tf"
if awk '/backend "s3" \{/,/^  \}/' "$BACKEND_TF" |
    grep -Eq '^[[:space:]]*key[[:space:]]*='; then
  fail "backend.tf declares a default state key; init must require one instead"
fi

# --- 13. The state object is locked, and the checksum switch is exported ---
# Neither is reachable from terraform test: a backend block is not evaluated
# by `terraform test`, and an environment export is not terraform's business
# at all. Both are load-bearing, so they are asserted here or nowhere.

# Concurrent applies against one key are possible by design -- two machines
# driving the same box share an OWNER_ALIAS and therefore one key -- and
# without a lock the later write silently discards the earlier one.
if ! awk '/backend "s3" \{/,/^  \}/' "$BACKEND_TF" |
    grep -Eq '^[[:space:]]*use_lockfile[[:space:]]*=[[:space:]]*true'; then
  fail "backend.tf must set use_lockfile = true; without it two operators sharing OCI_STATE_KEY can apply concurrently and the second write wins silently"
fi

# use_lockfile arrived in Terraform 1.10. A floor below that turns the line
# above into an "Unsupported argument" at init time for anyone on an older
# binary, which is a worse failure than the race it prevents.
assert_contains 'required_version = ">= 1.10"' "$ROOT_DIR/infra/oci/versions.tf"

# tf-oci-test does its own version preflight so the failure names this root
# rather than arriving as terraform's generic version error. Two floors is two
# things to forget: the preflight sat at 1.9 while versions.tf had moved to
# 1.10, so a 1.9 binary passed the friendly check and failed the unfriendly
# one. Derived from versions.tf rather than written twice, because a second
# literal is what drifted in the first place.
REQUIRED_MINOR="$(sed -n 's/.*required_version[[:space:]]*=[[:space:]]*">= 1\.\([0-9]*\)".*/\1/p' \
  "$ROOT_DIR/infra/oci/versions.tf" | head -1)"
if [ -z "$REQUIRED_MINOR" ]; then
  fail "could not read the required_version minor out of infra/oci/versions.tf"
fi
if ! grep -q "MINOR\" -lt $REQUIRED_MINOR" "$OCI_MAKEFILE"; then
  fail "tf-oci-test's version preflight does not enforce the 1.$REQUIRED_MINOR floor that versions.tf requires"
fi

# And the prerequisite an operator actually reads before installing anything.
assert_contains "Terraform >= 1.$REQUIRED_MINOR" "$ROOT_DIR/infra/oci/README.md"

# skip_s3_checksum removes the checksum terraform asks for, not the one the
# AWS SDK adds by itself -- measured on 1.16.3, PutObject still carries
# x-amz-checksum-crc32 with the flag set. This export is what removes that
# one, and OCI's S3 shim is the reason to want it gone.
assert_contains 'export AWS_REQUEST_CHECKSUM_CALCULATION' "$OCI_MAKEFILE"

# --- 14. the oci-shape-e2e job --------------------------------------------
# ci-gate must count it, for the same reason terraform-validate is counted.
assert_contains "  oci-shape-e2e:" "$WORKFLOW"
assert_contains "      - oci-shape-e2e" "$WORKFLOW"
assert_contains 'OCI_SHAPE_RESULT: ${{ needs.oci-shape-e2e.result }}' \
  "$WORKFLOW"
assert_contains '"oci-shape-e2e:${OCI_SHAPE_RESULT}"' "$WORKFLOW"

# Credential-free, like its sibling: it boots a throwaway cluster on the
# runner itself and never talks to a cloud.
assert_not_contains 'secrets.' "$SHAPE_FILE"
assert_not_contains 'environment:' "$SHAPE_FILE"
assert_not_contains 'azure/login' "$SHAPE_FILE"
assert_not_contains 'terraform apply' "$SHAPE_FILE"

# The runner must be the free arm64 image. The box is aarch64, and the point
# of the job is to run the shape on the architecture that ships.
assert_contains 'runs-on: ubuntu-24.04-arm' "$SHAPE_FILE"

# The job must install the *shared* config, and must prove it did: the diff
# is what stops a CI-only tweak from making a red job green.
assert_contains 'SHARED_CONFIG: infra/oci/traefik-config.yaml' "$SHAPE_FILE"
assert_contains 'diff -u' "$SHAPE_FILE"
assert_contains \
  '/var/lib/rancher/k3s/server/manifests/traefik-config.yaml' "$SHAPE_FILE"

# k3s must be installed with the flags cloud-init renders, not retyped ones.
assert_contains 'local.cloud_init' "$SHAPE_FILE"
assert_contains '--disable=servicelb' "$SHAPE_FILE"

# The four things only a running cluster can show.
assert_contains 'hostNetwork' "$SHAPE_FILE"
assert_contains 'X-Real-Ip' "$SHAPE_FILE"
assert_contains 'permanent: true/permanent: false' "$SHAPE_FILE"
assert_contains 'updateStrategy' "$SHAPE_FILE"

# The image assertion must read the *running* container. Reading the Deployment
# template instead reports desired state: with the rollout paused and the pin
# applied to the template, a k3d reproduction showed the template reading
# v3.7.13 while the pod ran v3.3.6 and every other assertion here still passed.
assert_contains 'status.containerStatuses[0].image' "$SHAPE_FILE"
assert_not_contains 'spec.template.spec.containers[0].image' "$SHAPE_FILE"

# The route poll must go over https. Entrypoint-level redirections answer every
# :80 request with a 301 before any router matches -- confirmed against traefik
# v3.7.13 with no routers configured -- so polling :80 for a 301 would report a
# reconciled Ingress that does not exist.
assert_contains 'whoami route observed after' "$SHAPE_FILE"
if grep -Eq 'http://127\.0\.0\.1/ \|\| true' "$SHAPE_FILE"; then
  fail "the route poll must use https; a :80 301 is answered before routing"
fi

# Under `set -euo pipefail` a missing X-Real-Ip makes grep exit 1 and takes the
# step down before the branch that reports it, so the one failure this job
# exists to catch is the one it cannot report.
assert_contains "| tr -d '[:space:]' || true" "$SHAPE_FILE"

echo "terraform gate checks passed."
