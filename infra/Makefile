.PHONY: help tf-bootstrap tf-init tf-validate tf-plan tf-apply tf-destroy tf-kubeconfig tf-fmt tf-output

OWNER_ALIAS ?=
TF_VAR_FLAGS := $(if $(OWNER_ALIAS),-var owner_alias=$(OWNER_ALIAS),)

# Backend config – override these or supply via -backend-config at init time
TF_STATE_RG           ?= tfstate-rg
TF_STATE_ACCOUNT      ?=
TF_STATE_CONTAINER    ?= tfstate
TF_STATE_KEY          ?= sre-simulator.tfstate

help: ## Show this help
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-24s\033[0m %s\n", $$1, $$2}'

tf-bootstrap: ## Create Azure Storage Account for Terraform remote state (one-time)
	@if [ -z "$(TF_STATE_ACCOUNT)" ]; then \
		echo "Set TF_STATE_ACCOUNT to a globally unique storage account name."; \
		exit 1; \
	fi
	az group create --name "$(TF_STATE_RG)" --location eastus --tags purpose=terraform-state
	az storage account create \
		--name "$(TF_STATE_ACCOUNT)" \
		--resource-group "$(TF_STATE_RG)" \
		--location eastus \
		--sku Standard_LRS \
		--min-tls-version TLS1_2 \
		--allow-blob-public-access false \
		--tags purpose=terraform-state
	az storage container create \
		--name "$(TF_STATE_CONTAINER)" \
		--account-name "$(TF_STATE_ACCOUNT)"
	@echo "Terraform backend storage ready."
	@echo "Update infra/backend.tf with: storage_account_name = \"$(TF_STATE_ACCOUNT)\""

tf-init: ## Initialize Terraform (use TF_STATE_ACCOUNT to override backend)
	$(if $(TF_STATE_ACCOUNT), \
		terraform init \
			-backend-config="storage_account_name=$(TF_STATE_ACCOUNT)" \
			-backend-config="resource_group_name=$(TF_STATE_RG)" \
			-backend-config="container_name=$(TF_STATE_CONTAINER)" \
			-backend-config="key=$(TF_STATE_KEY)", \
		terraform init)

tf-validate: ## Validate Terraform configuration
	terraform validate

tf-fmt: ## Format Terraform files
	terraform fmt -recursive

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
