# Patch Release v0.1.2 Production Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify that current production on `ARO_CLUSTER` is Azure-SQL-backed and healthy, then prepare, tag, deploy, and verify patch release `v0.1.2`.

**Architecture:** The rollout uses the repo's Makefile-first production flow. Read-only verification happens before any release-prep edits or production changes, and the rollout is blocked if the current production release is not DB-backed or fails DB health checks. Release metadata is aligned on `main`, then the semver tag is deployed with the production Make target and re-verified.

**Tech Stack:** Git, GitHub semver tags, Make, Azure CLI, OpenShift CLI (`oc`), Helm, Node.js, Azure SQL

---

## Tasks

### Task 1: Verify Current Production Storage Wiring

**Files:**

- Reference: `Makefile`
- Reference: `scripts/aro-deploy.sh`
- Reference: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Confirm required deployment variables are available without printing values**

Run:

```bash
make env-check
```

Expected:

- Exit code `0`
- Hidden-value source report for `AZURE_SUBSCRIPTION_ID`, `ARO_RG`, `ARO_CLUSTER`, `AOAI_RG`, `AOAI_ACCOUNT`, `AOAI_DEPLOYMENT`
- A `DB_SECRET_NAME` line that is either `set (...)` or `unset`

- [ ] **Step 2: Ask for approval before credentialed ARO login**

Show the exact command and blast radius:

```bash
make aro-login
```

Expected approval text:

- Command touches the configured `ARO_CLUSTER`
- Blast radius statement: "Read-only login to the production OpenShift API; no resource changes by itself."
- Wait for explicit `yes`

- [ ] **Step 3: Log into the configured production cluster**

Run after approval:

```bash
make aro-login
```

Expected:

- Exit code `0`
- Summary showing Azure subscription, OpenShift user, and OpenShift server

- [ ] **Step 4: Capture current production namespace status**

Run:

```bash
make prod-status
```

Expected:

- Exit code `0`
- `Namespace: sre-simulator` (or the configured `PROD_NAMESPACE`)
- Pod list, route list, and deployment list for the production namespace

- [ ] **Step 5: Prove that the backend is wired for Azure SQL**

Run:

```bash
NS="${PROD_NAMESPACE:-sre-simulator}" \
oc -n "$NS" get deployment sre-simulator-backend \
  -o jsonpath='{range .spec.template.spec.containers[0].env[*]}{.name}{" value="}{.value}{" ref="}{.valueFrom.secretKeyRef.name}{"/"}{.valueFrom.secretKeyRef.key}{"\n"}{end}' \
  | rg '^(STORAGE_BACKEND|DATABASE_URL) '
```

Expected:

- A line for `STORAGE_BACKEND value=mssql`
- A line for `DATABASE_URL` with a secret reference like `ref=sre-sql-creds/connection-string`

Stop immediately if either line is missing.

- [ ] **Step 6: Capture and align the live DB secret name for the deploy shell**

Run:

```bash
NS="${PROD_NAMESPACE:-sre-simulator}"
LIVE_DB_SECRET_NAME="$(
  oc -n "$NS" get deployment sre-simulator-backend \
    -o jsonpath="{.spec.template.spec.containers[0].env[?(@.name=='DATABASE_URL')].valueFrom.secretKeyRef.name}"
)"
printf 'live_db_secret=%s\nenv_DB_SECRET_NAME=%s\n' "$LIVE_DB_SECRET_NAME" "${DB_SECRET_NAME:-unset}"
```

Expected:

- `live_db_secret=<secret-name>`
- `env_DB_SECRET_NAME=<same-secret-name>` or `unset`

If `DB_SECRET_NAME` is unset or different, export the live value before any production deploy:

```bash
export DB_SECRET_NAME="$LIVE_DB_SECRET_NAME"
```

- [ ] **Step 7: Verify the backend can serve a DB-backed request**

Run:

