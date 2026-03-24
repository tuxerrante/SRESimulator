.PHONY: help install install-backend clean \
       fmt fmt-check \
       lint lint-ts lint-backend lint-unused-exports lint-yaml lint-md \
       typecheck typecheck-backend validate \
       security audit lockfile-lint grype \
       test smoke-local-vertex env-check e2e-azure-route e2e-azure-route-up e2e-azure-route-down \
       prod-up prod-down prod-status \
       build dev start \
       docker-build-frontend docker-build-backend docker-build \
       pre-commit all \
       tf-bootstrap tf-init tf-validate tf-fmt tf-test tf-plan tf-apply tf-destroy tf-kubeconfig tf-output

FRONTEND_DIR := frontend
BACKEND_DIR := backend
E2E_ENV_FILE ?= $(BACKEND_DIR)/.env.local
-include $(E2E_ENV_FILE)
SECURITY_FAIL_LEVEL ?= high
GRYPE_VERSION ?= v0.110.0
GRYPE_IMAGE ?= anchore/grype:$(GRYPE_VERSION)@sha256:af65fbc0c664691067788fe95ff88760b435543e45595eb2ca6f102fc476fbe1
NPM_VERSION ?= $(shell tr -d '\n' < .npm-version)
AZURE_SUBSCRIPTION_ID ?=
ARO_RG ?=
ARO_CLUSTER ?=
AOAI_RG ?=
AOAI_ACCOUNT ?=
AOAI_DEPLOYMENT ?=
E2E_NAMESPACE_PREFIX ?= sre-manual-e2e
E2E_RELEASE ?= sre-simulator
E2E_METADATA_FILE ?= data/e2e-azure-route.env
E2E_REQUIRED_VARS := AZURE_SUBSCRIPTION_ID ARO_RG ARO_CLUSTER AOAI_RG AOAI_ACCOUNT AOAI_DEPLOYMENT
PROD_NAMESPACE ?= sre-simulator
PROD_METADATA_FILE ?= data/prod-route.env

define e2e_var_source
$(if $(findstring environment,$(origin $(1))),shell,$(if $(findstring command line,$(origin $(1))),shell (command line),$(if $(filter file,$(origin $(1))),$(E2E_ENV_FILE),make ($(origin $(1))))))
endef

E2E_MISSING_VARS := $(strip \
  $(if $(strip $(AZURE_SUBSCRIPTION_ID)),,AZURE_SUBSCRIPTION_ID) \
  $(if $(strip $(ARO_RG)),,ARO_RG) \
  $(if $(strip $(ARO_CLUSTER)),,ARO_CLUSTER) \
  $(if $(strip $(AOAI_RG)),,AOAI_RG) \
  $(if $(strip $(AOAI_ACCOUNT)),,AOAI_ACCOUNT) \
  $(if $(strip $(AOAI_DEPLOYMENT)),,AOAI_DEPLOYMENT))

