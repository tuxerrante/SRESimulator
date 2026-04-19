.PHONY: help install install-backend clean \
       fmt fmt-check \
       lint lint-ts lint-backend lint-unused-exports lint-yaml lint-md \
       typecheck typecheck-backend validate \
       security audit lockfile-lint gitleaks grype \
       test test-shell test-integration test-mssql dev-db smoke-backend-mssql smoke-local-vertex env-check aro-login e2e-azure-route e2e-azure-route-up e2e-azure-route-refresh e2e-azure-route-down \
       prod-up prod-up-tag prod-down prod-status public-exposure-audit db-mode-check db-port-forward-check db-inspect db-inspect-live geneva-suppression-check prod-up-final \
       build dev start capture-readme-hero \
       docker-build-frontend docker-build-backend docker-build \
       pre-commit all \
       tf-bootstrap tf-pull-secret tf-preflight tf-init tf-init-local tf-init-isolated tf-validate tf-fmt tf-test tf-plan tf-apply tf-destroy tf-kubeconfig tf-output

SHELL := /bin/bash

FRONTEND_DIR := frontend
BACKEND_DIR := backend
E2E_ENV_FILE ?= $(BACKEND_DIR)/.env.local
-include $(E2E_ENV_FILE)
SECURITY_FAIL_LEVEL ?= high
GRYPE_VERSION ?= v0.110.0
GRYPE_IMAGE ?= anchore/grype:$(GRYPE_VERSION)@sha256:af65fbc0c664691067788fe95ff88760b435543e45595eb2ca6f102fc476fbe1
GITLEAKS_VERSION ?= v8.30.0
GITLEAKS_IMAGE ?= ghcr.io/gitleaks/gitleaks:$(GITLEAKS_VERSION)@sha256:691af3c7c5a48b16f187ce3446d5f194838f91238f27270ed36eef6359a574d9
NPM_VERSION ?= $(shell tr -d '\n' < .npm-version)
AZURE_SUBSCRIPTION_ID ?=
ARO_RG ?=
ARO_CLUSTER ?=
AOAI_RG ?=
AOAI_ACCOUNT ?=
AOAI_DEPLOYMENT ?=
AOAI_DEPLOYMENT_CHAT ?=
AOAI_DEPLOYMENT_COMMAND ?=
AOAI_DEPLOYMENT_SCENARIO ?=
AOAI_DEPLOYMENT_PROBE ?=
E2E_NAMESPACE_PREFIX ?= sre-manual-e2e
E2E_RELEASE ?= sre-simulator
E2E_METADATA_FILE ?= data/e2e-azure-route.env
E2E_REQUIRED_VARS := AZURE_SUBSCRIPTION_ID ARO_RG ARO_CLUSTER AOAI_RG AOAI_ACCOUNT AOAI_DEPLOYMENT
PROD_NAMESPACE ?= sre-simulator
PROD_METADATA_FILE ?= data/prod-route.env
GENEVA_SUPPRESSION_RULE_ACTIVE ?= false
# Optional: when set with DB_SECRET_NAME, copy the DB secret from this namespace into the E2E namespace before Helm.
# If unset, the copy step uses PROD_NAMESPACE (same default as stable prod): $(PROD_NAMESPACE)
DB_SECRET_SOURCE_NAMESPACE ?=

export AZURE_SUBSCRIPTION_ID ARO_RG ARO_CLUSTER
export AOAI_RG AOAI_ACCOUNT AOAI_DEPLOYMENT
export AOAI_DEPLOYMENT_CHAT AOAI_DEPLOYMENT_COMMAND AOAI_DEPLOYMENT_SCENARIO AOAI_DEPLOYMENT_PROBE
export E2E_RELEASE NPM_VERSION
export PROD_NAMESPACE DB_SECRET_NAME DB_SECRET_SOURCE_NAMESPACE

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

ARO_LOGIN_MISSING_VARS := $(strip \
  $(if $(strip $(AZURE_SUBSCRIPTION_ID)),,AZURE_SUBSCRIPTION_ID) \
  $(if $(strip $(ARO_RG)),,ARO_RG) \
  $(if $(strip $(ARO_CLUSTER)),,ARO_CLUSTER))

# ──────────────────────────────────────────────
# Help
# ──────────────────────────────────────────────
help: ## Show this help
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		LC_ALL=C sort -t ':' -k1,1 | \
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
security: audit lockfile-lint gitleaks grype ## Run all security checks

audit: ## Check npm dependencies for known vulnerabilities
	cd $(FRONTEND_DIR) && npm audit --audit-level=$(SECURITY_FAIL_LEVEL)

lockfile-lint: ## Validate lockfile integrity (registry & HTTPS)
	cd $(FRONTEND_DIR) && npx lockfile-lint \
		--path package-lock.json \
		--type npm \
		--allowed-hosts npm \
		--validate-https

