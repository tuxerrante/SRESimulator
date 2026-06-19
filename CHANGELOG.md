# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-06-19

### Changed (0.2.1)

- Lowered Azure OpenAI reasoning effort for live scenario generation so the easy-scenario start path is less likely to exhaust its completion budget without returning JSON.
- Streamed Azure OpenAI chat responses, hardened backend Express request handling, and slimmed backend runtime image inputs for the production release line.
- Required explicit local MSSQL secrets and enforced Azure SQL-backed production storage wiring in the deployment path.

## [0.1.4] - 2026-06-05

### Changed (0.1.4)

- Moved Turnstile capability detection to runtime session config so anonymous gating does not depend on frontend build-time environment variables.
- Added local/e2e Turnstile test mode support for anonymous-path validation without external captcha dependency.
- Hardened AKS auth secret wiring and backend data volume permissions to eliminate `/api/scores` failures from `/data` write access regressions.

## [0.2.0] - 2026-05-12

### Added (0.2.0)

- Added gameplay lifecycle analytics surfaces, including admin session summaries and difficulty/scenario breakdown views, with dedicated admin endpoint protection.
- Added server-owned scenario context binding to sessions so chat/command AI paths use trusted stored scenario payloads instead of mutable client context.

### Changed (0.2.0)

- Hardened runtime reliability with bounded timeout/cancellation behavior for scenario generation and chat streaming paths.
- Updated deployment wiring for secure proxy-aware origin handling and configurable admin analytics visibility in frontend and Helm values.
- Updated release/deploy gates so production deployment checks require successful Helm runtime integration checks.

### Security (0.2.0)

- Disabled persistent leaderboard writes by default behind `PERSISTENT_LEADERBOARD_ENABLED` to prevent forged client-submitted scoring from becoming persistent records.

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