# ──────────────────────────────────────────────
# Help
# ──────────────────────────────────────────────
help: ## Show this help
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-24s\033[0m %s\n", $$1, $$2}'

# ──────────────────────────────────────────────
# Setup
# ──────────────────────────────────────────────
install: ## Install all dependencies
	cd $(FRONTEND_DIR) && npm ci
	cd $(BACKEND_DIR) && npm ci
	@if [ "$$CI" = "true" ]; then \
		echo "CI detected; skipping pre-commit hook installation"; \
	elif command -v pre-commit >/dev/null 2>&1; then \
		pre-commit install; \
	else \
		echo "pre-commit not found. Skipping pre-commit hook installation."; \
	fi

install-backend: ## Install backend dependencies
	cd $(BACKEND_DIR) && npm ci

clean: ## Remove build artifacts and node_modules
	rm -rf $(FRONTEND_DIR)/.next $(FRONTEND_DIR)/node_modules
	rm -rf $(BACKEND_DIR)/dist $(BACKEND_DIR)/node_modules

# ──────────────────────────────────────────────
# Formatting
# ──────────────────────────────────────────────
fmt: ## Auto-fix formatting (eslint, markdownlint)
	cd $(FRONTEND_DIR) && npx eslint --fix .
	cd $(BACKEND_DIR) && npx eslint --fix .
	npx markdownlint --fix '**/*.md' --ignore '**/node_modules/**'

fmt-check: ## Check formatting without modifying files
	cd $(FRONTEND_DIR) && npx eslint .
	cd $(BACKEND_DIR) && npx eslint .
	npx markdownlint '**/*.md' --ignore '**/node_modules/**'

# ──────────────────────────────────────────────
# Linting
# ──────────────────────────────────────────────
lint: lint-ts lint-backend lint-yaml lint-md ## Run all linters

lint-ts: ## Lint frontend TypeScript/React with eslint
	cd $(FRONTEND_DIR) && npx eslint .

lint-backend: ## Lint backend TypeScript with eslint
	cd $(BACKEND_DIR) && npx eslint .

lint-yaml: ## Lint YAML files with yamllint
	find . \( -path './helm' -o -path './helm/*' -o -path '*/node_modules' -o -path '*/node_modules/*' \) -prune -o -type f \( -name '*.yml' -o -name '*.yaml' \) -print0 | xargs -0 -r yamllint --strict

lint-md: ## Lint Markdown files with markdownlint
	npx markdownlint-cli '**/*.md' --ignore '**/node_modules/**'

lint-unused-exports: ## Check for unused TypeScript exports (backend + shared)
	cd $(BACKEND_DIR) && npx ts-unused-exports tsconfig.json \
		--excludePathsFromReport='shared/types' \
		--ignoreTestFiles \
		--allowUnusedTypes \
		--showLineNumber \
		--exitWithCount

# ──────────────────────────────────────────────
# Type checking & validation
# ──────────────────────────────────────────────
typecheck: ## Run frontend TypeScript type checking
	cd $(FRONTEND_DIR) && rm -rf .next && npx tsc --noEmit

typecheck-backend: ## Run backend TypeScript type checking
	cd $(BACKEND_DIR) && npx tsc --noEmit

validate: lint typecheck typecheck-backend ## Run all linters + type checking

# ──────────────────────────────────────────────
# Security
# ──────────────────────────────────────────────
security: audit lockfile-lint grype ## Run all security checks

audit: ## Check npm dependencies for known vulnerabilities
	cd $(FRONTEND_DIR) && npm audit --audit-level=$(SECURITY_FAIL_LEVEL)

lockfile-lint: ## Validate lockfile integrity (registry & HTTPS)
	cd $(FRONTEND_DIR) && npx lockfile-lint \
		--path package-lock.json \
		--type npm \
		--allowed-hosts npm \
		--validate-https

grype: ## Scan frontend/backend dependencies with Grype (high/critical)
	@set -e; \
	if command -v grype >/dev/null 2>&1; then \
		GRYPE_DB_AUTO_UPDATE=true grype "dir:$(FRONTEND_DIR)" --fail-on $(SECURITY_FAIL_LEVEL) --only-fixed; \
		GRYPE_DB_AUTO_UPDATE=true grype "dir:$(BACKEND_DIR)" --fail-on $(SECURITY_FAIL_LEVEL) --only-fixed; \
	elif command -v docker >/dev/null 2>&1; then \
		mkdir -p "$$HOME/.cache/grype"; \
		docker run --rm -e GRYPE_DB_AUTO_UPDATE=true -v "$$HOME/.cache/grype:/root/.cache/grype" -v "$$(pwd):/work" -w /work "$(GRYPE_IMAGE)" "dir:$(FRONTEND_DIR)" --fail-on $(SECURITY_FAIL_LEVEL) --only-fixed; \
		docker run --rm -e GRYPE_DB_AUTO_UPDATE=true -v "$$HOME/.cache/grype:/root/.cache/grype" -v "$$(pwd):/work" -w /work "$(GRYPE_IMAGE)" "dir:$(BACKEND_DIR)" --fail-on $(SECURITY_FAIL_LEVEL) --only-fixed; \
	else \
		echo "grype scanner requires either grype CLI or docker."; \
		exit 1; \
	fi

# ──────────────────────────────────────────────
# Testing
# ──────────────────────────────────────────────
test: ## Run backend and frontend unit tests with coverage
	cd $(BACKEND_DIR) && npm run test:coverage
	cd $(FRONTEND_DIR) && npm run test:coverage

smoke-local-vertex: ## Run local backend live probe using Vertex env from frontend/.env.local
	@set -e; \
	if [ ! -f "$(FRONTEND_DIR)/.env.local" ]; then \
		echo "Missing $(FRONTEND_DIR)/.env.local with Vertex settings"; \
		exit 1; \
	fi; \
	set -a; . "$(FRONTEND_DIR)/.env.local"; set +a; \
	if [ -z "$${CLOUD_ML_REGION:-}" ] || [ -z "$${ANTHROPIC_VERTEX_PROJECT_ID:-}" ]; then \
		echo "CLOUD_ML_REGION and ANTHROPIC_VERTEX_PROJECT_ID must be set in $(FRONTEND_DIR)/.env.local"; \
		exit 1; \
	fi; \
	echo "Starting backend on http://127.0.0.1:8081 (temporary)"; \
	PORT=8081 AI_PROVIDER=vertex AI_MOCK_MODE=false AI_STRICT_STARTUP=true AI_MODEL="$${AI_MODEL:-claude-sonnet-4@20250514}" CLOUD_ML_REGION="$$CLOUD_ML_REGION" ANTHROPIC_VERTEX_PROJECT_ID="$$ANTHROPIC_VERTEX_PROJECT_ID" npm --prefix "$(BACKEND_DIR)" run dev >/tmp/sre-backend-vertex.log 2>&1 & \
	PID=$$!; \
	trap 'kill $$PID >/dev/null 2>&1 || true' EXIT INT TERM; \
	READY=0; \
	i=0; \
	while [ $$i -lt 30 ]; do \
		if curl -fsS -o /dev/null "http://127.0.0.1:8081/readyz"; then \
			READY=1; \
			break; \
		fi; \
		i=$$((i + 1)); \
		sleep 1; \
	done; \
	if [ "$$READY" -ne 1 ]; then \
		echo "Backend did not become ready within 30 seconds"; \
		exit 1; \
	fi; \
	echo "Readiness:"; \
	curl -sS "http://127.0.0.1:8081/api/ai/readiness"; echo; \
	echo "Live probe:"; \
	curl -sS "http://127.0.0.1:8081/api/ai/probe?live=true"; echo; \
	echo "Backend logs are at /tmp/sre-backend-vertex.log"; \
	kill $$PID >/dev/null 2>&1 || true

e2e-azure-route: e2e-azure-route-up ## Create temporary Azure OpenAI-backed route for manual UI testing

env-check: ## Show source of required e2e vars (values hidden)
	@echo "E2E variable source check (values hidden):"
	@echo "  AZURE_SUBSCRIPTION_ID: $(call e2e_var_source,AZURE_SUBSCRIPTION_ID)"
	@echo "  ARO_RG: $(call e2e_var_source,ARO_RG)"
	@echo "  ARO_CLUSTER: $(call e2e_var_source,ARO_CLUSTER)"
	@echo "  AOAI_RG: $(call e2e_var_source,AOAI_RG)"
	@echo "  AOAI_ACCOUNT: $(call e2e_var_source,AOAI_ACCOUNT)"
	@echo "  AOAI_DEPLOYMENT: $(call e2e_var_source,AOAI_DEPLOYMENT)"
	@if [ -n "$(E2E_MISSING_VARS)" ]; then \
		echo "Missing required e2e vars: $(E2E_MISSING_VARS)"; \
		exit 1; \
	fi

e2e-azure-route-up: env-check ## Build+deploy frontend/backend to ARO and print temporary UI route URL
	@set -e; \
	if [ -n "$(E2E_MISSING_VARS)" ]; then \
		echo "Missing required env vars. Export: AZURE_SUBSCRIPTION_ID, ARO_RG, ARO_CLUSTER, AOAI_RG, AOAI_ACCOUNT, AOAI_DEPLOYMENT (or set them in $(E2E_ENV_FILE))."; \
		exit 1; \
	fi; \
	TS=$$(date +%Y%m%d-%H%M%S); \
	NS="$(E2E_NAMESPACE_PREFIX)-$$TS"; \
	TAG="e2e$$TS"; \
	PROBE_TOKEN="probe-$$TS"; \
	echo "Using namespace: $$NS"; \
	az account set -s "$(AZURE_SUBSCRIPTION_ID)" >/dev/null; \
	API=$$(az aro show -g "$(ARO_RG)" -n "$(ARO_CLUSTER)" --query apiserverProfile.url -o tsv); \
	PASS=$$(az aro list-credentials -g "$(ARO_RG)" -n "$(ARO_CLUSTER)" --query kubeadminPassword -o tsv); \
	oc login "$$API" -u kubeadmin -p "$$PASS" --insecure-skip-tls-verify=true >/dev/null; \
	AOAI_ENDPOINT=$$(az cognitiveservices account show -g "$(AOAI_RG)" -n "$(AOAI_ACCOUNT)" --query properties.endpoint -o tsv | sed 's:/*$$::'); \
	AOAI_KEY=$$(az cognitiveservices account keys list -g "$(AOAI_RG)" -n "$(AOAI_ACCOUNT)" --query key1 -o tsv); \
	oc create namespace "$$NS" >/dev/null; \
	oc -n "$$NS" create secret generic azure-openai-creds --from-literal=endpoint="$$AOAI_ENDPOINT" --from-literal=api-key="$$AOAI_KEY" >/dev/null; \
	oc -n "$$NS" new-build --name=sre-simulator-frontend --binary=true --strategy=docker --to=sre-simulator-frontend:$$TAG >/dev/null; \
	oc -n "$$NS" new-build --name=sre-simulator-backend --binary=true --strategy=docker --to=sre-simulator-backend:$$TAG >/dev/null; \
	oc -n "$$NS" patch bc/sre-simulator-frontend --type=merge -p '{"spec":{"strategy":{"dockerStrategy":{"dockerfilePath":"frontend/Dockerfile","buildArgs":[{"name":"NPM_VERSION","value":"$(NPM_VERSION)"}]}}}}' >/dev/null; \
	oc -n "$$NS" patch bc/sre-simulator-backend --type=merge -p '{"spec":{"strategy":{"dockerStrategy":{"dockerfilePath":"backend/Dockerfile","buildArgs":[{"name":"NPM_VERSION","value":"$(NPM_VERSION)"}]}}}}' >/dev/null; \
	oc -n "$$NS" start-build sre-simulator-frontend --from-dir=. --follow --wait >/dev/null; \
	oc -n "$$NS" start-build sre-simulator-backend --from-dir=. --follow --wait >/dev/null; \
	DOMAIN=$$(oc get ingresses.config/cluster -o jsonpath='{.spec.domain}'); \
	HOST="$$NS.$${DOMAIN}"; \
	helm upgrade --install "$(E2E_RELEASE)" ./helm/sre-simulator -n "$$NS" \
		--set route.host="$$HOST" \
		--set frontend.image.repository="image-registry.openshift-image-registry.svc:5000/$$NS/sre-simulator-frontend" \
		--set frontend.image.tag="$$TAG" \
		--set frontend.image.pullPolicy=Always \
		--set backend.image.repository="image-registry.openshift-image-registry.svc:5000/$$NS/sre-simulator-backend" \
		--set backend.image.tag="$$TAG" \
		--set backend.image.pullPolicy=Always \
		--set ai.provider=azure-openai \
		--set ai.mockMode=false \
		--set ai.strictStartup=true \
		--set ai.model="$(AOAI_DEPLOYMENT)" \
		--set-string ai.liveProbeToken="$$PROBE_TOKEN" \
		--set ai.azureOpenai.endpointFromSecret.existingSecretName=azure-openai-creds \
		--set ai.azureOpenai.endpointFromSecret.key=endpoint \
		--set ai.azureOpenai.deployment="$(AOAI_DEPLOYMENT)" \
		--set ai.azureOpenai.apiVersion=2024-10-21 \
		--set ai.azureOpenai.credentials.existingSecretName=azure-openai-creds \
		--set ai.azureOpenai.credentials.key=api-key \
		--wait --timeout 15m >/dev/null; \
	oc -n "$$NS" rollout status deployment/$(E2E_RELEASE)-frontend --timeout=6m >/dev/null; \
	oc -n "$$NS" rollout status deployment/$(E2E_RELEASE)-backend --timeout=6m >/dev/null; \
	mkdir -p "$$(dirname "$(E2E_METADATA_FILE)")"; \
	printf 'NS=%s\nRELEASE=%s\nURL=%s\nTAG=%s\n' "$$NS" "$(E2E_RELEASE)" "https://$$HOST" "$$TAG" > "$(E2E_METADATA_FILE)"; \
	PROBE_CODE=""; \
	i=0; \
	while [ $$i -lt 10 ]; do \
		PROBE_CODE=$$(curl -ksS -H "x-ai-probe-token: $$PROBE_TOKEN" -o /dev/null -w '%{http_code}' "https://$$HOST/api/ai/probe?live=true" || true); \
		if [ "$$PROBE_CODE" = "200" ]; then break; fi; \
		i=$$((i + 1)); \
		sleep 2; \
	done; \
	if [ "$$PROBE_CODE" != "200" ]; then \
		echo "Probe failed with status $$PROBE_CODE"; \
		curl -ksS -H "x-ai-probe-token: $$PROBE_TOKEN" "https://$$HOST/api/ai/probe?live=true" || true; \
		echo; \
		exit 1; \
	fi; \
	echo "Manual e2e environment is ready."; \
	echo "URL: https://$$HOST"; \
	echo "Probe status: $$PROBE_CODE"; \
	echo "Metadata saved to $(E2E_METADATA_FILE)"

e2e-azure-route-down: ## Delete temporary Azure OpenAI e2e namespace (uses NS=... or metadata file)
	@set -e; \
	if [ -n "$${NS:-}" ]; then \
		TARGET_NS="$$NS"; \
	elif [ -f "$(E2E_METADATA_FILE)" ]; then \
		. "$(E2E_METADATA_FILE)"; \
		TARGET_NS="$$NS"; \
	else \
		echo "Set NS=<namespace> or run e2e-azure-route-up first."; \
		exit 1; \
	fi; \
	if [ "$$TARGET_NS" = "$(PROD_NAMESPACE)" ]; then \
		echo "REFUSED: $$TARGET_NS is the production namespace."; \
		echo "Use 'make prod-down' (with confirmation) to delete it."; \
		exit 1; \
	fi; \
	echo "Deleting namespace $$TARGET_NS"; \
	oc delete namespace "$$TARGET_NS" --wait=false >/dev/null; \
	oc wait --for=delete "namespace/$$TARGET_NS" --timeout=10m >/dev/null || true; \
	if [ -f "$(E2E_METADATA_FILE)" ]; then rm -f "$(E2E_METADATA_FILE)"; fi; \
	echo "Temporary e2e environment removed."

# ──────────────────────────────────────────────
# Production namespace (stable deployment, shared cluster + AOAI)
# ──────────────────────────────────────────────
prod-up: env-check ## Deploy to stable production namespace (same cluster + AOAI as e2e)
	@set -e; \
	NS="$(PROD_NAMESPACE)"; \
	TAG="prod$$(date +%Y%m%d-%H%M%S)"; \
	PROBE_TOKEN="probe-prod-$$(date +%s)"; \
	echo "Deploying to PRODUCTION namespace: $$NS"; \
	az account set -s "$(AZURE_SUBSCRIPTION_ID)" >/dev/null; \
	API=$$(az aro show -g "$(ARO_RG)" -n "$(ARO_CLUSTER)" --query apiserverProfile.url -o tsv); \
	PASS=$$(az aro list-credentials -g "$(ARO_RG)" -n "$(ARO_CLUSTER)" --query kubeadminPassword -o tsv); \
	oc login "$$API" -u kubeadmin -p "$$PASS" --insecure-skip-tls-verify=true >/dev/null; \
	AOAI_ENDPOINT=$$(az cognitiveservices account show -g "$(AOAI_RG)" -n "$(AOAI_ACCOUNT)" --query properties.endpoint -o tsv | sed 's:/*$$::'); \
	AOAI_KEY=$$(az cognitiveservices account keys list -g "$(AOAI_RG)" -n "$(AOAI_ACCOUNT)" --query key1 -o tsv); \
	oc create namespace "$$NS" 2>/dev/null || true; \
	oc -n "$$NS" delete secret azure-openai-creds 2>/dev/null || true; \
	oc -n "$$NS" create secret generic azure-openai-creds --from-literal=endpoint="$$AOAI_ENDPOINT" --from-literal=api-key="$$AOAI_KEY" >/dev/null; \
	if ! oc -n "$$NS" get bc/sre-simulator-frontend >/dev/null 2>&1; then \
		oc -n "$$NS" new-build --name=sre-simulator-frontend --binary=true --strategy=docker --to=sre-simulator-frontend:$$TAG >/dev/null; \
		oc -n "$$NS" new-build --name=sre-simulator-backend --binary=true --strategy=docker --to=sre-simulator-backend:$$TAG >/dev/null; \
		oc -n "$$NS" patch bc/sre-simulator-frontend --type=merge -p '{"spec":{"strategy":{"dockerStrategy":{"dockerfilePath":"frontend/Dockerfile","buildArgs":[{"name":"NPM_VERSION","value":"$(NPM_VERSION)"}]}}}}' >/dev/null; \
		oc -n "$$NS" patch bc/sre-simulator-backend --type=merge -p '{"spec":{"strategy":{"dockerStrategy":{"dockerfilePath":"backend/Dockerfile","buildArgs":[{"name":"NPM_VERSION","value":"$(NPM_VERSION)"}]}}}}' >/dev/null; \
	fi; \
	oc -n "$$NS" start-build sre-simulator-frontend --from-dir=. --follow --wait >/dev/null; \
	oc -n "$$NS" start-build sre-simulator-backend --from-dir=. --follow --wait >/dev/null; \
	DOMAIN=$$(oc get ingresses.config/cluster -o jsonpath='{.spec.domain}'); \
	HOST="$$NS.$${DOMAIN}"; \
	helm upgrade --install "$(E2E_RELEASE)" ./helm/sre-simulator -n "$$NS" \
		--set route.host="$$HOST" \
		--set frontend.image.repository="image-registry.openshift-image-registry.svc:5000/$$NS/sre-simulator-frontend" \
		--set frontend.image.tag="$$TAG" \
		--set frontend.image.pullPolicy=Always \
		--set backend.image.repository="image-registry.openshift-image-registry.svc:5000/$$NS/sre-simulator-backend" \
		--set backend.image.tag="$$TAG" \
		--set backend.image.pullPolicy=Always \
		--set ai.provider=azure-openai \
		--set ai.mockMode=false \
		--set ai.strictStartup=true \
		--set ai.model="$(AOAI_DEPLOYMENT)" \
		--set-string ai.liveProbeToken="$$PROBE_TOKEN" \
		--set ai.azureOpenai.endpointFromSecret.existingSecretName=azure-openai-creds \
		--set ai.azureOpenai.endpointFromSecret.key=endpoint \
		--set ai.azureOpenai.deployment="$(AOAI_DEPLOYMENT)" \
		--set ai.azureOpenai.apiVersion=2024-10-21 \
		--set ai.azureOpenai.credentials.existingSecretName=azure-openai-creds \
		--set ai.azureOpenai.credentials.key=api-key \
		--wait --timeout 15m >/dev/null; \
	oc -n "$$NS" rollout status deployment/$(E2E_RELEASE)-frontend --timeout=6m >/dev/null; \
	oc -n "$$NS" rollout status deployment/$(E2E_RELEASE)-backend --timeout=6m >/dev/null; \
	mkdir -p "$$(dirname "$(PROD_METADATA_FILE)")"; \
	printf 'NS=%s\nRELEASE=%s\nURL=%s\nTAG=%s\n' "$$NS" "$(E2E_RELEASE)" "https://$$HOST" "$$TAG" > "$(PROD_METADATA_FILE)"; \
	echo "Production deployment ready."; \
	echo "URL: https://$$HOST"; \
	echo "Metadata saved to $(PROD_METADATA_FILE)"

prod-down: ## Delete production namespace (REQUIRES CONFIRMATION – type namespace name)
	@set -e; \
	NS="$(PROD_NAMESPACE)"; \
	echo ""; \
	echo "╔═══════════════════════════════════════════════════════╗"; \
	echo "║  WARNING: You are about to delete the PRODUCTION     ║"; \
	echo "║  namespace '$$NS'.                                   ║"; \
	echo "║                                                       ║"; \
	echo "║  This will destroy ALL resources in that namespace.   ║"; \
	echo "║  The Azure OpenAI deployment will NOT be affected.    ║"; \
	echo "╚═══════════════════════════════════════════════════════╝"; \
	echo ""; \
	printf "Type the namespace name to confirm deletion: "; \
	read CONFIRM; \
	if [ "$$CONFIRM" != "$$NS" ]; then \
		echo "Confirmation failed. Expected '$$NS', got '$$CONFIRM'."; \
		exit 1; \
	fi; \
	echo "Deleting production namespace $$NS"; \
	oc delete namespace "$$NS" --wait=false >/dev/null; \
	oc wait --for=delete "namespace/$$NS" --timeout=10m >/dev/null || true; \
	if [ -f "$(PROD_METADATA_FILE)" ]; then rm -f "$(PROD_METADATA_FILE)"; fi; \
	echo "Production namespace removed. Azure OpenAI resources remain intact."

prod-status: ## Show production namespace status (pods, route URL)
	@set -e; \
	NS="$(PROD_NAMESPACE)"; \
	if ! oc get namespace "$$NS" >/dev/null 2>&1; then \
		echo "Production namespace '$$NS' does not exist. Run 'make prod-up' to create it."; \
		exit 0; \
	fi; \
	echo "Namespace: $$NS"; \
	echo ""; \
	echo "Pods:"; \
	oc -n "$$NS" get pods -o wide 2>/dev/null || echo "  (no pods)"; \
	echo ""; \
	echo "Route:"; \
	oc -n "$$NS" get route 2>/dev/null || echo "  (no routes)"; \
	echo ""; \
	echo "Deployments:"; \
	oc -n "$$NS" get deployments 2>/dev/null || echo "  (no deployments)"

# ──────────────────────────────────────────────
# Build & Run
# ──────────────────────────────────────────────
build: ## Build the Next.js production bundle
	cd $(FRONTEND_DIR) && npm run build

dev: ## Start Next.js dev server
	cd $(FRONTEND_DIR) && npm run dev

start: build ## Build and start production server
	cd $(FRONTEND_DIR) && npm run start

# ──────────────────────────────────────────────
# Docker
# ──────────────────────────────────────────────
docker-build-frontend: ## Build frontend Docker image
	docker build --build-arg NPM_VERSION=$(NPM_VERSION) -f $(FRONTEND_DIR)/Dockerfile -t sre-simulator-frontend .

docker-build-backend: ## Build backend Docker image
	docker build --build-arg NPM_VERSION=$(NPM_VERSION) -f $(BACKEND_DIR)/Dockerfile -t sre-simulator-backend .

docker-build: docker-build-frontend docker-build-backend ## Build all Docker images

# ──────────────────────────────────────────────
# Aggregate targets
# ──────────────────────────────────────────────
pre-commit: ## Run pre-commit hooks on all files
	pre-commit run --all-files

all: validate security build ## Full CI pipeline: lint + typecheck + security + build

# ──────────────────────────────────────────────
# Infrastructure (delegates to infra/Makefile)
# ──────────────────────────────────────────────
tf-bootstrap: ## Create Azure Storage for Terraform remote state (one-time)
	$(MAKE) -C infra tf-bootstrap

tf-init: ## Terraform init (see infra/Makefile for options)
	$(MAKE) -C infra tf-init

tf-validate: ## Validate Terraform configuration
	$(MAKE) -C infra tf-validate

tf-fmt: ## Format Terraform files
	$(MAKE) -C infra tf-fmt

tf-test: ## Run Terraform unit tests (no credentials needed)
	$(MAKE) -C infra tf-test

tf-plan: ## Terraform plan
	$(MAKE) -C infra tf-plan

tf-apply: ## Terraform apply
	$(MAKE) -C infra tf-apply

tf-destroy: ## Terraform destroy
	$(MAKE) -C infra tf-destroy

tf-kubeconfig: ## Extract kubeconfig from ARO cluster
	$(MAKE) -C infra tf-kubeconfig

tf-output: ## Show all Terraform outputs
	$(MAKE) -C infra tf-output
