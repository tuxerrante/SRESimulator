.PHONY: help tf-bootstrap tf-preflight tf-init tf-init-local tf-init-isolated tf-validate tf-test tf-plan tf-apply tf-destroy tf-kubeconfig tf-fmt tf-output

OWNER_ALIAS ?=
TF_VAR_FLAGS := $(if $(OWNER_ALIAS),-var owner_alias=$(OWNER_ALIAS),)
LOCATION ?= eastus
SQL_SERVER_NAME ?=
TF_BACKEND_ENV_FILE ?= .tf-backend.env

# Backend config – override these or supply via -backend-config at init time
TF_STATE_RG           ?= tfstate-rg
TF_STATE_ACCOUNT      ?=
TF_STATE_CONTAINER    ?= tfstate
TF_STATE_KEY          ?= $(if $(OWNER_ALIAS),$(OWNER_ALIAS)-test-sre-simulator.tfstate,sre-simulator.tfstate)
GENEVA_SUPPRESSION_ACCESS_CONFIRMED ?= false

-include $(TF_BACKEND_ENV_FILE)

help: ## Show this help
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-24s\033[0m %s\n", $$1, $$2}'

tf-bootstrap: ## Create Azure Storage Account for Terraform remote state (one-time)
	@if [ -z "$(TF_STATE_ACCOUNT)" ]; then \
		echo "Set TF_STATE_ACCOUNT to a globally unique storage account name."; \
		exit 1; \
	fi
	az group create --name "$(TF_STATE_RG)" --location "$(LOCATION)" --tags purpose=terraform-state
	az storage account create \
		--name "$(TF_STATE_ACCOUNT)" \
		--resource-group "$(TF_STATE_RG)" \
		--location "$(LOCATION)" \
		--sku Standard_LRS \
		--min-tls-version TLS1_2 \
		--allow-blob-public-access false \
		--tags purpose=terraform-state
	az storage container create \
		--name "$(TF_STATE_CONTAINER)" \
		--account-name "$(TF_STATE_ACCOUNT)"
	@echo "Terraform backend storage ready."
	@echo "To use this storage account for the Terraform backend, run:"
	@echo "  make tf-init TF_STATE_ACCOUNT=\"$(TF_STATE_ACCOUNT)\""

tf-preflight: ## Run Azure preflight checks for final isolated environment
	@OWNER_ALIAS="$(OWNER_ALIAS)" \
	LOCATION="$(LOCATION)" \
	TF_STATE_KEY="$(TF_STATE_KEY)" \
	TF_STATE_RG="$(TF_STATE_RG)" \
	TF_STATE_ACCOUNT="$(TF_STATE_ACCOUNT)" \
	TF_STATE_CONTAINER="$(TF_STATE_CONTAINER)" \
	TF_BACKEND_ENV_FILE="$(TF_BACKEND_ENV_FILE)" \
	SQL_SERVER_NAME="$(SQL_SERVER_NAME)" \
	GENEVA_SUPPRESSION_ACCESS_CONFIRMED="$(GENEVA_SUPPRESSION_ACCESS_CONFIRMED)" \
	./scripts/tf-preflight.sh

tf-init: ## Initialize Terraform (requires TF_STATE_ACCOUNT for remote state)
	@if [ -z "$(TF_STATE_ACCOUNT)" ]; then \
		echo "TF_STATE_ACCOUNT is required. Run 'make tf-bootstrap' first, then:"; \
		echo "  make tf-init TF_STATE_ACCOUNT=<your-storage-account>"; \
		echo ""; \
		echo "To skip remote state (local-only dev), run:"; \
		echo "  terraform init -backend=false"; \
		exit 1; \
	fi
	terraform init \
		-backend-config="storage_account_name=$(TF_STATE_ACCOUNT)" \
		-backend-config="resource_group_name=$(TF_STATE_RG)" \
		-backend-config="container_name=$(TF_STATE_CONTAINER)" \
		-backend-config="key=$(TF_STATE_KEY)"

tf-init-local: ## Initialize Terraform without remote backend (validation/testing only)
	terraform init -backend=false

tf-init-isolated: ## Initialize Terraform with per-owner isolated state key
	@if [ -z "$(OWNER_ALIAS)" ]; then \
		echo "OWNER_ALIAS is required (expected aaffinit for final environment)."; \
		exit 1; \
	fi
	@$(MAKE) tf-init \
		OWNER_ALIAS="$(OWNER_ALIAS)" \
		TF_STATE_ACCOUNT="$(TF_STATE_ACCOUNT)" \
		TF_STATE_RG="$(TF_STATE_RG)" \
		TF_STATE_CONTAINER="$(TF_STATE_CONTAINER)" \
		TF_STATE_KEY="$(OWNER_ALIAS)-test-sre-simulator.tfstate"

tf-validate: ## Validate Terraform configuration
	terraform validate

tf-fmt: ## Format Terraform files
	terraform fmt -recursive

tf-test: ## Run Terraform native tests (requires TF >= 1.7, no credentials needed)
	@TF_VER=$$(terraform version -json 2>/dev/null | sed -n 's/.*"terraform_version":[[:space:]]*"\([^"]*\)".*/\1/p'); \
	MAJOR=$$(echo "$$TF_VER" | cut -d. -f1); \
	MINOR=$$(echo "$$TF_VER" | cut -d. -f2); \
	if [ -z "$$TF_VER" ]; then \
		echo "Unable to detect terraform version from 'terraform version -json'."; \
		exit 1; \
	fi; \
	if [ "$$MAJOR" -lt 1 ] || { [ "$$MAJOR" -eq 1 ] && [ "$$MINOR" -lt 7 ]; }; then \
		echo "terraform test with mock_provider requires Terraform >= 1.7.0 (found $$TF_VER)"; \
		exit 1; \
	fi
	terraform test

tf-plan: ## Generate and show an execution plan
	terraform plan $(TF_VAR_FLAGS) -out=tfplan

tf-apply: ## Apply the saved plan (run tf-plan first)
	terraform apply tfplan
	@echo ""
	@terraform output -raw post_apply_checklist 2>/dev/null || true

tf-destroy: ## Destroy all managed infrastructure
	terraform destroy $(TF_VAR_FLAGS)

tf-kubeconfig: ## Extract kubeconfig from ARO and write to ~/.kube/<cluster-name>
	@set -e; \
	RG=$$(terraform output -raw resource_group_name); \
	CLUSTER=$$(terraform output -raw aro_cluster_name); \
	API=$$(az aro show -g "$$RG" -n "$$CLUSTER" --query apiserverProfile.url -o tsv); \
	PASS=$$(az aro list-credentials -g "$$RG" -n "$$CLUSTER" --query kubeadminPassword -o tsv); \
	KUBECONFIG_PATH="$$HOME/.kube/$$CLUSTER"; \
	KUBECONFIG="$$KUBECONFIG_PATH" oc login "$$API" -u kubeadmin -p "$$PASS" --insecure-skip-tls-verify=true; \
	echo "Kubeconfig written to $$KUBECONFIG_PATH"; \
	echo "Usage: export KUBECONFIG=$$KUBECONFIG_PATH"

tf-output: ## Show all Terraform outputs
	terraform output