```bash
make db-port-forward-check NS="${PROD_NAMESPACE:-sre-simulator}"
```

Expected:

- Exit code `0`
- `Port-forward DB check passed.`

- [ ] **Step 8: Collect optional live SQL proof from inside the running backend**

Run only if you want deeper read-only evidence:

```bash
NS="${PROD_NAMESPACE:-sre-simulator}" \
SQL='SELECT TOP 3 difficulty, nickname, score, created_at FROM leaderboard_entries ORDER BY created_at DESC' \
make db-inspect-live NS="$NS"
```

Expected:

- Exit code `0`
- Read-only rows from `leaderboard_entries`

- [ ] **Step 9: Decision gate**

Proceed only if all of the following are true:

- `STORAGE_BACKEND=mssql`
- `DATABASE_URL` is secret-backed
- `DB_SECRET_NAME` is exported and matches the live deployment secret name
- `make db-port-forward-check` passes

If any check fails, stop before release-prep or deploy.

### Task 2: Prepare Release Metadata For v0.1.2

**Files:**

- Modify: `frontend/package.json`
- Modify: `backend/package.json`
- Modify: `helm/sre-simulator/Chart.yaml`
- Modify: `frontend/src/lib/release.ts`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update the frontend package version**

Change:

```json
{
  "name": "frontend",
  "version": "0.1.2",
  "private": true
}
```

- [ ] **Step 2: Update the backend package version**

Change:

```json
{
  "name": "sre-simulator-backend",
  "version": "0.1.2",
  "private": true
}
```

- [ ] **Step 3: Update Helm chart version surfaces**

Change:

```yaml
apiVersion: v2
name: sre-simulator
version: 0.1.2
appVersion: "0.1.2"
```

- [ ] **Step 4: Update the app version constant**

Change:

```typescript
export const APP_VERSION = "v0.1.2";
```

- [ ] **Step 5: Add the `0.1.2` changelog section**

Insert above the current `0.1.1` section:

```markdown
## [0.1.2] - 2026-04-18

### Changed

- Published post-`v0.1.1` fixes and operator improvements as a patch release from `main`.
- Hardened Helm networking behavior and IPv6 rate limiting for safer production traffic handling.
- Added ARO operator login and live Azure SQL inspection helpers for production verification and rollout support.
- Refreshed safe dependency updates across frontend and backend packages.
```

- [ ] **Step 6: Run the same release-surface consistency check used in CI**

Run:

```bash
RELEASE_TAG=v0.1.2 node <<'EOF'
const fs = require("fs");
const releaseTag = process.env.RELEASE_TAG;
const expectedVersion = releaseTag.slice(1);
const frontendPkg = JSON.parse(fs.readFileSync("frontend/package.json", "utf8"));
const backendPkg = JSON.parse(fs.readFileSync("backend/package.json", "utf8"));
const chart = fs.readFileSync("helm/sre-simulator/Chart.yaml", "utf8");
const releaseMeta = fs.readFileSync("frontend/src/lib/release.ts", "utf8");

const chartVersion = (chart.match(/^version:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$/m) || [])[1];
const chartAppVersion = (chart.match(/^appVersion:\s*"([0-9]+\.[0-9]+\.[0-9]+)"\s*$/m) || [])[1];
const appVersion = (releaseMeta.match(/APP_VERSION\s*=\s*"([^"]+)"/) || [])[1];

for (const [source, value] of [
  ["frontend/package.json", frontendPkg.version],
  ["backend/package.json", backendPkg.version],
  ["helm version", chartVersion],
  ["helm appVersion", chartAppVersion],
  ["APP_VERSION", appVersion],
]) {
  if (!value) {
    throw new Error(`Missing version in ${source}`);
  }
}

if (frontendPkg.version !== expectedVersion) throw new Error("frontend mismatch");
if (backendPkg.version !== expectedVersion) throw new Error("backend mismatch");
if (chartVersion !== expectedVersion) throw new Error("chart version mismatch");
if (chartAppVersion !== expectedVersion) throw new Error("chart appVersion mismatch");
if (appVersion !== releaseTag) throw new Error("APP_VERSION mismatch");
EOF
```

