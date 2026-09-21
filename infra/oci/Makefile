.PHONY: help tf-oci-bootstrap tf-oci-init tf-oci-init-local tf-oci-validate tf-oci-fmt tf-oci-test tf-oci-plan tf-oci-apply tf-oci-destroy tf-oci-kubeconfig tf-oci-ssh tf-oci-output

OWNER_ALIAS ?=
CONFIRM_APPLY ?=
CONFIRM_DESTROY ?=

# OWNER_ALIAS reaches the shell from several recipes below -- TF_VAR_FLAGS,
# OCI_STATE_KEY, and the CONFIRM_* hint messages -- so it is validated once
# here, at parse time, before any of them can expand it. Quoting each call site
# is not enough: single quotes stop `foo; rm -rf /` but not an embedded
# apostrophe, and `x'; touch /tmp/pwned; echo '` closes the generated quote and
# runs while the shell is still building terraform's argv. Terraform's own
# `^[a-z][a-z0-9]{2,10}$` validation cannot help, because it never sees a
# malformed invocation.
#
# The check is an allowlist implemented without a shell -- handing the value to
# `$(shell ...)` to test it would be the same injection under another name.
# Every permitted character is substituted away; whatever is left is rejected.
# `$` and `#` are handled separately, before the fold, for the reason spelled
# out at that check; whitespace, including a newline, is rejected first.
#
# Division of labour: this guard owns shell safety (the character set),
# variables.tf owns correctness (length, leading letter, the 15-character OCI
# DNS label ceiling). Terraform can enforce the second only once the first
# guarantees it is handed the value the operator actually typed.
override OWNER_ALIAS_ALLOWED := a b c d e f g h i j k l m n o p q r s t u v w x y z \
                       0 1 2 3 4 5 6 7 8 9

# Read the *raw* text with $(value ...), never the variable itself. A variable
# set on the command line is recursively expanded, so the first check that
# merely reads it is already
# too late: `make tf-oci-plan OWNER_ALIAS='$$(shell touch /tmp/pwned)'` runs the
# command inside $(words ...) itself, before a single character has been
# inspected. Reproduced in a scratch makefile -- the file appeared and
# TF_VAR_FLAGS came out empty, because $(shell ...) expands to nothing, so the
# guard reported success on a value it had already executed.
override OCI_STATE_KEY_ALLOWED := a b c d e f g h i j k l m n o p q r s t u v w x y z \
  0 1 2 3 4 5 6 7 8 9 - . _ /

override OWNER_ALIAS_RAW := $(value OWNER_ALIAS)