gitleaks: ## Scan repository for hardcoded secrets
	@set -e; \
	if command -v gitleaks >/dev/null 2>&1; then \
		gitleaks detect --no-git --source . --config .gitleaks.toml --redact; \
	elif command -v docker >/dev/null 2>&1; then \
		docker run --rm -v "$$(pwd):/work" -w /work "$(GITLEAKS_IMAGE)" detect --no-git --source . --config .gitleaks.toml --redact; \
	else \
		echo "gitleaks scanner requires either gitleaks CLI or docker."; \
		exit 1; \
	fi

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

test-shell: ## Run shell regression tests
	bash scripts/aro-login.test.sh
	bash scripts/prod-db-guard.test.sh

test-integration: test-shell ## Run backend integration tests (full API game flow, mock mode)
	cd $(BACKEND_DIR) && npm run test:integration

MSSQL_SA_PASSWORD ?= DevPass@123!
MSSQL_DATABASE_URL ?= Server=localhost;Database=sresimulator;User Id=sa;Password=$(MSSQL_SA_PASSWORD);TrustServerCertificate=true

dev-db: ## Start Azure SQL Edge container for local development
	docker compose up -d sqlserver
	@echo "Waiting for SQL Edge to accept connections..."
	@until node -e " \
		const s = require('net').createConnection(1433, 'localhost'); \
		s.on('connect', () => { s.end(); process.exit(0); }); \
		s.on('error', () => process.exit(1)); \
		setTimeout(() => process.exit(1), 2000);" 2>/dev/null; do \
		sleep 2; \
	done
	@echo "TCP ready, waiting for SQL engine..."
	@until NODE_PATH=$(CURDIR)/$(BACKEND_DIR)/node_modules node -e " \
		const sql = require('mssql'); \
		sql.connect('Server=localhost;User Id=sa;Password=$(MSSQL_SA_PASSWORD);TrustServerCertificate=true') \
		  .then(p => p.request().query('SELECT 1').then(() => p.close())) \
		  .then(() => process.exit(0)) \
		  .catch(() => process.exit(1));" 2>/dev/null; do \
		sleep 2; \
	done
	@NODE_PATH=$(CURDIR)/$(BACKEND_DIR)/node_modules node -e " \
		const sql = require('mssql'); \
		sql.connect('Server=localhost;User Id=sa;Password=$(MSSQL_SA_PASSWORD);TrustServerCertificate=true') \
		  .then(p => p.request().query(\"IF DB_ID('sresimulator') IS NULL CREATE DATABASE sresimulator\") \
		    .then(() => p.close())) \
		  .then(() => { console.log('Database sresimulator ensured'); process.exit(0); }) \
		  .catch(e => { console.error(e.message); process.exit(1); });"
	@echo "SQL Edge ready on localhost:1433 (database: sresimulator)"

test-mssql: dev-db ## Run MSSQL integration tests against local SQL Edge container
	cd $(BACKEND_DIR) && STORAGE_BACKEND=mssql \
		DATABASE_URL="$(MSSQL_DATABASE_URL)" \
		npx vitest run -c vitest.integration.config.ts

smoke-backend-mssql: ## Start backend with MSSQL and verify DB-backed route responds
	@set -e; \
	PORT="$${PORT:-18081}"; \
	LOG_FILE="$${LOG_FILE:-/tmp/sre-backend-mssql-smoke.log}"; \
	RESPONSE_FILE="$$(mktemp /tmp/sre-db-smoke-response.XXXXXX.json)"; \
	if ! NODE_PATH="$(CURDIR)/$(BACKEND_DIR)/node_modules" DATABASE_URL="$(MSSQL_DATABASE_URL)" node -e " \
		const sql = require('mssql'); \
		sql.connect(process.env.DATABASE_URL) \
		  .then(pool => pool.request().query('SELECT 1').then(() => pool.close())) \
		  .then(() => process.exit(0)) \
		  .catch(() => process.exit(1));"; then \
		echo "MSSQL endpoint is not reachable at DATABASE_URL."; \
		echo "Run 'make dev-db' locally or provide a reachable MSSQL endpoint."; \
		exit 1; \
	fi; \
	echo "Starting backend with STORAGE_BACKEND=mssql on port $$PORT"; \
	STORAGE_BACKEND=mssql \
	DATABASE_URL="$(MSSQL_DATABASE_URL)" \
	AI_MOCK_MODE=true \
	AI_STRICT_STARTUP=true \
	PORT="$$PORT" \
	npm --prefix "$(BACKEND_DIR)" run dev >"$$LOG_FILE" 2>&1 & \
	PID=$$!; \
	trap 'kill $$PID >/dev/null 2>&1 || true; pkill -P $$PID >/dev/null 2>&1 || true; rm -f "$$RESPONSE_FILE"' EXIT INT TERM; \
	READY=0; \
	i=0; \
	while [ $$i -lt 40 ]; do \
		CODE=$$(curl -s -o "$$RESPONSE_FILE" -w '%{http_code}' "http://127.0.0.1:$$PORT/api/scores?difficulty=easy" || true); \
		if [ "$$CODE" = "200" ]; then \
			READY=1; \
			break; \
		fi; \
		i=$$((i + 1)); \
		sleep 1; \
	done; \
	if [ "$$READY" -ne 1 ]; then \
		echo "DB smoke check failed (expected 200 from /api/scores, got $$CODE)."; \
		echo "Backend log: $$LOG_FILE"; \
		exit 1; \
	fi; \
	echo "DB smoke check passed (backend + MSSQL path is healthy)."; \
	kill $$PID >/dev/null 2>&1 || true; \
	pkill -P $$PID >/dev/null 2>&1 || true; \
	rm -f "$$RESPONSE_FILE"

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
	@echo "  PROD_NAMESPACE: $(call e2e_var_source,PROD_NAMESPACE)"
	@echo "  DB_SECRET_NAME: $(if $(strip $(DB_SECRET_NAME)),set ($(call e2e_var_source,DB_SECRET_NAME)),unset - no DB secret copy or Helm DB mode)"
	@echo "  DB_SECRET_SOURCE_NAMESPACE: $(if $(strip $(DB_SECRET_SOURCE_NAMESPACE)),set ($(call e2e_var_source,DB_SECRET_SOURCE_NAMESPACE)),unset - copy uses PROD_NAMESPACE when DB_SECRET_NAME is set)"
	@if [ -n "$(E2E_MISSING_VARS)" ]; then \
		echo "Missing required e2e vars: $(E2E_MISSING_VARS)"; \
		exit 1; \
	fi