Expected:

- Exit code `0`
- No output

- [ ] **Step 7: Run the required release gates**

Run:

```bash
make validate
make test
make test-integration
```

Expected:

- All commands exit `0`

- [ ] **Step 8: Commit the release-prep change on a branch rooted in `main`**

Run:

```bash
git add frontend/package.json backend/package.json helm/sre-simulator/Chart.yaml frontend/src/lib/release.ts CHANGELOG.md
git commit -m "chore(release): prepare v0.1.2"
```

Expected:

- A single release-prep commit containing only the version/changelog updates

- [ ] **Step 9: Land the release-prep commit on `main`, then create the tag**

Run only after the release-prep commit is on `main`:

```bash
git checkout main
git pull
git tag -a v0.1.2 -m "Release v0.1.2"
git push origin v0.1.2
```

Expected:

- Tag `v0.1.2` points to a commit in `main`

### Task 3: Deploy And Babysit Production

**Files:**

- Reference: `Makefile`
- Reference: `data/prod-route.env`
- Reference: `scripts/aro-deploy.sh`

- [ ] **Step 1: Ask for approval before the production deploy**

Show the exact command and blast radius:

```bash
DB_SECRET_NAME="${DB_SECRET_NAME:?set from Task 1}" make prod-up-tag TAG=v0.1.2
```

Expected approval text:

- Target scope: production namespace `sre-simulator` on `ARO_CLUSTER`
- Blast radius statement: "Rebuilds and redeploys the frontend and backend in the production namespace."
- Wait for explicit `yes`

- [ ] **Step 2: Run the production deploy**

Run after approval:

```bash
DB_SECRET_NAME="${DB_SECRET_NAME:?set from Task 1}" make prod-up-tag TAG=v0.1.2
```

Expected:

- Exit code `0`
- `Production deployment ready.`
- `URL: https://...`
- `Probe status: 200`

- [ ] **Step 3: Re-check production namespace state immediately after rollout**

Run:

```bash
make prod-status
```

Expected:

- Exit code `0`
- Fresh backend and frontend pods in `Running`/`Ready`

- [ ] **Step 4: Confirm frontend/backend exposure rules still match policy**

Run:

```bash
make public-exposure-audit NS="${PROD_NAMESPACE:-sre-simulator}"
```

Expected:

- Exit code `0`
- `Exposure audit passed: frontend route exists, backend is internal-only.`

- [ ] **Step 5: Re-run the DB-backed request check on the new release**

Run:

```bash
make db-port-forward-check NS="${PROD_NAMESPACE:-sre-simulator}"
```

Expected:

- Exit code `0`
- `Port-forward DB check passed.`

- [ ] **Step 6: Re-confirm Azure SQL env wiring after rollout**

Run:

```bash
NS="${PROD_NAMESPACE:-sre-simulator}" \
oc -n "$NS" get deployment sre-simulator-backend \
  -o jsonpath='{range .spec.template.spec.containers[0].env[*]}{.name}{" value="}{.value}{" ref="}{.valueFrom.secretKeyRef.name}{"/"}{.valueFrom.secretKeyRef.key}{"\n"}{end}' \
  | rg '^(STORAGE_BACKEND|DATABASE_URL) '
```

Expected:

- `STORAGE_BACKEND value=mssql`
- `DATABASE_URL` still points to a secret-backed connection string

- [ ] **Step 7: Capture final release metadata for the handoff**

Run:

```bash
if [ -f data/prod-route.env ]; then
  sed -n '1,20p' data/prod-route.env
fi
```

Expected:

- `NS=...`
- `RELEASE=sre-simulator`
- `URL=https://...`
- `TAG=v0.1.2`