ifneq ($(OWNER_ALIAS_RAW),)
ifneq ($(words $(OWNER_ALIAS_RAW)),1)
$(error OWNER_ALIAS must not contain whitespace (got: '$(OWNER_ALIAS_RAW)'))
endif
# `$$` and `#` are rejected here rather than by the fold below, because the
# fold is built with $(eval), which re-parses its argument as makefile text.
# A surviving `$$` would be expanded at that point after all, and a `#` would
# comment out the rest of the generated line -- leaving the residue empty and
# the value approved.
ifneq ($(findstring $$,$(OWNER_ALIAS_RAW)),)
$(error OWNER_ALIAS must be lowercase alphanumeric; it contains a '$$')
endif
ifneq ($(findstring \#,$(OWNER_ALIAS_RAW)),)
$(error OWNER_ALIAS must be lowercase alphanumeric; it contains a hash character)
endif
override OWNER_ALIAS_RESIDUE := $(OWNER_ALIAS_RAW)
$(foreach c,$(OWNER_ALIAS_ALLOWED),\
  $(eval override OWNER_ALIAS_RESIDUE := $$(subst $(c),,$(OWNER_ALIAS_RESIDUE))))
ifneq ($(OWNER_ALIAS_RESIDUE),)
$(error OWNER_ALIAS must be lowercase alphanumeric; rejected: $(OWNER_ALIAS_RESIDUE))
endif
endif

# Everything downstream uses OWNER_ALIAS_RAW, the value the allowlist actually
# vetted. Referencing the original variable would expand it again at every use
# site.
#
# Single-quoted as a second barrier, so a future edit that loosens the guard
# above does not immediately hand an unquoted value to the shell.
#
# `override` for the same reason the residues and alphabets above carry it,
# and this is the last variable in the chain that was still missing it: the
# recipes expand this value *unquoted* into a shell command line, so without
# it the alias allowlist vets OWNER_ALIAS and the command line then supplies
# the flags directly --
#
#   make tf-oci-plan OWNER_ALIAS=jdoe TF_VAR_FLAGS='-var owner_alias=alice; ...'
#
# which both plans a different owner than the one validated and runs whatever
# follows the semicolon. Nothing documents this as an operator knob; it is
# derived from OWNER_ALIAS_RAW and has no other legitimate source.
override TF_VAR_FLAGS := $(if $(OWNER_ALIAS_RAW),-var owner_alias='$(OWNER_ALIAS_RAW)',)

# The confirmation tokens get no allowlist -- they are free-form by design --
# so they must never be interpolated into recipe text. `CONFIRM_APPLY='x";
# touch /tmp/pwned; echo "'` closes the generated quote and runs before the
# comparison happens. $(value ...) keeps make from expanding them, and
# exporting a simply-expanded variable puts the stored text into the child
# environment verbatim, so the recipes below compare shell variables.
override CONFIRM_APPLY_RAW   := $(value CONFIRM_APPLY)
override CONFIRM_DESTROY_RAW := $(value CONFIRM_DESTROY)
export CONFIRM_APPLY_RAW
export CONFIRM_DESTROY_RAW

# The same allowlist the two guards above apply by hand, factored out because
# OWNER_ALIAS and OCI_STATE_KEY are not the only values that reach a shell.
# Every backend setting below is interpolated into a recipe -- into
# `oci os bucket create --name "..."`, into terraform's -backend-config
# arguments, into the endpoint URL -- and none of them was vetted, though the
# two channels they arrive on are exactly the two the guards above exist for.
# Both attacks were reproduced against recipes copied from this file:
#
#   OCI_STATE_NAMESPACE='$$(shell touch /tmp/pwned)'  runs while
#   OCI_STATE_ENDPOINT expands -- a command-line assignment is a recursive
#   variable, so the reference *is* the execution;
#
#   OCI_STATE_BUCKET='x"; touch /tmp/pwned; echo "'  closes the double quote
#   the recipe wrote and runs the rest as its own command.
#
# .oci-backend.env is the channel that makes this worth fixing rather than
# noting: it is an operator-edited file make reads with no validation at all,
# and the comment on OCI_STATE_KEY below already says so about one value while
# the four beside it went unchecked.
#
# $(value ...) throughout, never the variable itself: reading a recursive
# variable expands it, so any check that reads before it rejects has already
# run whatever it was trying to refuse.
override OCI_SAFE_ALNUM := a b c d e f g h i j k l m n o p q r s t u v w x y z \
                  A B C D E F G H I J K L M N O P Q R S T U V W X Y Z \
                  0 1 2 3 4 5 6 7 8 9
override OCI_SAFE_NAME := $(OCI_SAFE_ALNUM) - . _
override OCI_SAFE_PATH := $(OCI_SAFE_NAME) /
override OCI_SAFE_URL  := $(OCI_SAFE_PATH) :

# $(1) variable name, $(2) permitted characters, $(3) human description,
# $(4) the name to print if it differs from $(1) -- the endpoint is checked
# through a holding variable the operator never typed, and an error naming
# that one would send them looking for a setting that does not exist.
# `$$` and `#` go first for the reason the OWNER_ALIAS guard spells out: the
# fold is built with $(eval), which re-parses its argument as makefile text.
define assert_shell_safe
ifneq ($$(findstring $$$$,$$(value $(1))),)
$$(error $(if $(4),$(4),$(1)) must be $(3); it contains a '$$$$')
endif
ifneq ($$(findstring \#,$$(value $(1))),)
$$(error $(if $(4),$(4),$(1)) must be $(3); it contains a hash character)
endif
ifneq ($$(strip $$(value $(1))),)
ifneq ($$(words $$(value $(1))),1)
$$(error $(if $(4),$(4),$(1)) must be a single whitespace-free value (got: '$$(value $(1))'))
endif
endif
override $(1)_RESIDUE := $$(value $(1))
$$(foreach c,$(2),$$(eval override $(1)_RESIDUE := $$$$(subst $$(c),,$$($(1)_RESIDUE))))
ifneq ($$($(1)_RESIDUE),)
$$(error $(if $(4),$(4),$(1)) must be $(3); rejected: $$($(1)_RESIDUE))
endif
endef

# S3-compatible backend against OCI Object Storage. Populate .oci-backend.env
# from the console; it is gitignored and holds a Customer Secret Key pair.
OCI_BACKEND_ENV_FILE ?= .oci-backend.env

# Vetted before the read below rather than beside the others, because the
# expansion that names the file happens there: a `$(shell ...)` in the path
# would run at that point, before any guard placed after it could speak.
$(eval $(call assert_shell_safe,OCI_BACKEND_ENV_FILE,$(OCI_SAFE_PATH),a path of alphanumerics plus -._/))

OCI_STATE_BUCKET     ?=
OCI_STATE_NAMESPACE  ?=
OCI_STATE_REGION     ?= eu-frankfurt-1
# No shared fallback on an empty alias. The key used to fall back to
# sre-simulator-free.tfstate, so two operators who both forgot OWNER_ALIAS
# landed on one state object and the second apply proposed destroying the
# first one's box -- a hazard the README documented instead of removing.
#
# The alias is the only thing allowed to name the state object. An override
# that *disagrees* with it was the same hazard wearing the guard's uniform:
# `tf-oci-init OWNER_ALIAS=jdoe` then
# `tf-oci-plan OWNER_ALIAS=alice OCI_STATE_KEY=jdoe-free-sre-simulator.tfstate`
# satisfied the state-owner check below while TF_VAR_FLAGS still carried
# owner_alias=alice, so terraform planned alice's names against jdoe's state
# and applying that plan reads as a destroy. Sharing a key on purpose is
# still available -- by sharing the alias, which is the identity the plan uses
# too, so the two halves cannot drift apart again.
OCI_STATE_KEY_DERIVED := $(if $(OWNER_ALIAS_RAW),$(OWNER_ALIAS_RAW)-free-sre-simulator.tfstate,)

# `$(value ...)` for the same reason OWNER_ALIAS gets it, one variable over:
# a command-line assignment is a *recursive* variable, so the first reference
# expands it. `$(strip $(OCI_STATE_KEY))` inside the old parse-time `ifeq`
# was that first reference, and
# `make tf-oci-plan OWNER_ALIAS=alice OCI_STATE_KEY='$$(shell touch /tmp/pwned)'`
# ran the command while make was still deciding whether to refuse the value.
# Reproduced in a scratch makefile: the file appeared and the guard reported
# the key as `injected`. $(value ...) captures the text unexpanded; the checks
# below read that text and nothing ever expands it.
#
# `origin` rather than emptiness, because `OCI_STATE_KEY=` on the command line
# is *set* and empty, which is not the same as unset: it used to leave the key
# empty while the alias was set, and every comparison that skips an empty key
# then walked the state-owner check.
ifeq ($(origin OCI_STATE_KEY),undefined)
override OCI_STATE_KEY_GIVEN :=
OCI_STATE_KEY_IS_SET :=
else
override OCI_STATE_KEY_GIVEN := $(value OCI_STATE_KEY)
OCI_STATE_KEY_IS_SET := yes
endif

ifneq ($(OCI_STATE_KEY_IS_SET),)
# `$$` and `#` are rejected before the allowlist fold, not by it: the fold is
# built with $(eval), which re-parses its argument as makefile text, so a
# surviving `$$` would be expanded after all and a `#` would comment out the
# rest of the generated line -- leaving an empty residue and an approved
# value. Same ordering as the OWNER_ALIAS guard above, for the same reason.
ifneq ($(findstring $$,$(OCI_STATE_KEY_GIVEN)),)
$(error OCI_STATE_KEY must be a literal object key; contains '$$')
endif
ifneq ($(findstring \#,$(OCI_STATE_KEY_GIVEN)),)
$(error OCI_STATE_KEY must be a literal object key; contains a hash character)
endif
ifneq ($(words $(OCI_STATE_KEY_GIVEN)),1)
$(error OCI_STATE_KEY must be a single whitespace-free object key (got: '$(OCI_STATE_KEY_GIVEN)'))
endif
override OCI_STATE_KEY_RESIDUE := $(OCI_STATE_KEY_GIVEN)
$(foreach c,$(OCI_STATE_KEY_ALLOWED),\
  $(eval override OCI_STATE_KEY_RESIDUE := $$(subst $(c),,$(OCI_STATE_KEY_RESIDUE))))
ifneq ($(OCI_STATE_KEY_RESIDUE),)
$(error OCI_STATE_KEY must be lowercase alphanumeric plus -._/; rejected: $(OCI_STATE_KEY_RESIDUE))
endif
endif

# Only refused when an alias is present. Unset on both is the no-backend path
# (`tf-oci-init-local`), and there the per-target OWNER_ALIAS guard speaks
# first with a clearer message.
ifneq ($(OWNER_ALIAS_RAW),)
ifneq ($(OCI_STATE_KEY_IS_SET),)
ifneq ($(OCI_STATE_KEY_GIVEN),$(OCI_STATE_KEY_DERIVED))
$(error OCI_STATE_KEY='$(OCI_STATE_KEY_GIVEN)' disagrees with \
OWNER_ALIAS='$(OWNER_ALIAS_RAW)', which derives \
'$(OCI_STATE_KEY_DERIVED)'. terraform would be handed owner_alias=$(OWNER_ALIAS_RAW) \
against the other key's state, and applying that plan reads as a destroy of \
whatever it describes. Leave OCI_STATE_KEY unset, or change OWNER_ALIAS to \
the alias that owns the key)
endif
endif
endif

# An explicit key with no alias names a state object nothing else in this run
# can be checked against: TF_VAR_FLAGS is empty, so terraform prompts for
# owner_alias and the answer need not be the one that key belongs to.
ifeq ($(OWNER_ALIAS_RAW),)
ifneq ($(OCI_STATE_KEY_IS_SET),)
$(error OCI_STATE_KEY='$(OCI_STATE_KEY_GIVEN)' was set without OWNER_ALIAS. \
The key is derived from the alias so that the state object and the variables \
in the plan cannot name different operators; set OWNER_ALIAS instead)
endif
endif

# Read as data. `-include` would *execute* it.
#
# .oci-backend.env is makefile syntax to `-include`, so a line reading
# `OCI_STATE_BUCKET := $(shell curl ... | sh)` runs while make is reading the
# include -- before any guard below can speak, and `$(value ...)` afterwards
# then vets the harmless leftover rather than the text that ran. Reproduced
# against the previous version of this file: a single `:=` line created a
# canary during `make -n tf-oci-plan`, with every guard below still reporting
# the value as clean. Vetting the values of an included file is vetting the
# wrong thing; the file has to stop being makefile text.
#
# sed reads it as lines instead. The contents are an argument to a program,
# never anything make or a shell parses, so `#` still starts a comment, a
# commented-out line stays commented out, and a `$` is just a character. The
# path is the one part of this that make does expand, which is why it is
# vetted above.
#
# The narrowing is deliberate: the include could define *any* make variable,
# and now only the keys bound below are read. Those are the ones the file is
# documented to carry.
# One regex, two readers: the extractor below and the refusal beside it have
# to agree on what an assignment looks like, and a second copy would be the
# one that goes stale. \2 is the key and \3 the value; \1 is the optional
# `export`, which an operator who reached for shell habits may well have
# written, and \4 a trailing comment, which `-include` also allowed.
#
# The value is whitespace-free by construction, so `KEY=two words` fails to
# match and is refused below rather than quietly bound to `two`. A value with
# a space in it cannot survive the rest of this file anyway -- every guarded
# value is checked for being a single word -- and being told so by line number
# beats finding a truncated bucket name in a terraform command.
OCI_DOTENV_LINE := ^[[:blank:]]*(export[[:blank:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:blank:]]*=[[:blank:]]*([^[:blank:]\#]*)([[:blank:]]+\#.*)?[[:blank:]]*$$

ifneq ($(wildcard $(OCI_BACKEND_ENV_FILE)),)
OCI_BACKEND_ENV_TEXT := $(shell tr -d '\r' < $(OCI_BACKEND_ENV_FILE) | \
  sed -n -E -e 's/$(OCI_DOTENV_LINE)/\2=\3/p')
# Anything that is neither blank, a comment, nor an assignment is refused by
# line number rather than dropped. Under `-include` such a line did something
# -- a target, a conditional, an `include` of its own -- so ignoring it now
# would turn a file that used to work into one that half works. Numbers only:
# echoing the line back would be putting the file's text into make's own.
OCI_BACKEND_ENV_BAD := $(shell tr -d '\r' < $(OCI_BACKEND_ENV_FILE) | \
  grep -n -E -v -e '^[[:blank:]]*(\#|$$)' -e '$(OCI_DOTENV_LINE)' | \
  cut -d: -f1 | tr '\n' ' ')
ifneq ($(strip $(OCI_BACKEND_ENV_BAD)),)
$(error $(OCI_BACKEND_ENV_FILE) is read as KEY=VALUE lines, not as a makefile; \
line(s) $(strip $(OCI_BACKEND_ENV_BAD)) are neither blank, a comment, nor an \
assignment. `KEY := value` is a makefile assignment, not a dotenv one)
endif
endif

dotenv_value = $(patsubst $(1)=%,%,$(filter $(1)=%,$(OCI_BACKEND_ENV_TEXT)))

# $(1) is a key name and never a value: the generated line *calls* for the
# value rather than carrying it, so nothing out of the file is ever pasted
# into makefile text for $(eval) to re-parse.
#
# The command line still wins, and the file still beats the environment --
# the precedence `-include` had. A repeated key is refused rather than
# resolved: make would take the last one without saying so, and an operator
# who left an old bucket above a new one would be pointed at the wrong state.
define dotenv_bind
ifneq ($$(word 2,$$(filter $(1)=%,$$(OCI_BACKEND_ENV_TEXT))),)
$$(error $(1) is set more than once in $$(OCI_BACKEND_ENV_FILE); remove the \
duplicate rather than relying on which one wins)
endif
ifeq ($$(filter command line override,$$(origin $(1))),)
# Presence in the file, not a non-empty value -- `KEY=` is set-and-empty,
# which is not unset, the same distinction OCI_STATE_ENDPOINT already makes
# below. Keying this on emptiness meant an operator who blanked a line to
# clear an ambient value got the ambient value anyway: the file is documented
# to beat the environment, and silently not doing so points tf-oci-init at a
# bucket the file was edited to take away. Binding the empty value instead
# hands the decision to the target, which refuses a missing bucket by name.
ifneq ($$(filter $(1)=%,$$(OCI_BACKEND_ENV_TEXT)),)
$(1) := $$(call dotenv_value,$(1))
endif
endif
endef

$(eval $(call dotenv_bind,OCI_STATE_BUCKET))
$(eval $(call dotenv_bind,OCI_STATE_NAMESPACE))
$(eval $(call dotenv_bind,OCI_STATE_REGION))
$(eval $(call dotenv_bind,OCI_STATE_COMPARTMENT_OCID))
$(eval $(call dotenv_bind,OCI_STATE_ENDPOINT))
$(eval $(call dotenv_bind,AWS_ACCESS_KEY_ID))
$(eval $(call dotenv_bind,AWS_SECRET_ACCESS_KEY))

# After the bind, so the file's values are vetted too -- that is the whole
# point, since the file is the channel with no other check on it. Parse time
# still, so nothing has reached a shell yet: recipes expand when they run.
#
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are deliberately *not* in this
# list. They are exported into terraform's environment rather than
# interpolated into a command line, so no quoting of theirs is ever parsed by
# a shell, and a secret has no business being constrained to an alphabet.
$(eval $(call assert_shell_safe,OCI_STATE_BUCKET,$(OCI_SAFE_NAME),alphanumeric plus -._))
$(eval $(call assert_shell_safe,OCI_STATE_NAMESPACE,$(OCI_SAFE_NAME),alphanumeric plus -._))
$(eval $(call assert_shell_safe,OCI_STATE_REGION,$(OCI_SAFE_NAME),alphanumeric plus -._))
$(eval $(call assert_shell_safe,OCI_STATE_COMPARTMENT_OCID,$(OCI_SAFE_NAME),an OCID: alphanumeric plus -._))

# Assigned after the include, and from the alias rather than from any of the
# channels above: .oci-backend.env is an operator-edited file that make reads
# without any of the parse-time validation the command line just went
# through, so a key set there would otherwise reach the shell interpolation in
# tf-oci-init unvetted. The allowlist makes this value safe to interpolate.
OCI_STATE_KEY := $(OCI_STATE_KEY_DERIVED)

# Binding a value only creates a make variable, and make exports nothing it
# did not inherit. Terraform's S3 backend reads its credentials from the *environment*,
# so without these two lines .oci-backend.env is read and then ignored, and
# tf-oci-init fails with a credentials error that points nowhere near the file
# that was supposed to supply them. Exporting an unset variable is a no-op, so
# an ambient AWS profile still works.
export AWS_ACCESS_KEY_ID
export AWS_SECRET_ACCESS_KEY

# backend.tf's skip_s3_checksum removes the SHA256 checksum Terraform asks for,
# but not the AWS SDK's own default full-object CRC32 -- measured on Terraform
# 1.16.3, PutObject still carries x-amz-checksum-crc32 with the flag set. This
# is the SDK switch that removes it, and OCI's S3 shim is the reason to want it
# gone. Overridable, because the day OCI starts honouring the header this
# becomes an unnecessary weakening of an integrity check.
AWS_REQUEST_CHECKSUM_CALCULATION ?= when_required
export AWS_REQUEST_CHECKSUM_CALCULATION

# The endpoint is the one value that cannot be checked where it is written:
# its default *is* a `$(...)` reference, so the `$$` rejection every other
# guarded value gets would refuse this file's own text. Split instead --
# whatever the operator supplied is vetted on its own, and the default is
# composed afterwards, simply-expanded, out of a namespace and a region that
# have already passed. `origin` rather than emptiness, because
# `OCI_STATE_ENDPOINT=` is set-and-empty, which is not unset.
ifeq ($(origin OCI_STATE_ENDPOINT),undefined)
OCI_STATE_ENDPOINT_GIVEN :=
else
OCI_STATE_ENDPOINT_GIVEN := $(value OCI_STATE_ENDPOINT)
endif
$(eval $(call assert_shell_safe,OCI_STATE_ENDPOINT_GIVEN,$(OCI_SAFE_URL),a URL of alphanumerics plus -._/:,OCI_STATE_ENDPOINT))

OCI_STATE_ENDPOINT := $(if $(OCI_STATE_ENDPOINT_GIVEN),$(OCI_STATE_ENDPOINT_GIVEN),https://$(OCI_STATE_NAMESPACE).compat.objectstorage.$(OCI_STATE_REGION).oraclecloud.com)

# A non-empty OWNER_ALIAS is not the same claim as the *right* OWNER_ALIAS.
# `init` is the only target that records the state object key -- terraform
# writes the merged backend config, key included, to
# .terraform/terraform.tfstate -- and every later target reads that recording
# back rather than anything on the command line. So
# `tf-oci-init OWNER_ALIAS=jdoe` followed by `tf-oci-plan OWNER_ALIAS=alice`
# plans alice's resources against jdoe's state, and tf-oci-apply then applies
# that plan, which for a state describing jdoe's box reads as a destroy.
#
# Silent when nothing is recorded: `tf-oci-init-local` runs
# `terraform init -backend=false`, which writes no .terraform/terraform.tfstate
# at all (verified), and that path is the documented way to validate with no
# state. Silent too when OCI_STATE_KEY is empty, so the OWNER_ALIAS guard in
# each recipe keeps its own clearer message.
#
# The reader splits on commas and braces before matching, so it works whether
# terraform writes that file pretty-printed (it does today, 1.16.3) or
# compact. Anchoring on a whole `"key"` token is what keeps sse_customer_key,
# kms_key_id and workspace_key_prefix out of the match. A key containing a
# comma would be read truncated and refuse -- fail closed, which is the right
# direction for a guard nobody wants to be clever.
define assert_state_key_matches
	@recorded=$$(tr ',{}' '\n\n\n' < .terraform/terraform.tfstate 2>/dev/null \
		| sed -n 's/^[[:space:]]*"key"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
		| head -1); \
	if [ -n "$(OCI_STATE_KEY)" ] && [ -n "$$recorded" ] && \
	   [ "$$recorded" != "$(OCI_STATE_KEY)" ]; then \
		echo "REFUSED: this working copy is initialized against another state key."; \
		echo "  .terraform/ is bound to: $$recorded"; \
		echo "  OWNER_ALIAS expects:     $(OCI_STATE_KEY)"; \
		echo "Terraform reads the recorded key, not the alias on this command"; \
		echo "line, so the run would touch the other operator's state."; \
		echo "Re-run: make tf-oci-init OWNER_ALIAS=$(OWNER_ALIAS_RAW) \\"; \
		echo "          OCI_STATE_BUCKET=... OCI_STATE_NAMESPACE=..."; \
		exit 1; \
	fi
endef

help: ## Show this help
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-24s\033[0m %s\n", $$1, $$2}'

tf-oci-bootstrap: ## Create the Object Storage bucket that holds Terraform state (one-time)
	@if [ -z "$(OCI_STATE_BUCKET)" ]; then \
		echo "Set OCI_STATE_BUCKET to the bucket name to create."; \
		exit 1; \
	fi
	@if [ -z "$(OCI_STATE_COMPARTMENT_OCID)" ]; then \
		echo "Set OCI_STATE_COMPARTMENT_OCID to the compartment that should own the bucket."; \
		exit 1; \
	fi
	oci os bucket create \
		--name "$(OCI_STATE_BUCKET)" \
		--compartment-id "$(OCI_STATE_COMPARTMENT_OCID)" \
		--versioning Enabled
	@echo ""
	@echo "Bucket ready. The S3-compatible endpoint is:"
	@echo "  $(OCI_STATE_ENDPOINT)"
	@echo ""
	@echo "Now generate a Customer Secret Key (Identity > Users > your user >"
	@echo "Customer Secret Keys) -- NOT the API signing key -- and write:"
	@echo ""
	@echo "  # $(OCI_BACKEND_ENV_FILE)"
	@echo "  OCI_STATE_BUCKET=$(OCI_STATE_BUCKET)"
	@echo "  OCI_STATE_NAMESPACE=$(OCI_STATE_NAMESPACE)"
	@echo "  AWS_ACCESS_KEY_ID=<customer secret key id>"
	@echo "  AWS_SECRET_ACCESS_KEY=<customer secret key>"
	@echo ""
	@echo "Then: make tf-oci-init OWNER_ALIAS=<alias>"
	@echo ""
	@echo "Pass OWNER_ALIAS to init as well as to plan/apply: it selects the"
	@echo "state object key, and init is what records that key in .terraform/."

tf-oci-init: ## Initialize Terraform against the OCI Object Storage backend
	@if [ -z "$(OCI_STATE_BUCKET)" ] || [ -z "$(OCI_STATE_NAMESPACE)" ]; then \
		echo "OCI_STATE_BUCKET and OCI_STATE_NAMESPACE are required."; \
		echo "Run 'make tf-oci-bootstrap' first, or populate $(OCI_BACKEND_ENV_FILE)."; \
		echo ""; \
		echo "To skip remote state entirely (validation/testing only):"; \
		echo "  make tf-oci-init-local"; \
		exit 1; \
	fi
	@if [ -z "$(OCI_STATE_KEY)" ]; then \
		echo "OWNER_ALIAS is required for tf-oci-init."; \
		echo "It selects the state object key, and init is the target that"; \
		echo "records that key in .terraform/ -- so an init without it would"; \
		echo "bind this working copy to a key nobody chose, which a later"; \
		echo "plan/apply cannot correct."; \
		echo "Example: make tf-oci-init OWNER_ALIAS=aaffinit"; \
		echo ""; \
		echo "To skip remote state entirely (validation/testing only):"; \
		echo "  make tf-oci-init-local"; \
		exit 1; \
	fi
	terraform init \
		-backend-config="bucket=$(OCI_STATE_BUCKET)" \
		-backend-config="key=$(OCI_STATE_KEY)" \
		-backend-config="region=$(OCI_STATE_REGION)" \
		-backend-config="endpoints={s3=\"$(OCI_STATE_ENDPOINT)\"}"

tf-oci-init-local: ## Initialize Terraform without a remote backend (validation/testing only)
	terraform init -backend=false

tf-oci-validate: ## Validate the OCI Terraform configuration
	terraform validate

tf-oci-fmt: ## Format the OCI Terraform files
	terraform fmt -recursive

tf-oci-test: ## Run Terraform native tests (requires TF >= 1.10, no credentials needed)
	@TF_VER=$$(terraform version -json 2>/dev/null | sed -n 's/.*"terraform_version":[[:space:]]*"\([^"]*\)".*/\1/p'); \
	MAJOR=$$(echo "$$TF_VER" | cut -d. -f1); \
	MINOR=$$(echo "$$TF_VER" | cut -d. -f2); \
	if [ -z "$$TF_VER" ]; then \
		echo "Unable to detect terraform version from 'terraform version -json'."; \
		exit 1; \
	fi; \
	if [ "$$MAJOR" -lt 1 ] || { [ "$$MAJOR" -eq 1 ] && [ "$$MINOR" -lt 10 ]; }; then \
		echo "This root needs Terraform >= 1.10.0 (found $$TF_VER)."; \
		echo "versions.tf says the same: mock_provider needs 1.7, the"; \
		echo "cross-variable validation guarding ssh_allowed_cidrs needs 1.9,"; \
		echo "and backend.tf's use_lockfile needs 1.10."; \
		exit 1; \
	fi
	terraform test

tf-oci-plan: ## Generate and show an execution plan
	@if [ -z "$(OWNER_ALIAS_RAW)" ]; then \
		echo "OWNER_ALIAS is required for tf-oci-plan."; \
		echo "Without it TF_VAR_FLAGS is empty and terraform prompts for"; \
		echo "owner_alias, so tfplan is written for whatever is typed at the"; \
		echo "prompt -- which need not be the alias whose state key init"; \
		echo "recorded. tf-oci-apply then applies that plan against this"; \
		echo "backend regardless."; \
		echo "Example: make tf-oci-plan OWNER_ALIAS=aaffinit"; \
		exit 1; \
	fi
	$(assert_state_key_matches)
	terraform plan $(TF_VAR_FLAGS) -out=tfplan

tf-oci-apply: ## Apply the saved plan (run tf-oci-plan first)
	@if [ -z "$(OWNER_ALIAS_RAW)" ]; then \
		echo "OWNER_ALIAS is required for tf-oci-apply."; \
		echo "Example: make tf-oci-apply OWNER_ALIAS=aaffinit CONFIRM_APPLY=aaffinit"; \
		exit 1; \
	fi
	$(assert_state_key_matches)
	@if [ ! -f tfplan ]; then \
		echo "tfplan not found. Run 'make tf-oci-plan OWNER_ALIAS=$(OWNER_ALIAS_RAW)' first."; \
		exit 1; \
	fi
	@if [ "$${CONFIRM_APPLY_RAW:-}" != "$(OWNER_ALIAS_RAW)" ]; then \
		echo "REFUSED: missing manual confirmation for apply."; \
		echo "Re-run with CONFIRM_APPLY=$(OWNER_ALIAS_RAW)"; \
		exit 1; \
	fi
	terraform apply tfplan
	@echo ""
	@terraform output -raw post_apply_checklist 2>/dev/null || true

tf-oci-destroy: ## Destroy the free-tier box and its network
	@if [ -z "$(OWNER_ALIAS_RAW)" ]; then \
		echo "OWNER_ALIAS is required for tf-oci-destroy."; \
		echo "Example: make tf-oci-destroy OWNER_ALIAS=aaffinit CONFIRM_DESTROY=aaffinit-free"; \
		exit 1; \
	fi
	$(assert_state_key_matches)
	@# TF_CLI_ARGS and TF_CLI_ARGS_destroy are appended by Terraform itself, so
	@# they reach `terraform destroy` without passing through TF_VAR_FLAGS. A
	@# guard that reads only TF_VAR_FLAGS therefore inspects the one channel
	@# nobody would use to sneak the flag in.
	@# The patterns deliberately stop at the flag name rather than requiring a
	@# trailing space: terraform also accepts the assignment form, and
	@# -auto-approve=true slipped straight through the space-delimited version
	@# of this guard.
	@case " $(TF_VAR_FLAGS) $${TF_CLI_ARGS:-} $${TF_CLI_ARGS_destroy:-} " in *" -auto-approve"*|*" --auto-approve"*) \
		echo "REFUSED: -auto-approve is not allowed for destructive operations."; \
		exit 1; \
	esac
	@if [ "$${CONFIRM_DESTROY_RAW:-}" != "$(OWNER_ALIAS_RAW)-free" ]; then \
		echo "REFUSED: missing manual confirmation for destroy."; \
		echo "Re-run with CONFIRM_DESTROY=$(OWNER_ALIAS_RAW)-free"; \
		exit 1; \
	fi
	@echo "NOTE: the reserved public IP is destroyed too. Update the Cloudflare"
	@echo "A record after any rebuild, or the domain will point at nothing."
	terraform destroy $(TF_VAR_FLAGS)

tf-oci-kubeconfig: ## Fetch a kubeconfig that reaches the API through an SSH tunnel
	@set -e; \
	IP=$$(terraform output -raw public_ip); \
	USER=$$(terraform output -raw ssh_command | awk '{print $$2}' | cut -d@ -f1); \
	DEST="$$HOME/.kube/sre-simulator-free"; \
	mkdir -p "$$HOME/.kube"; \
	scp -o StrictHostKeyChecking=accept-new "$$USER@$$IP:/home/$$USER/.kube/config" "$$DEST"; \
	sed -i.bak 's#server: https://.*#server: https://127.0.0.1:6443#' "$$DEST"; \
	rm -f "$$DEST.bak"; \
	chmod 600 "$$DEST"; \
	echo "Kubeconfig written to $$DEST"; \
	echo ""; \
	echo "Port 6443 is closed at the NSG by design. Open the tunnel first:"; \
	echo "  ssh -N -L 6443:127.0.0.1:6443 $$USER@$$IP"; \
	echo "then:"; \
	echo "  export KUBECONFIG=$$DEST"

tf-oci-ssh: ## SSH into the box
	@IP=$$(terraform output -raw public_ip); \
	USER=$$(terraform output -raw ssh_command | awk '{print $$2}' | cut -d@ -f1); \
	exec ssh "$$USER@$$IP"

tf-oci-output: ## Show all Terraform outputs
	terraform output
