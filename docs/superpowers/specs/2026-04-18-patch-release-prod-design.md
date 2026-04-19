# Patch Release v0.1.2 Production Deployment Design

## Goal

Prepare and promote the next patch release, `v0.1.2`, while verifying that the
current production deployment on `ARO_CLUSTER` is using Azure SQL storage and
that the DB-backed path is healthy before any rollout proceeds.

## Current Context

- Repository state is clean on `main`.
- Latest semver tag is `v0.1.1`.
- Checked-in release metadata is still aligned to `0.1.1`, so a real `v0.1.2`
  release requires a release-prep change on `main` before tagging.
- Production deploys are expected to use the Makefile path, especially
  `make prod-up-tag TAG=vX.Y.Z`.
- Azure SQL mode is only enabled when `DB_SECRET_NAME` is set, which causes the
  Helm deploy path to turn on `database.enabled=true` and inject
  `STORAGE_BACKEND=mssql` plus `DATABASE_URL` from a Kubernetes secret.
- A production redeploy can silently fall back out of Azure SQL mode if the
  live DB secret name is not carried into the deploy environment as
  `DB_SECRET_NAME`.

## Chosen Approach

Use an observe-then-release flow:

1. Verify the current production release first.
2. Stop immediately if production is not Azure-SQL-backed or if the DB path is
   unhealthy.
3. If production is healthy, prepare the `v0.1.2` release surfaces and changelog.
4. Run the documented validation and test gates.
5. Tag `v0.1.2` from `main`.
6. Deploy `v0.1.2` to production and babysit the rollout.
7. Re-run exposure and DB checks after rollout.

## Verification Design

### Pre-deploy checks

- Run `make env-check` to confirm required variables are present without
  printing secret values.
- Run `make aro-login` only after explicit confirmation because it uses
  `az aro list-credentials`.
- Inspect production state with:
  - `make prod-status`
  - backend deployment env wiring for DB mode
  - `make db-port-forward-check NS=sre-simulator`
  - `make db-inspect-live NS=sre-simulator` if deeper read-only proof is needed
- Capture the live `DATABASE_URL` secret reference and ensure `DB_SECRET_NAME`
  in the deploy shell matches that secret name before any production rollout.

### Release-prep checks

- Align:
  - `frontend/package.json`
  - `backend/package.json`
  - `helm/sre-simulator/Chart.yaml`
  - `frontend/src/lib/release.ts`
  - `CHANGELOG.md`
- Run:
  - `make validate`
  - `make test`
  - `make test-integration`

### Deployment checks

- Use `DB_SECRET_NAME=... make prod-up-tag TAG=v0.1.2` for the production
  rollout, with the secret name copied from the live deployment verification.
- Pause for explicit confirmation before the deploy command because the flow
  fetches live cloud credentials and changes production state.
- After deployment, run:
  - `make public-exposure-audit NS=sre-simulator`
  - `make db-port-forward-check NS=sre-simulator`

## Stop Conditions

- Production is not DB-backed.
- Production is DB-backed but the DB request path is unhealthy.
- Release validation or tests fail.
- Post-deploy exposure or DB checks fail.

Any stop condition blocks release promotion until the failure is reviewed.

## Success Criteria

- Current production is proven to be Azure-SQL-backed and healthy before rollout.
- Release metadata is aligned to `v0.1.2`.
- Required validation and test gates pass.
- Production rollout completes without forcing or bypassing repo safety paths.
- Post-deploy checks confirm the new release still uses Azure SQL and serves the
  DB-backed path correctly.