aro-login: ## Authenticate Azure CLI if needed and log oc into the configured ARO cluster
	@set -eo pipefail; \
	echo "ARO login variable source check (values hidden):"; \
	echo "  AZURE_SUBSCRIPTION_ID: $(call e2e_var_source,AZURE_SUBSCRIPTION_ID)"; \
	echo "  ARO_RG: $(call e2e_var_source,ARO_RG)"; \
	echo "  ARO_CLUSTER: $(call e2e_var_source,ARO_CLUSTER)"; \
	if [ -n "$(ARO_LOGIN_MISSING_VARS)" ]; then \
		echo "Missing required login vars: $(ARO_LOGIN_MISSING_VARS)"; \
		echo "Export them in the shell or set them in $(E2E_ENV_FILE)."; \
		exit 1; \
	fi; \
	. scripts/aro-deploy.sh; \
	ensure_azure_login; \
	aro_login; \
	print_aro_login_summary

e2e-azure-route-up: env-check ## Build+deploy frontend/backend to ARO and print temporary UI route URL
	@set -eo pipefail; \
	if [ -n "$(E2E_MISSING_VARS)" ]; then \
		echo "Missing required env vars. Export: AZURE_SUBSCRIPTION_ID, ARO_RG, ARO_CLUSTER, AOAI_RG, AOAI_ACCOUNT, AOAI_DEPLOYMENT (or set them in $(E2E_ENV_FILE))."; \
		exit 1; \
	fi; \
	. scripts/aro-deploy.sh; \
	TS=$$(date +%Y%m%d-%H%M%S); \
	NS="$(E2E_NAMESPACE_PREFIX)-$$TS"; \
	TAG="e2e$$TS"; \
	PROBE_TOKEN="probe-$$TS"; \
	echo "Using namespace: $$NS"; \
	aro_login; \
	aoai_fetch_creds; \
	oc create namespace "$$NS" >/dev/null; \
	oc -n "$$NS" create secret generic azure-openai-creds \
		--from-literal=endpoint="$$AOAI_ENDPOINT" --from-literal=api-key="$$AOAI_KEY" >/dev/null; \
	oc -n "$$NS" new-build --name=sre-simulator-frontend --binary=true --strategy=docker --to=sre-simulator-frontend:$$TAG >/dev/null; \
	oc -n "$$NS" new-build --name=sre-simulator-backend --binary=true --strategy=docker --to=sre-simulator-backend:$$TAG >/dev/null; \
	patch_bc_strategy "$$NS" sre-simulator-frontend frontend/Dockerfile; \
	patch_bc_strategy "$$NS" sre-simulator-backend backend/Dockerfile; \
	oc_build_timed "$$NS" sre-simulator-frontend; \
	oc_build_timed "$$NS" sre-simulator-backend; \
	ensure_db_secret_for_e2e_namespace "$$NS"; \
	helm_deploy_sre "$$NS" "$$TAG" "$$PROBE_TOKEN"; \
	wait_for_rollout "$$NS"; \
	mkdir -p "$$(dirname "$(E2E_METADATA_FILE)")"; \
	printf 'NS=%s\nRELEASE=%s\nURL=%s\nTAG=%s\n' "$$NS" "$(E2E_RELEASE)" "https://$$DEPLOY_HOST" "$$TAG" > "$(E2E_METADATA_FILE)"; \
	probe_readiness "$$DEPLOY_HOST" "$$PROBE_TOKEN"; \
	echo "Manual E2E environment is ready."; \
	echo "URL: https://$$DEPLOY_HOST"; \
	echo "Probe status: 200"; \
	echo "Metadata saved to $(E2E_METADATA_FILE)"

