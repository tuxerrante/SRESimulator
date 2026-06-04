# Release Prep And Version Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent future semver tags from publishing/deploying with mismatched repo version surfaces, and provide a single explicit prep command to update them safely.

**Architecture:** Introduce one shared Node script that validates semver-aligned version surfaces and optionally rewrites them for a target tag. Reuse that script in shell regression tests, a new `Makefile` release-prep target, CI’s semver-tag path, and the Release workflow so the same logic runs everywhere.

**Tech Stack:** Node.js, bash shell tests, GNU Make, GitHub Actions

---

## Task 1: Shared version-sync script

**Files:**

- Create: `scripts/release-version-sync.mjs`
- Modify: `Makefile`

- [ ] Add a Node CLI that:
  - accepts `verify --tag vX.Y.Z`
  - accepts `prepare --tag vX.Y.Z`
  - verifies `frontend/package.json`, `backend/package.json`, `helm/sre-simulator/Chart.yaml`, and `frontend/src/lib/release.ts`
  - updates those files during `prepare`
  - requires a matching `CHANGELOG.md` section for the bare semver during both modes

- [ ] Add `make release-prepare TAG=vX.Y.Z` and `make verify-release-version TAG=vX.Y.Z` targets that call the script.

## Task 2: Regression coverage

**Files:**

- Create: `scripts/release-version-sync.test.sh`
- Modify: `Makefile`

- [ ] Add a shell regression test using the existing `scripts/*.test.sh` pattern.
- [ ] Cover:
  - failing verify on mismatched version surfaces
  - failing verify when changelog section is missing
  - successful prepare updating all four version surfaces
  - successful verify after prepare

- [ ] Register the new script in `make test-shell`.

## Task 3: Earlier CI and shared Release guard

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`

- [ ] Replace the inline Release validation with the shared script.
- [ ] Add the same shared validation to CI for semver tag pushes, before bad tags can flow into image publishing and release creation.
- [ ] Keep the existing main-history ancestry behavior intact.

## Task 4: Verification

**Files:**

- Run only

- [ ] Run the new shell regression test and verify red/green behavior during implementation.
- [ ] Run `make test-shell`.
- [ ] Run `make validate`.
- [ ] Report the exact commands and outcomes, plus any remaining manual release steps.
