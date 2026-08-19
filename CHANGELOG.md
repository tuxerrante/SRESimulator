# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (Unreleased)

- Bound `POST /api/scenario` with an end-to-end application deadline
  (`SCENARIO_REQUEST_BUDGET_MS`, default and hard maximum 24s) shared by
  identity verification, viewer upsert, claim reservation, knowledge and
  catalog reads, AI generation, session persistence and failure cleanup, so the
  composed worst case stays inside the 30-second Envoy Gateway budget.
  Anonymous claim lookup and Turnstile verification now run concurrently, and
  per-stage latencies are recorded and logged when the deadline is exceeded.
  ([#340](https://github.com/tuxerrante/SRESimulator/issues/340))

### Changed (Unreleased)

- Made anonymous trial enforcement identity-aware by client IP: an opaque
  IP-only claim is persisted alongside browser signals and trusted client IP
  detection is wired through the AKS Gateway path. The anonymous Easy path now
  fails closed when strict anonymous identity is unavailable.
- Derived the trusted client IP from Envoy's connection source address instead
  of `X-Forwarded-For`. The AKS edge is a Layer-4 Azure Load Balancer that
  never sets that header, so trusting it allowed any caller to forge a client
  IP and mint unlimited anonymous trials. `X-Forwarded-For` trust is now
  opt-in (`gateway.clientIpDetection.trustXForwardedFor`), the frontend proxy
  accepts only `x-envoy-external-address`, and the Envoy service is deployed
  with `externalTrafficPolicy: Local` so the real source address survives
  kube-proxy.

### Fixed (Unreleased)

- Made stale automatic production release runs skip cleanly before Azure login
  when a newer semver tag appears, while retaining the fail-closed latest-tag
  guard for manual deploys.
- Stopped scenario creation from consuming an anonymous daily claim without
  returning a usable session: stages are never aborted mid-flight, and
  reservations or sessions that settle after the deadline trigger a
  compensating release that cannot delete a claim a newer request has since
  reserved. Failure cleanup is reserved inside the request budget, an overrun
  returns `503` with `Retry-After` (`scenario_request_deadline_exceeded`)
  instead of an edge 504, and a client disconnect aborts provider work and
  releases the reserved claim.

## [0.4.2] - 2026-08-08

### Fixed (0.4.2)

- Gave `/api/scenario` an explicit 30-second Envoy Gateway timeout so the
  backend's 12-second AI fallback can finish verification and session
  persistence instead of returning the gateway's default 504 timeout.
- Updated transitive frontend `js-yaml` and `nanoid` packages to patched
  releases required by the release security gate.

## [0.4.1] - 2026-08-04

### Changed (0.4.1)

- Made GitHub-authenticated callsigns server-authoritative, non-editable, and derived from the GitHub login; anonymous callsigns remain separately persisted. ([#319](https://github.com/tuxerrante/SRESimulator/pull/319))
- Expanded supported authenticated callsign storage to GitHub's 39-character login limit and hardened MSSQL migration and analytics handling. ([#319](https://github.com/tuxerrante/SRESimulator/pull/319))
- Required the full local quality gate before push and updated live E2E coverage for the read-only authenticated callsign. ([#319](https://github.com/tuxerrante/SRESimulator/pull/319))
- Hardened production release preflight check pagination and its shell endpoint assembly. ([#317](https://github.com/tuxerrante/SRESimulator/pull/317), [#318](https://github.com/tuxerrante/SRESimulator/pull/318))

## [0.4.0] - 2026-08-04

### Added (0.4.0)

- Added first-class AKS, ARO Classic, and ARO HCP gameplay paths across scenario selection, prompts, command simulation, telemetry, analytics, storage, and leaderboards. ([#306](https://github.com/tuxerrante/SRESimulator/commit/8d507664bf8d232a930170991c4c8cc774b0be44))
- Added platform-scoped scenario catalogs, knowledge bundles, context metadata, documentation references, and interactive onboarding. ([#306](https://github.com/tuxerrante/SRESimulator/commit/8d507664bf8d232a930170991c4c8cc774b0be44))
- Added a protected mandatory live Playwright PR gate that runs isolated AKS, ARO Classic, and ARO HCP users in parallel and requires distinct scenario evidence. ([#306](https://github.com/tuxerrante/SRESimulator/commit/8d507664bf8d232a930170991c4c8cc774b0be44))

### Changed (0.4.0)

- Enforced platform boundaries for generated incidents, stored sessions, knowledge retrieval, CLI/resource commands, telemetry, and rendered documentation links. ([#306](https://github.com/tuxerrante/SRESimulator/commit/8d507664bf8d232a930170991c4c8cc774b0be44))
- Hardened local JSON persistence with bounded filesystem locks, atomic writes, and serialized anonymous-trial claims across concurrent player, leaderboard, and session workers. ([#306](https://github.com/tuxerrante/SRESimulator/commit/8d507664bf8d232a930170991c4c8cc774b0be44))
- Hardened AKS E2E workflows with authenticated secret handling, `linux/amd64` development images, Helm capability checks, shared-edge reconciliation, and safe port-forward refreshes. ([#306](https://github.com/tuxerrante/SRESimulator/commit/8d507664bf8d232a930170991c4c8cc774b0be44))
- Reduced the command-generation timeout so deterministic degraded output is returned before the public gateway timeout. ([#306](https://github.com/tuxerrante/SRESimulator/commit/8d507664bf8d232a930170991c4c8cc774b0be44))
- Added an edge-safe curated scenario fallback for AI timeouts and provider throttling, preserving platform-specific reservations and degraded-response metadata. ([#308](https://github.com/tuxerrante/SRESimulator/commit/3340841f4410bcacac46e86edf8eaa51e8e6cc12))
- Added the same curated fallback for invalid, non-JSON, or schema-invalid AI payloads so gameplay remains available instead of returning a 502. ([#310](https://github.com/tuxerrante/SRESimulator/commit/d445759d1ed81335d15ce94d2abb9c1a0bf9a19b))
- Accelerated security checks by caching the Grype vulnerability database, removing a duplicate scan pass, and scanning frontend and backend dependencies in parallel. ([#308](https://github.com/tuxerrante/SRESimulator/commit/3340841f4410bcacac46e86edf8eaa51e8e6cc12))
- Aligned infrastructure defaults, examples, tests, and operator guidance with Azure OpenAI `gpt-5.6-terra` (`2026-07-09`) and made SKU guidance model-agnostic. ([#291](https://github.com/tuxerrante/SRESimulator/commit/81e1121e31e3b90318eca08e009303c950e95613))
- Hardened Helm integration validation by allowing deployed JSON storage only for explicit mock tests, probing the actual frontend Service port in connection checks, and updating the vulnerable transitive `ip-address` dependency. ([#311](https://github.com/tuxerrante/SRESimulator/commit/a87dcc95dcd847c326d52b350cd9f93c4a0f92ac))
- Synchronized frontend, backend, Helm, lockfile, and customer-visible release metadata to `v0.4.0`. ([#307](https://github.com/tuxerrante/SRESimulator/commit/83e923c2d79b9a161a7f8a889730ca9850f6e995))
- Tightened landing-page vertical spacing by keeping the content and authentication/footer controls in one centered stack on tall viewports. ([#312](https://github.com/tuxerrante/SRESimulator/commit/59229814807059b4de046341db463d46752e2c7b))
- Hardened GitHub OAuth for non-production environments with a native GET login form, fail-closed callback validation, complete Secret-key requirements, and portable callback-value decoding without leaking errors. ([#314](https://github.com/tuxerrante/SRESimulator/commit/323c8722d496c169b6f8e9bef63130a0ae3c4c56))
- Expanded the mandatory live Playwright gate to four concurrent paths—anonymous start-to-game verification plus AKS, ARO HCP, and ARO Classic users—with double-gated local verification settings, production-namespace refresh refusal, distinct scenarios, and separate fallback diagnostics. ([#315](https://github.com/tuxerrante/SRESimulator/commit/aa55aa283da1e411f3aa8376003d273e2e8327b5))

## [0.3.0] - 2026-07-31

### Changed (0.3.0)

- Hardened Node 24 release validation by isolating slow WSL/Vitest cold-start behavior, deconflicting coverage output, and normalizing deployment shell/chart files to LF so the mainline quality gates pass consistently.
- Updated the default Azure OpenAI/Foundry deployment wiring to `gpt-5.6-terra` and aligned release/e2e metadata for the `v0.3.0` promotion path.

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