e2e-azure-route-refresh: env-check ## Rebuild+helm upgrade into existing e2e ns (NS=... or $(E2E_METADATA_FILE))
	@set -eo pipefail; \
	if [ -n "$(E2E_MISSING_VARS)" ]; then \
		echo "Missing required env vars. Export: AZURE_SUBSCRIPTION_ID, ARO_RG, ARO_CLUSTER, AOAI_RG, AOAI_ACCOUNT, AOAI_DEPLOYMENT (or set them in $(E2E_ENV_FILE))."; \
		exit 1; \
	fi; \
	if [ -n "$${NS:-}" ]; then \
		TARGET_NS="$$NS"; \
	elif [ -f "$(E2E_METADATA_FILE)" ]; then \
		. "$(E2E_METADATA_FILE)"; \
		TARGET_NS="$$NS"; \
	else \
		echo "Set NS=<namespace> or run e2e-azure-route-up first (needs $(E2E_METADATA_FILE))."; \
		exit 1; \
	fi; \
	. scripts/aro-deploy.sh; \
	TS=$$(date +%Y%m%d-%H%M%S); \
	TAG="e2e$$TS"; \
	PROBE_TOKEN="probe-$$TS"; \
	echo "Refreshing namespace: $$TARGET_NS (image tag $$TAG)"; \
	aro_login; \
	if ! oc get "namespace/$$TARGET_NS" >/dev/null 2>&1; then \
		echo "Namespace $$TARGET_NS does not exist. Run make e2e-azure-route-up first."; \
		exit 1; \
	fi; \
	aoai_fetch_creds; \
	oc -n "$$TARGET_NS" create secret generic azure-openai-creds \
		--from-literal=endpoint="$$AOAI_ENDPOINT" --from-literal=api-key="$$AOAI_KEY" \
		--dry-run=client -o yaml | oc apply -f - >/dev/null; \
	for BC in sre-simulator-frontend sre-simulator-backend; do \
		if ! oc -n "$$TARGET_NS" get "bc/$$BC" >/dev/null 2>&1; then \
			echo "BuildConfig $$BC not found in $$TARGET_NS. Use e2e-azure-route-up for a new environment."; \
			exit 1; \
		fi; \
	done; \
	oc -n "$$TARGET_NS" patch bc/sre-simulator-frontend --type=merge \
		-p "{\"spec\":{\"output\":{\"to\":{\"kind\":\"ImageStreamTag\",\"name\":\"sre-simulator-frontend:$$TAG\"}}}}" >/dev/null; \
	patch_bc_strategy "$$TARGET_NS" sre-simulator-frontend frontend/Dockerfile; \
	oc -n "$$TARGET_NS" patch bc/sre-simulator-backend --type=merge \
		-p "{\"spec\":{\"output\":{\"to\":{\"kind\":\"ImageStreamTag\",\"name\":\"sre-simulator-backend:$$TAG\"}}}}" >/dev/null; \
	patch_bc_strategy "$$TARGET_NS" sre-simulator-backend backend/Dockerfile; \
	oc_build_timed "$$TARGET_NS" sre-simulator-frontend; \
	oc_build_timed "$$TARGET_NS" sre-simulator-backend; \
	ensure_db_secret_for_e2e_namespace "$$TARGET_NS"; \
	helm_deploy_sre "$$TARGET_NS" "$$TAG" "$$PROBE_TOKEN"; \
	wait_for_rollout "$$TARGET_NS"; \
	mkdir -p "$$(dirname "$(E2E_METADATA_FILE)")"; \
	printf 'NS=%s\nRELEASE=%s\nURL=%s\nTAG=%s\n' "$$TARGET_NS" "$(E2E_RELEASE)" "https://$$DEPLOY_HOST" "$$TAG" > "$(E2E_METADATA_FILE)"; \
	probe_readiness "$$DEPLOY_HOST" "$$PROBE_TOKEN"; \
	echo "E2E namespace refreshed."; \
	echo "URL: https://$$DEPLOY_HOST"; \
	echo "Probe status: 200"; \
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
	. scripts/aro-deploy.sh; \
	require_prod_db_secret_name; \
	NS="$(PROD_NAMESPACE)"; \
	TAG="prod$$(date +%Y%m%d-%H%M%S)"; \
	PROBE_TOKEN="probe-prod-$$(date +%s)"; \
	echo "Deploying to PRODUCTION namespace: $$NS"; \
	aro_login; \
	oc get namespace "$$NS" >/dev/null 2>&1 || oc create namespace "$$NS" >/dev/null; \
	require_db_secret_exists_in_namespace "$$NS"; \
	aoai_fetch_creds; \
	oc -n "$$NS" delete secret azure-openai-creds 2>/dev/null || true; \
	oc -n "$$NS" create secret generic azure-openai-creds \
		--from-literal=endpoint="$$AOAI_ENDPOINT" --from-literal=api-key="$$AOAI_KEY" >/dev/null; \
	if ! oc -n "$$NS" get bc/sre-simulator-frontend >/dev/null 2>&1; then \
		oc -n "$$NS" new-build --name=sre-simulator-frontend --binary=true --strategy=docker --to=sre-simulator-frontend:$$TAG >/dev/null; \
	fi; \
	if ! oc -n "$$NS" get bc/sre-simulator-backend >/dev/null 2>&1; then \
		oc -n "$$NS" new-build --name=sre-simulator-backend --binary=true --strategy=docker --to=sre-simulator-backend:$$TAG >/dev/null; \
	fi; \
	oc -n "$$NS" patch bc/sre-simulator-frontend --type=merge \
		-p "{\"spec\":{\"output\":{\"to\":{\"kind\":\"ImageStreamTag\",\"name\":\"sre-simulator-frontend:$$TAG\"}}}}" >/dev/null; \
	oc -n "$$NS" patch bc/sre-simulator-backend --type=merge \
		-p "{\"spec\":{\"output\":{\"to\":{\"kind\":\"ImageStreamTag\",\"name\":\"sre-simulator-backend:$$TAG\"}}}}" >/dev/null; \
	patch_bc_strategy "$$NS" sre-simulator-frontend frontend/Dockerfile; \
	patch_bc_strategy "$$NS" sre-simulator-backend backend/Dockerfile; \
	oc_build_timed "$$NS" sre-simulator-frontend; \
	oc_build_timed "$$NS" sre-simulator-backend; \
	helm_deploy_sre "$$NS" "$$TAG" "$$PROBE_TOKEN"; \
	wait_for_rollout "$$NS"; \
	$(MAKE) public-exposure-audit NS="$$NS"; \
	$(MAKE) db-mode-check NS="$$NS"; \
	$(MAKE) db-port-forward-check NS="$$NS"; \
	mkdir -p "$$(dirname "$(PROD_METADATA_FILE)")"; \
	printf 'NS=%s\nRELEASE=%s\nURL=%s\nTAG=%s\n' "$$NS" "$(E2E_RELEASE)" "https://$$DEPLOY_HOST" "$$TAG" > "$(PROD_METADATA_FILE)"; \
	echo "Production deployment ready."; \
	echo "URL: https://$$DEPLOY_HOST"; \
	echo "Metadata saved to $(PROD_METADATA_FILE)"

