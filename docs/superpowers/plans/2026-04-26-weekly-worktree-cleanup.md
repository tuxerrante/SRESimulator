# Weekly Worktree Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable repo cleanup entry point for old worktree artifacts and install a weekly macOS `launchd` job that runs it automatically.

**Architecture:** Keep the cleanup logic in a dedicated repo script so both manual runs and scheduled runs share the same behavior. Generate the `launchd` plist from a second script and expose both flows through Make targets so the repo remains the operator entry point.

**Tech Stack:** Bash, GNU/bsd userland tools, Make, macOS `launchd`

---

## Task 1: Add failing shell tests for cleanup behavior

**Files:**

- Create: `scripts/cleanup-old-worktrees.test.sh`
- Create: `scripts/install-worktree-cleanup-launchd.test.sh`
- Test: `scripts/cleanup-old-worktrees.test.sh`
- Test: `scripts/install-worktree-cleanup-launchd.test.sh`

- [ ] **Step 1: Write the failing cleanup behavior test**
- [ ] **Step 2: Run `bash scripts/cleanup-old-worktrees.test.sh` and verify it fails because the script is missing**
- [ ] **Step 3: Write the failing launchd installer test**
- [ ] **Step 4: Run `bash scripts/install-worktree-cleanup-launchd.test.sh` and verify it fails because the installer script is missing**

## Task 2: Implement the cleanup script

**Files:**

- Create: `scripts/cleanup-old-worktrees.sh`
- Test: `scripts/cleanup-old-worktrees.test.sh`

- [ ] **Step 1: Implement argument parsing for `--root`, `--days`, and `--dry-run`**
- [ ] **Step 2: Limit cleanup to configured generated directories at the worktree root or one level below**
- [ ] **Step 3: Run `bash scripts/cleanup-old-worktrees.test.sh` and verify it passes**

## Task 3: Implement the launchd installer script

**Files:**

- Create: `scripts/install-worktree-cleanup-launchd.sh`
- Test: `scripts/install-worktree-cleanup-launchd.test.sh`

- [ ] **Step 1: Generate a plist that calls `make cleanup-worktrees` from the repo root**
- [ ] **Step 2: Support writing to a provided output path for tests and defaulting to `~/Library/LaunchAgents` for real installs**
- [ ] **Step 3: Run `bash scripts/install-worktree-cleanup-launchd.test.sh` and verify it passes**

## Task 4: Wire Make targets and docs

**Files:**

- Modify: `Makefile`
- Modify: `README.md`

- [ ] **Step 1: Add `cleanup-worktrees-dry-run`, `cleanup-worktrees`, `install-weekly-worktree-cleanup`, and `uninstall-weekly-worktree-cleanup` targets**
- [ ] **Step 2: Document the manual and weekly cleanup flow in the README**
- [ ] **Step 3: Run the new make targets in dry-run mode to verify the plumbing**

## Task 5: Full verification

**Files:**

- Test: `scripts/cleanup-old-worktrees.test.sh`
- Test: `scripts/install-worktree-cleanup-launchd.test.sh`
- Test: `Makefile`

- [ ] **Step 1: Run `bash scripts/cleanup-old-worktrees.test.sh`**
- [ ] **Step 2: Run `bash scripts/install-worktree-cleanup-launchd.test.sh`**
- [ ] **Step 3: Run `make validate`**
- [ ] **Step 4: Run `make test`**
- [ ] **Step 5: Run `make test-integration`**
