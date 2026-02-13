.PHONY: help install clean \
       fmt fmt-check \
       lint lint-ts lint-yaml lint-md \
       typecheck validate \
       security audit lockfile-lint \
       test \
       build dev start \
       pre-commit all

FRONTEND_DIR := frontend

# ──────────────────────────────────────────────
# Help
# ──────────────────────────────────────────────
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# ──────────────────────────────────────────────
# Setup
# ──────────────────────────────────────────────
install: ## Install all dependencies
	cd $(FRONTEND_DIR) && npm ci
	pre-commit install

clean: ## Remove build artifacts and node_modules
	rm -rf $(FRONTEND_DIR)/.next $(FRONTEND_DIR)/node_modules

# ──────────────────────────────────────────────
# Formatting
# ──────────────────────────────────────────────
fmt: ## Auto-fix formatting (eslint, markdownlint)
	cd $(FRONTEND_DIR) && npx eslint --fix .
	npx markdownlint --fix '**/*.md' --ignore '**/node_modules/**'

fmt-check: ## Check formatting without modifying files
	cd $(FRONTEND_DIR) && npx eslint .
	npx markdownlint '**/*.md' --ignore '**/node_modules/**'

# ──────────────────────────────────────────────
# Linting
# ──────────────────────────────────────────────
lint: lint-ts lint-yaml lint-md ## Run all linters

lint-ts: ## Lint TypeScript/React with eslint
	cd $(FRONTEND_DIR) && npx eslint .

lint-yaml: ## Lint YAML files with yamllint
	yamllint --strict .

lint-md: ## Lint Markdown files with markdownlint
	npx markdownlint '**/*.md' --ignore '**/node_modules/**'

# ──────────────────────────────────────────────
# Type checking & validation
# ──────────────────────────────────────────────
typecheck: ## Run TypeScript type checking
	cd $(FRONTEND_DIR) && npx tsc --noEmit

validate: lint typecheck ## Run all linters + type checking

# ──────────────────────────────────────────────
# Security
# ──────────────────────────────────────────────
security: audit lockfile-lint ## Run all security checks

audit: ## Check npm dependencies for known vulnerabilities
	cd $(FRONTEND_DIR) && npm audit --audit-level=high

lockfile-lint: ## Validate lockfile integrity (registry & HTTPS)
	cd $(FRONTEND_DIR) && npx lockfile-lint \
		--path package-lock.json \
		--type npm \
		--allowed-hosts npm \
		--validate-https

# ──────────────────────────────────────────────
# Testing
# ──────────────────────────────────────────────
test: ## Run tests (placeholder — add test runner config)
	@echo "No test runner configured yet. Add vitest or jest to $(FRONTEND_DIR)."
	@exit 1

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
# Aggregate targets
# ──────────────────────────────────────────────
pre-commit: ## Run pre-commit hooks on all files
	pre-commit run --all-files

all: validate security build ## Full CI pipeline: lint + typecheck + security + build
