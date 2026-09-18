.PHONY: help tf-oci-bootstrap tf-oci-init tf-oci-init-local tf-oci-validate tf-oci-fmt tf-oci-test tf-oci-plan tf-oci-apply tf-oci-destroy tf-oci-kubeconfig tf-oci-ssh tf-oci-output

OWNER_ALIAS ?=
CONFIRM_APPLY ?=
CONFIRM_DESTROY ?=
# Single-quoted because this expands into an unquoted shell command line. An
# OWNER_ALIAS of "foo; rm -rf /" would otherwise run the second command, and an
# alias with a space would silently split into two terraform arguments.
# terraform's own validation cannot help here -- it never sees a malformed
# invocation.
TF_VAR_FLAGS := $(if $(OWNER_ALIAS),-var owner_alias='$(OWNER_ALIAS)',)

# S3-compatible backend against OCI Object Storage. Populate .oci-backend.env
# from the console; it is gitignored and holds a Customer Secret Key pair.
OCI_BACKEND_ENV_FILE ?= .oci-backend.env
OCI_STATE_BUCKET     ?=
OCI_STATE_NAMESPACE  ?=
OCI_STATE_REGION     ?= eu-frankfurt-1
OCI_STATE_KEY        ?= $(if $(OWNER_ALIAS),$(OWNER_ALIAS)-free-sre-simulator.tfstate,sre-simulator-free.tfstate)

-include $(OCI_BACKEND_ENV_FILE)

# `-include` only creates make variables, and make exports nothing it did not
# inherit. Terraform's S3 backend reads its credentials from the *environment*,
# so without these two lines .oci-backend.env is read and then ignored, and
# tf-oci-init fails with a credentials error that points nowhere near the file
# that was supposed to supply them. Exporting an unset variable is a no-op, so
# an ambient AWS profile still works.
export AWS_ACCESS_KEY_ID
export AWS_SECRET_ACCESS_KEY

OCI_STATE_ENDPOINT ?= https://$(OCI_STATE_NAMESPACE).compat.objectstorage.$(OCI_STATE_REGION).oraclecloud.com

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
	@echo "Then: make tf-oci-init"

tf-oci-init: ## Initialize Terraform against the OCI Object Storage backend
	@if [ -z "$(OCI_STATE_BUCKET)" ] || [ -z "$(OCI_STATE_NAMESPACE)" ]; then \
		echo "OCI_STATE_BUCKET and OCI_STATE_NAMESPACE are required."; \
		echo "Run 'make tf-oci-bootstrap' first, or populate $(OCI_BACKEND_ENV_FILE)."; \
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

tf-oci-test: ## Run Terraform native tests (requires TF >= 1.9, no credentials needed)
	@TF_VER=$$(terraform version -json 2>/dev/null | sed -n 's/.*"terraform_version":[[:space:]]*"\([^"]*\)".*/\1/p'); \
	MAJOR=$$(echo "$$TF_VER" | cut -d. -f1); \
	MINOR=$$(echo "$$TF_VER" | cut -d. -f2); \
	if [ -z "$$TF_VER" ]; then \
		echo "Unable to detect terraform version from 'terraform version -json'."; \
		exit 1; \
	fi; \
	if [ "$$MAJOR" -lt 1 ] || { [ "$$MAJOR" -eq 1 ] && [ "$$MINOR" -lt 9 ]; }; then \
		echo "This root needs Terraform >= 1.9.0 for cross-variable validation (found $$TF_VER)"; \
		exit 1; \
	fi
	terraform test

tf-oci-plan: ## Generate and show an execution plan
	terraform plan $(TF_VAR_FLAGS) -out=tfplan

tf-oci-apply: ## Apply the saved plan (run tf-oci-plan first)
	@if [ -z "$(OWNER_ALIAS)" ]; then \
		echo "OWNER_ALIAS is required for tf-oci-apply."; \
		echo "Example: make tf-oci-apply OWNER_ALIAS=aaffinit CONFIRM_APPLY=aaffinit"; \
		exit 1; \
	fi
	@if [ ! -f tfplan ]; then \
		echo "tfplan not found. Run 'make tf-oci-plan OWNER_ALIAS=$(OWNER_ALIAS)' first."; \
		exit 1; \
	fi
	@if [ "$(CONFIRM_APPLY)" != "$(OWNER_ALIAS)" ]; then \
		echo "REFUSED: missing manual confirmation for apply."; \
		echo "Re-run with CONFIRM_APPLY=$(OWNER_ALIAS)"; \
		exit 1; \
	fi
	terraform apply tfplan
	@echo ""
	@terraform output -raw post_apply_checklist 2>/dev/null || true

tf-oci-destroy: ## Destroy the free-tier box and its network
	@if [ -z "$(OWNER_ALIAS)" ]; then \
		echo "OWNER_ALIAS is required for tf-oci-destroy."; \
		echo "Example: make tf-oci-destroy OWNER_ALIAS=aaffinit CONFIRM_DESTROY=aaffinit-free"; \
		exit 1; \
	fi
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
	@if [ "$(CONFIRM_DESTROY)" != "$(OWNER_ALIAS)-free" ]; then \
		echo "REFUSED: missing manual confirmation for destroy."; \
		echo "Re-run with CONFIRM_DESTROY=$(OWNER_ALIAS)-free"; \
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