prod-up-tag: env-check ## Deploy to production namespace with explicit semver TAG (e.g. TAG=v0.1.0)
	@set -e; \
	if [ -z "$${TAG:-}" ]; then \
		echo "TAG is required. Example: make prod-up-tag TAG=v0.1.0"; \
		exit 1; \
	fi; \
	if [[ ! "$$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$$ ]]; then \
		echo "TAG must follow semver with v prefix (example: v0.1.0)."; \
		exit 1; \
	fi; \
	. scripts/aro-deploy.sh; \
	require_prod_db_secret_name; \
	NS="$(PROD_NAMESPACE)"; \
	PROBE_TOKEN="probe-prod-$$(echo "$$TAG" | tr -cd '[:alnum:]-')-$$(date +%s)"; \
	echo "Deploying semver release $$TAG to PRODUCTION namespace: $$NS"; \
	aro_login; \
	oc get namespace "$$NS" >/dev/null 2>&1 || oc create namespace "$$NS" >/dev/null; \
	require_db_secret_exists_in_namespace "$$NS"; \
	aoai_fetch_creds; \
	oc -n "$$NS" delete secret azure-openai-creds 2>/dev/null || true; \
	oc -n "$$NS" create secret generic azure-openai-creds \
		--from-literal=endpoint="$$AOAI_ENDPOINT" --from-literal=api-key="$$AOAI_KEY" >/dev/null; \
	if ! oc -n "$$NS" get bc/sre-simulator-frontend >/dev/null 2>&1; then \
		oc -n "$$NS" new-build --name=sre-simulator-frontend --binary=true --strategy=docker --to=sre-simulator-frontend:$$TAG >/dev/null; \
	fi; \
	if ! oc -n "$$NS" get bc/sre-simulator-backend >/dev/null 2>&1; then \
		oc -n "$$NS" new-build --name=sre-simulator-backend --binary=true --strategy=docker --to=sre-simulator-backend:$$TAG >/dev/null; \
	fi; \
	oc -n "$$NS" patch bc/sre-simulator-frontend --type=merge \
		-p "{\"spec\":{\"output\":{\"to\":{\"kind\":\"ImageStreamTag\",\"name\":\"sre-simulator-frontend:$$TAG\"}}}}" >/dev/null; \
	oc -n "$$NS" patch bc/sre-simulator-backend --type=merge \
		-p "{\"spec\":{\"output\":{\"to\":{\"kind\":\"ImageStreamTag\",\"name\":\"sre-simulator-backend:$$TAG\"}}}}" >/dev/null; \
	patch_bc_strategy "$$NS" sre-simulator-frontend frontend/Dockerfile; \
	patch_bc_strategy "$$NS" sre-simulator-backend backend/Dockerfile; \
	oc_build_timed "$$NS" sre-simulator-frontend; \
	oc_build_timed "$$NS" sre-simulator-backend; \
	helm_deploy_sre "$$NS" "$$TAG" "$$PROBE_TOKEN"; \
	wait_for_rollout "$$NS"; \
	probe_readiness "$$DEPLOY_HOST" "$$PROBE_TOKEN"; \
	$(MAKE) public-exposure-audit NS="$$NS"; \
	$(MAKE) db-mode-check NS="$$NS"; \
	$(MAKE) db-port-forward-check NS="$$NS"; \
	mkdir -p "$$(dirname "$(PROD_METADATA_FILE)")"; \
	printf 'NS=%s\nRELEASE=%s\nURL=%s\nTAG=%s\n' "$$NS" "$(E2E_RELEASE)" "https://$$DEPLOY_HOST" "$$TAG" > "$(PROD_METADATA_FILE)"; \
	echo "Production deployment ready."; \
	echo "URL: https://$$DEPLOY_HOST"; \
	echo "Probe status: 200"; \
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

geneva-suppression-check: ## Require explicit confirmation that Geneva suppression rule is active
	@if [ "$(GENEVA_SUPPRESSION_RULE_ACTIVE)" != "true" ]; then \
		echo "Set GENEVA_SUPPRESSION_RULE_ACTIVE=true after verifying Geneva suppression is active for the target ARO cluster/resource group (ARO_CLUSTER, ARO_RG)."; \
		exit 1; \
	fi

public-exposure-audit: ## Verify frontend route is public and backend remains private ClusterIP
	@set -e; \
	NS="$${NS:-$(PROD_NAMESPACE)}"; \
	RELEASE="$${RELEASE:-$(E2E_RELEASE)}"; \
	FRONT_ROUTE="$$RELEASE"; \
	BACK_ROUTE="$$RELEASE-backend"; \
	BACK_SVC="$$RELEASE-backend"; \
	echo "Auditing exposure in namespace $$NS (release $$RELEASE)"; \
	oc -n "$$NS" get "route/$$FRONT_ROUTE" >/dev/null; \
	if oc -n "$$NS" get "route/$$BACK_ROUTE" >/dev/null 2>&1; then \
		echo "Unexpected backend route found: $$BACK_ROUTE"; \
		exit 1; \
	fi; \
	SVC_TYPE=$$(oc -n "$$NS" get "svc/$$BACK_SVC" -o jsonpath='{.spec.type}'); \
	if [ "$$SVC_TYPE" != "ClusterIP" ]; then \
		echo "Backend service type must be ClusterIP, found $$SVC_TYPE"; \
		exit 1; \
	fi; \
	echo "Exposure audit passed: frontend route exists, backend is internal-only."

db-mode-check: ## Verify deployed backend is wired for Azure SQL mode
	@set -e; \
	NS="$${NS:-$(PROD_NAMESPACE)}"; \
	RELEASE="$${RELEASE:-$(E2E_RELEASE)}"; \
	DEPLOY="$${DEPLOY:-$$RELEASE-backend}"; \
	ERR_FILE="$$(mktemp /tmp/sre-db-mode-check-oc.err.XXXXXX)"; \
	trap 'rm -f "$$ERR_FILE"' EXIT INT TERM; \
	if ! oc -n "$$NS" get deployment "$$DEPLOY" >/dev/null 2>"$$ERR_FILE"; then \
		echo "Cannot access deployment $$NS/$$DEPLOY."; \
		cat "$$ERR_FILE"; \
		exit 1; \
	fi; \
	STORAGE_BACKEND=$$(oc -n "$$NS" get deployment "$$DEPLOY" -o jsonpath="{.spec.template.spec.containers[0].env[?(@.name=='STORAGE_BACKEND')].value}"); \
	DB_SECRET_NAME=$$(oc -n "$$NS" get deployment "$$DEPLOY" -o jsonpath="{.spec.template.spec.containers[0].env[?(@.name=='DATABASE_URL')].valueFrom.secretKeyRef.name}"); \
	DB_SECRET_KEY=$$(oc -n "$$NS" get deployment "$$DEPLOY" -o jsonpath="{.spec.template.spec.containers[0].env[?(@.name=='DATABASE_URL')].valueFrom.secretKeyRef.key}"); \
	if [ "$$STORAGE_BACKEND" != "mssql" ]; then \
		echo "Expected STORAGE_BACKEND=mssql for $$NS/$$DEPLOY, found '$${STORAGE_BACKEND:-<unset>}'."; \
		exit 1; \
	fi; \
	if [ -z "$$DB_SECRET_NAME" ] || [ -z "$$DB_SECRET_KEY" ]; then \
		echo "DATABASE_URL secret ref not found on deployment $$NS/$$DEPLOY."; \
		echo "Make sure this release uses database.enabled=true."; \
		exit 1; \
	fi; \
	if ! oc -n "$$NS" get secret "$$DB_SECRET_NAME" >/dev/null 2>"$$ERR_FILE"; then \
		echo "Cannot access secret $$NS/$$DB_SECRET_NAME."; \
		cat "$$ERR_FILE"; \
		exit 1; \
	fi; \
	echo "DB mode check passed: $$NS/$$DEPLOY uses STORAGE_BACKEND=mssql with $$DB_SECRET_NAME/$$DB_SECRET_KEY."

db-port-forward-check: ## Verify backend-to-DB path through local oc port-forward fallback
	@set -e; \
	NS="$${NS:-$(PROD_NAMESPACE)}"; \
	RELEASE="$${RELEASE:-$(E2E_RELEASE)}"; \
	LOCAL_PORT="$${LOCAL_PORT:-18080}"; \
	BACK_PORT="$${BACK_PORT:-8080}"; \
	SVC="$$RELEASE-backend"; \
	echo "Running DB check via port-forward: $$NS/$$SVC -> 127.0.0.1:$$LOCAL_PORT"; \
	oc -n "$$NS" get "svc/$$SVC" >/dev/null; \
	oc -n "$$NS" port-forward "svc/$$SVC" "$$LOCAL_PORT:$$BACK_PORT" >/tmp/sre-db-port-forward.log 2>&1 & \
	PID=$$!; \
	trap 'kill $$PID >/dev/null 2>&1 || true' EXIT INT TERM; \
	READY=0; \
	i=0; \
	while [ $$i -lt 40 ]; do \
		CODE=$$(curl -s -o /tmp/sre-db-port-forward-response.json -w '%{http_code}' "http://127.0.0.1:$$LOCAL_PORT/api/scores?difficulty=easy" || true); \
		if [ "$$CODE" = "200" ]; then \
			READY=1; \
			break; \
		fi; \
		i=$$((i + 1)); \
		sleep 1; \
	done; \
	if [ "$$READY" -ne 1 ]; then \
		echo "Port-forward DB check failed (expected 200 from /api/scores, got $$CODE)."; \
		echo "Port-forward log: /tmp/sre-db-port-forward.log"; \
		exit 1; \
	fi; \
	echo "Port-forward DB check passed."

db-inspect: install-backend ## Inspect DB rows from deployed backend (set SQL='...' for custom query)
	@set -e; \
	NS="$${NS:-$(PROD_NAMESPACE)}"; \
	RELEASE="$${RELEASE:-$(E2E_RELEASE)}"; \
	DEPLOY="$${DEPLOY:-$$RELEASE-backend}"; \
	LIMIT="$${LIMIT:-10}"; \
	QUERY="$${SQL:-}"; \
	ERR_FILE="$$(mktemp /tmp/sre-db-inspect-oc.err.XXXXXX)"; \
	trap 'rm -f "$$ERR_FILE"' EXIT INT TERM; \
	if ! oc -n "$$NS" get deployment "$$DEPLOY" >/dev/null 2>"$$ERR_FILE"; then \
		echo "Cannot access deployment $$NS/$$DEPLOY."; \
		cat "$$ERR_FILE"; \
		exit 1; \
	fi; \
	DB_SECRET_NAME=$$(oc -n "$$NS" get deployment "$$DEPLOY" -o jsonpath="{.spec.template.spec.containers[0].env[?(@.name=='DATABASE_URL')].valueFrom.secretKeyRef.name}"); \
	DB_SECRET_KEY=$$(oc -n "$$NS" get deployment "$$DEPLOY" -o jsonpath="{.spec.template.spec.containers[0].env[?(@.name=='DATABASE_URL')].valueFrom.secretKeyRef.key}"); \
	if [ -z "$$DB_SECRET_NAME" ] || [ -z "$$DB_SECRET_KEY" ]; then \
		echo "DATABASE_URL secret ref not found on deployment $$NS/$$DEPLOY."; \
		echo "Make sure this release uses database.enabled=true."; \
		exit 1; \
	fi; \
	if ! oc -n "$$NS" get secret "$$DB_SECRET_NAME" >/dev/null 2>"$$ERR_FILE"; then \
		echo "Cannot access secret $$NS/$$DB_SECRET_NAME."; \
		cat "$$ERR_FILE"; \
		exit 1; \
	fi; \
	ENCODED_DB_URL=$$(oc -n "$$NS" get secret "$$DB_SECRET_NAME" -o jsonpath="{.data['$$DB_SECRET_KEY']}"); \
	if [ -z "$$ENCODED_DB_URL" ]; then \
		echo "Could not read key '$$DB_SECRET_KEY' from secret '$$DB_SECRET_NAME'."; \
		exit 1; \
	fi; \
	DB_URL=$$(printf '%s' "$$ENCODED_DB_URL" | base64 --decode 2>/dev/null || printf '%s' "$$ENCODED_DB_URL" | base64 -D 2>/dev/null || true); \
	if [ -z "$$DB_URL" ]; then \
		echo "Failed to decode DATABASE_URL from secret '$$DB_SECRET_NAME'."; \
		exit 1; \
	fi; \
	echo "Inspecting DB for $$NS/$$DEPLOY (secret: $$DB_SECRET_NAME, key: $$DB_SECRET_KEY)"; \
	NODE_PATH="$(CURDIR)/$(BACKEND_DIR)/node_modules" \
	DATABASE_URL="$$DB_URL" \
	LIMIT="$$LIMIT" \
	SQL="$$QUERY" \
	node scripts/db-inspect.cjs

db-inspect-live: ## Inspect DB rows from inside the deployed backend pod (bypasses local SQL firewall)
	@set -e; \
	NS="$${NS:-$(PROD_NAMESPACE)}"; \
	RELEASE="$${RELEASE:-$(E2E_RELEASE)}"; \
	DEPLOY="$${DEPLOY:-$$RELEASE-backend}"; \
	LIMIT="$${LIMIT:-10}"; \
	QUERY="$${SQL:-}"; \
	DB_SECRET_NAME=""; \
	DB_SECRET_KEY=""; \
	ERR_FILE="$$(mktemp /tmp/sre-db-inspect-live-oc.err.XXXXXX)"; \
	trap 'rm -f "$$ERR_FILE"' EXIT INT TERM; \
	if ! oc -n "$$NS" get deployment "$$DEPLOY" >/dev/null 2>"$$ERR_FILE"; then \
		echo "Cannot access deployment $$NS/$$DEPLOY."; \
		cat "$$ERR_FILE"; \
		exit 1; \
	fi; \
	DB_SECRET_NAME=$$(oc -n "$$NS" get deployment "$$DEPLOY" -o jsonpath="{.spec.template.spec.containers[0].env[?(@.name=='DATABASE_URL')].valueFrom.secretKeyRef.name}"); \
	DB_SECRET_KEY=$$(oc -n "$$NS" get deployment "$$DEPLOY" -o jsonpath="{.spec.template.spec.containers[0].env[?(@.name=='DATABASE_URL')].valueFrom.secretKeyRef.key}"); \
	if [ -z "$$DB_SECRET_NAME" ] || [ -z "$$DB_SECRET_KEY" ]; then \
		echo "DATABASE_URL secret ref not found on deployment $$NS/$$DEPLOY."; \
		echo "Make sure this release uses database.enabled=true."; \
		exit 1; \
	fi; \
	if ! oc -n "$$NS" get secret "$$DB_SECRET_NAME" >/dev/null 2>"$$ERR_FILE"; then \
		echo "Cannot access secret $$NS/$$DB_SECRET_NAME."; \
		cat "$$ERR_FILE"; \
		exit 1; \
	fi; \
	echo "Inspecting DB live for $$NS/$$DEPLOY via in-cluster node (secret: $$DB_SECRET_NAME, key: $$DB_SECRET_KEY)"; \
	oc -n "$$NS" exec -i "deploy/$$DEPLOY" -- \
		env LIMIT="$$LIMIT" SQL="$$QUERY" node - < scripts/db-inspect.cjs

prod-up-final: geneva-suppression-check env-check ## Deploy final env then run exposure + DB fallback checks
	@set -e; \
	if [ -z "$(DB_SECRET_NAME)" ]; then \
		echo "DB_SECRET_NAME is required for final deployment with STORAGE_BACKEND=mssql."; \
		exit 1; \
	fi; \
	$(MAKE) prod-up DB_SECRET_NAME="$(DB_SECRET_NAME)"; \
	$(MAKE) public-exposure-audit NS="$(PROD_NAMESPACE)"; \
	$(MAKE) db-mode-check NS="$(PROD_NAMESPACE)"; \
	$(MAKE) db-port-forward-check NS="$(PROD_NAMESPACE)"

# ──────────────────────────────────────────────
# Build & Run
# ──────────────────────────────────────────────
build: ## Build the Next.js production bundle
	cd $(FRONTEND_DIR) && npm run build

dev: ## Start Next.js dev server
	cd $(FRONTEND_DIR) && npm run dev

start: build ## Build and start production server
	cd $(FRONTEND_DIR) && npm run start

capture-readme-hero: ## Generate README gameplay hero GIF from local mock flow
	node scripts/capture-readme-hero.mjs

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

tf-pull-secret: ## Extract pull secret JSON from a private env source for Terraform
	$(MAKE) -C infra tf-pull-secret

tf-preflight: ## Run Azure preflight checks for final isolated environment
	$(MAKE) -C infra tf-preflight

tf-init: ## Terraform init (see infra/Makefile for options)
	$(MAKE) -C infra tf-init

tf-init-local: ## Terraform init without remote backend (validation/testing only)
	$(MAKE) -C infra tf-init-local

tf-init-isolated: ## Terraform init with per-owner isolated state key
	$(MAKE) -C infra tf-init-isolated

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
