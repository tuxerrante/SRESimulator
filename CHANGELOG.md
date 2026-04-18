# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-04-18

### Release Hardening

- Enforced Azure SQL-backed production deploys by requiring `DB_SECRET_NAME`, validating secret presence, and adding post-deploy DB-mode verification to the Makefile and GitHub deploy workflow.
- Added guarded regression coverage for production DB deploy paths so CI catches silent JSON/PVC fallback before merge.
- Refreshed the release metadata on `main` so the next semver tag can promote the current patch safely through CI/CD.

## [0.1.1] - 2026-04-08

### Release Alignment

- Published the latest mainline fixes and refinements as a patch release.
- Aligned release metadata across frontend, backend, Helm chart, and app version for automated CI/CD promotion.

## [0.1.0] - 2026-04-07

### Added

- Launched the complete break-fix gameplay loop with AI-generated incidents across easy, medium, and hard difficulties.
- Added investigation UX modules for chat guidance, command execution, dashboard context gathering, and leaderboard history.
- Introduced phase-aware scoring to measure efficiency, safety, documentation quality, and root-cause accuracy.
- Added ARO deployment flows via Make targets for e2e and production namespaces, including rollout checks and probe validation.

### Changed

- Standardized CI quality gates with linting, type checks, unit tests, integration suites, security scans, Helm validation, and Docker builds.
- Improved cloud AI runtime support for Vertex and Azure OpenAI/Foundry with strict startup checks and live probe endpoints.
- Hardened operational runbooks and Make target conventions for infrastructure workflows and production readiness.

### Security

- Added lockfile and vulnerability scanning safeguards in CI.
- Enforced secret-aware deployment patterns through OpenShift secret injection and environment checks.
