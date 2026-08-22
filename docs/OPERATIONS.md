# Operations Runbook

This document is the operator-facing source of truth for release-operability tasks in this repo, especially Azure AKS E2E deploys and shared-edge hostname work.

## Root Make Targets

Use the root `Makefile` instead of ad-hoc shell commands.

- `make env-check`
  Verifies the required local env/bootstrap values are present before any live deploy target runs.
- `make aks-login`
  Refreshes the AKS kube context used by the deployment helpers.
- `make e2e-azure-route-up`
  Creates a fresh E2E namespace, deploys the app, and records metadata in `data/e2e-azure-route.env`.
- `make e2e-azure-route-refresh`
  Refreshes the current E2E namespace from `NS=...` or `data/e2e-azure-route.env`.
- `make e2e-azure-route-down`
  Removes the current E2E namespace recorded in `data/e2e-azure-route.env`.
- `make prod-up`
  Deploys the stable namespace using `TAG=latest` on AKS.
- `make prod-up-tag TAG=vX.Y.Z`
  Deploys a semver-tagged image to the stable namespace when the tagged GHCR artifacts exist.
- `make prod-status`
  Shows pods, deployments, and the active public exposure objects for the stable namespace.
- `make public-exposure-audit`
  Confirms the frontend edge exists and the backend remains internal-only.
- `make db-mode-check`
  Verifies the deployed backend is in Azure SQL mode.
- `make db-port-forward-check`
  Verifies the database can be reached from the deployed namespace path.

## Local Env And Bootstrap

Live deploy targets load their configuration from:

1. `backend/.env.local` when present
2. `backend/.env` as a fallback
3. explicit shell overrides when provided

`make env-check` should be the first live-deploy step because it confirms the variables needed by the chosen cluster flavor. For AKS E2E this includes:

- `AZURE_SUBSCRIPTION_ID`
- `AKS_RG`
- `AKS_CLUSTER`
- `AOAI_RG`
- `AOAI_ACCOUNT`
- `AOAI_DEPLOYMENT`

The E2E flow also depends on gitignored local material that must never be committed:

- `backend/.env.local` for live runtime values
- `infra/.tf-backend.env` for Terraform backend commands
- `data/e2e-azure-route.env` as a runtime metadata file written by the Make targets

When running from WSL against a Windows-authenticated kube context, export `KUBECONFIG=/mnt/c/Users/<user>/.kube/config` before calling the Make target so the shell helpers do not fall back to `localhost:8080`.

## AKS Exposure Modes

The AKS helpers support three exposure modes through `AKS_EXPOSURE_MODE`.

### `none`

- Intended for local operator verification only.
- The Make target deploys the namespace, then creates a local `kubectl port-forward`.
- The resulting URL is local to the operator machine.
- This is the default for `AKS_E2E_EXPOSURE_MODE`.

### `publicService`

- Exposes the frontend service as an Azure LoadBalancer service.
- Reuses the configured public IP and can be useful when host-based gateway routing is not required.
- The backend must remain `ClusterIP` only.
- No ingress objects should exist in this mode.

### `gateway`

- Exposes the frontend through Gateway API resources and TLS.
- The frontend service stays `ClusterIP`.
- The helper expects a Gateway, HTTPRoutes, and a certificate for the TLS secret.
- This is the stable-path default for AKS (`AKS_EXPOSURE_MODE ?= gateway`).
- When anonymous verification is configured, the profile enables Envoy
  client-IP detection, signed frontend-to-backend IP forwarding, and strict
  IP-backed trial enforcement. If that edge identity is unavailable, anonymous
  Easy mode fails closed.

## Shared-Edge Direct E2E Hostnames

The stable host `play.sresimulator.osadev.cloud` must stay healthy throughout any E2E hostname work.

The direct E2E hostname path used here was additive:

1. Read and back up the current Gateway, HTTPRoutes, certificates, and DNS state.
2. Leave the stable hostname route untouched.
3. Add a new hostname on the existing shared public edge.
4. Scope the new listeners so only explicitly labeled E2E namespaces can attach.
5. Create E2E-only `HTTPRoute` objects for the new hostname.
6. Add certificate coverage for the new hostname.
7. Add the DNS record for the new hostname.
8. Verify the stable host before changes, after each material change, and at the end.

This keeps the shared public IP reusable while preventing accidental takeover of the stable host path.

## Artifact Reality On AKS

AKS deploys consume GHCR images directly. The current helper behavior is important:

- By default, `scripts/aks-deploy.sh` consumes GHCR images directly during `make e2e-azure-route-up` and `make e2e-azure-route-refresh`.
- `TAG=latest` uses whatever GHCR currently serves as `latest`.
- `TAG=vX.Y.Z` requires those semver-tagged GHCR images to exist first.
- If `AKS_E2E_PUSH_DEV_IMAGES=true`, the E2E targets switch to a dev-only GHCR publish path before Helm runs.
- If `AKS_E2E_IMAGE_CACHE=true`, that publish path reuses the previous build's
  layers through a `:buildcache` registry cache instead of rebuilding from
  scratch. It stays **opt-in** and defaults to `false` for Make-driven and
  direct shell runs. Only the `live-e2e` CI job turns it on. The reason is a
  trust boundary: `live-e2e` builds pull-request head code with
  `packages: write` and exports `<image_repo>:buildcache`, and GHCR write
  permission is not scoped per tag, so an operator run that imported that ref
  would build from pull-request-controlled cache metadata and then deploy the
  result with real auth, database, and AI secrets. Do not flip this default
  until cache writes are isolated per trust boundary. The cache needs a BuildKit
  `docker-container` builder, which the script creates on demand, and write
  access to the image repository. If builder creation fails, the helper falls
  back to the original `docker build` plus `docker push`; cache export failures
  are ignored, so a cold or unavailable cache only costs the normal build time.
- The trusted release publish in `.github/workflows/build-push.yml` deliberately
  uses **no** build cache, for the same reason.
- `helm-integration` and `dependabot-e2e-build` use `type=gha` instead. The
  GitHub Actions cache is scoped per branch, so a pull-request run cannot
  overwrite what those trusted paths read.

This means a repo merge alone does not guarantee E2E will run the new app build. Always verify the required GHCR tags first.

## AKS Dev-Image Fallback

Use the dev-image fallback when:

- GitHub workflows cannot yet be trusted to publish the build you need for E2E
- you need a fresh non-prod image without overwriting `latest`
- you want the E2E namespace to consume a clearly non-production tag

Prerequisites:

- `gh` authenticated for a user that can push to `ghcr.io/tuxerrante/*`
- a local container CLI in PATH: `docker` or `podman`
- enough local resources to build both `frontend/Dockerfile` and `backend/Dockerfile`

Configuration knobs:

- `AKS_E2E_PUSH_DEV_IMAGES=true`
- optional `AKS_E2E_DEV_IMAGE_TAG=<custom-nonprod-tag>`
- optional `AKS_E2E_DEV_IMAGE_TAG_SUFFIX=dev` when you want a different required suffix such as `preview` or `alpha`
- optional `GHCR_USERNAME=<github-login>` if GHCR login should not be inferred from `gh api user`
- optional `AKS_E2E_IMAGE_CACHE=true` to opt in to the registry layer cache for
  a dev-image publish, accepting the trust-boundary caveat above

Default generated tag format:

- `e2e-<timestamp>-<shortsha>-dev`
- if git metadata is unavailable in the shell, the fallback uses `manual` in the tag rather than failing

Safety rules enforced by the helper:

- it refuses to publish `latest`
- it refuses to publish a production-looking semver tag such as `v0.3.0`
- the tag must end in the configured dev suffix

Examples:

```bash
AKS_E2E_PUSH_DEV_IMAGES=true make e2e-azure-route-up

AKS_E2E_PUSH_DEV_IMAGES=true \
NS=sre-manual-e2e-20260731-153322 \
make e2e-azure-route-refresh

AKS_E2E_PUSH_DEV_IMAGES=true \
AKS_E2E_DEV_IMAGE_TAG=e2e-20260731-225500-preview \
AKS_E2E_DEV_IMAGE_TAG_SUFFIX=preview \
NS=sre-manual-e2e-20260731-153322 \
make e2e-azure-route-refresh
```

If the machine does not have `docker` or `podman`, the Make target now fails early with a clear prerequisite error instead of silently reusing stale `latest`.

## Safe E2E Refresh Procedure

Use this order for a real AKS E2E refresh:

1. `make env-check`
2. Confirm the GHCR tags you plan to deploy actually exist.
   If you are using the local dev-image fallback, this means confirming the freshly pushed dev tag rather than `latest`.
3. Confirm the stable public host still returns healthy responses.
4. Reuse the current namespace when possible:
   `NS=<existing-namespace> make e2e-azure-route-refresh`
   The refresh target requires a non-empty `PROD_NAMESPACE` and refuses to
   operate on it.
5. For deterministic anonymous browser validation, pass both
   `TURNSTILE_TEST_MODE=true` and `LOCAL_TEST_VERIFICATION_ENABLED=true` as
   Make command-line variables. Never enable either local verification flag
   for production.
6. If you need a direct AKS hostname, set `AKS_EXPOSURE_MODE=gateway` for the refresh and ensure the hostname/cert/DNS path already exists.
7. Re-check:
   - stable host returns `200`
   - direct E2E host returns `200`
   - the footer version matches the intended release state
   - anonymous easy mode/session configuration still works

## GitHub OAuth On Direct E2E Hosts

GitHub OAuth Apps accept one registered callback URL. When `redirect_uri` is
provided, its host and port must match that callback; a different E2E hostname
is not covered by the production app. GitHub documents these constraints in
[Authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
and notes that OAuth Apps cannot have multiple callbacks in
[Creating an OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app).

Do not remove `redirect_uri`, relay the production session cookie, or weaken
state validation to work around a callback warning. The callback and state
cookie must remain on the same E2E origin.

For a non-production namespace, the AKS deploy helper enables GitHub sign-in
only when the selected auth Secret contains all of these keys:

- `github-client-id`
- `github-client-secret`
- `auth-session-secret`
- `github-callback-url`

The decoded `github-callback-url` must exactly equal:

```text
<public E2E origin>/api/auth/github/callback
```

When the key is absent or does not match, the deployment keeps the signed
session and anonymous verification configuration but omits the GitHub
credentials from the frontend Pod. The landing page then reports that GitHub
sign-in is unavailable instead of sending users to GitHub with an unassociated
callback.

Required human setup for a direct E2E hostname:

1. Register a separate GitHub OAuth App for the E2E environment. Prefer a
   stable dedicated E2E hostname; an ephemeral hostname requires its own app or
   a callback update whenever the hostname changes.
2. Set its callback to the exact E2E callback, for example
   `https://e2e-20260731-153322.sresimulator.osadev.cloud/api/auth/github/callback`.
3. Create an E2E-specific Kubernetes Secret with the four keys above. The
   `github-callback-url` value must be the same exact URL. Do not reuse the
   production GitHub client credentials.
4. Point the E2E deploy at that Secret with `GITHUB_AUTH_SECRET_NAME` and, when
   needed, `AUTH_SECRET_SOURCE_NAMESPACE`.
5. Refresh the E2E namespace and confirm `/api/auth/session` reports
   `authConfigured: true` before testing sign-in.

## Stable Host Continuous Gate

When touching shared-edge resources:

- probe the stable host before the first change
- probe again after each material DNS/gateway/certificate change
- stop immediately if the stable host degrades
- roll back the most recent additive change before doing anything else

Keep a probe history in the handoff so the next operator can see whether the stable host remained healthy throughout.

## Rollback Notes

Prefer additive, reversible changes only.

Rollback order for direct E2E hostname work:

1. remove or disable the E2E `HTTPRoute` objects for the direct hostname
2. remove the E2E-specific Gateway listeners if they were added
3. remove the E2E hostname certificate coverage
4. remove the DNS record for the direct hostname
5. confirm the stable host still returns healthy responses

For namespace-only rollback:

- `make e2e-azure-route-down NS=<namespace>` when you intentionally want to remove the temporary E2E namespace
- do not use `prod-down` for E2E cleanup

## Current Release Caveat

If GHCR `latest` still serves an older frontend footer than expected, the public E2E host is not on the intended release build even if routing is correct. In that case the blocker is artifact publication, not namespace wiring.

## Setup and Operations

Technical setup and operational commands are documented here so
`README.md` can stay customer-focused.

## Prerequisites

| Requirement | Version |
| --- | --- |
| Node.js | >= 20, with npm CLI available for existing `npm run`/`npx` scripts |
| Bun | 1.4.0 package manager/installer |
| gcloud | Optional for Vertex provider |
| Managed AI endpoint | Vertex or Azure OpenAI/Foundry |
| Helm | 4+ when `AKS_HELM_FORCE_CONFLICTS=true` |

## Local development

```bash
make install   # bun install --frozen-lockfile in frontend/ and backend/
make dev       # Node/Next runtime path remains unchanged
```

## AI runtime configuration

For provider options, environment variables, and runtime behavior, use:

- [docs/AI_RUNTIME.md](AI_RUNTIME.md)
- [docs/CONTENT_BOUNDARY.md](CONTENT_BOUNDARY.md)
- [docs/ARO_AI_CONNECTIVITY_SPIKE.md](ARO_AI_CONNECTIVITY_SPIKE.md)

## Useful Make targets

| Command | Description |
| --- | --- |
| `make validate` | Lint + typecheck validation |
| `make test` | Unit tests with coverage |
| `make test-integration` | Integration tests |
| `make test-e2e-live` | Authenticated live Playwright flows for all platforms |
| `make env-check` | Verify required local env/bootstrap settings before live e2e |
| `make security` | Security checks |
| `make aro-login` | Authenticate Azure CLI if needed and log `oc` into the configured ARO cluster |
| `make e2e-azure-route-up` | Create temporary Azure e2e namespace |
| `make e2e-azure-route-refresh` | Refresh existing e2e namespace |
| `make e2e-azure-route-down` | Delete temporary e2e namespace |
| `make prod-up-tag TAG=vX.Y.Z` | Deploy a specific semver release |
| `make prod-up-final` | Guarded production deploy sequence |
| `make prod-status` | Show production namespace status |
| `make prod-down` | Delete production namespace (explicit confirmation) |
| `make cluster-capacity-report` | Report schedulable cluster headroom (read-only) |

## Mandatory pull-request browser gate

Every PR must pass the `live-e2e` CI job. The job is serialized, requires
approval through the protected `live-e2e` GitHub Environment, creates an
isolated `sre-pr-<number>-<timestamp>` namespace, publishes non-semver PR
images, runs one anonymous entry plus three isolated platform users concurrently
on four distinct scenarios, uploads screenshots/results, and removes the
namespace in an `always()` cleanup step.

Dependabot PRs take a credential-minimized path because GitHub withholds normal
Actions secrets and gives their pull-request workflows a read-only token. A
unprivileged `pull_request` workflow builds the dependency-update images and
uploads immutable, SHA-bound artifacts. A trusted `workflow_run` validates and
publishes those artifacts without checking out PR code, claims one dedicated
namespace from a pre-provisioned pool, deploys only the trusted `main` chart
into it, and runs mock-AI/JSON browser coverage. Its kubeconfig is stored only
in the unprotected `dependabot-e2e` Environment and is bound to those
namespaces; it cannot read the production namespace, create namespaces, or
delete namespaces. The main `ci-gate` waits for the `dependabot-e2e` commit
status, so the bot path remains merge-blocking without Azure login or manual
approval.

### Dependabot E2E namespace pool

The Dependabot runs used to share one fixed namespace behind a single global
Actions concurrency group. GitHub keeps only one pending run per concurrency
group, so simultaneous Dependabot PRs evicted each other and `ci-gate` failed
with `dependabot-e2e (missing)` or `(pending)` even though every dependency
update was fine. Runs are now keyed on the PR head SHA and each claims its own
namespace.

The pool is pre-provisioned rather than created per PR on purpose. Creating a
namespace is cluster-scoped, and the namespaced verbs the job needs could only
be granted through a `ClusterRoleBinding`, because Kubernetes RBAC cannot scope
a `RoleBinding` to a namespace name prefix and the job cannot grant itself
rights in a namespace it just created. That binding would also expose the
production namespace. A bounded pool keeps the identity namespace-only and caps
how much of the shared AKS cluster Dependabot can consume at once.

Provision or resize it with cluster-admin credentials:

```bash
DEPENDABOT_E2E_POOL_SIZE=4 make dependabot-e2e-pool
```

The script is idempotent. It creates each namespace with restricted Pod
Security, the three `dependabot-e2e-*` NetworkPolicies the workflow verifies,
and a namespace-scoped `RoleBinding` that grants the E2E ServiceAccount the
built-in `admin` ClusterRole inside that namespace only. Then set the
repository variable it prints:

```text
DEPENDABOT_E2E_NAMESPACE_POOL="sre-dependabot-e2e-1 sre-dependabot-e2e-2 ..."
```

If that variable is unset the workflow fails at the claim step and tells you
to run the provisioner. There is deliberately no fallback to a single shared
namespace: that fallback existed during rollout and would silently restore the
exact configuration described above, where concurrent runs queue behind one
namespace until `ci-gate` gives up. The failure mode of the fallback is a slow
gate, which reads like flakiness and does not point at the configuration, so a
missing pool is treated as the misconfiguration it is.

Each run claims a slot by atomically creating a `dependabot-e2e-claim`
ConfigMap and releases it in an `always()` step. A claim left behind by a
cancelled run is reclaimed after `CLAIM_STALE_MINUTES` (45 by default), so a
lost runner cannot strand a slot permanently. Keep the pool size at or above
the combined `open-pull-requests-limit` in `.github/dependabot.yml` to avoid
queueing.

The `dependabot-e2e` Environment accepts protected branches only. The trusted
workflow re-reads PR metadata and refuses closed PRs, non-`main` bases,
non-Dependabot authors, non-Dependabot refs, forks, and stale triggering SHAs.

The namespace enforces restricted Pod Security and persistent default-deny
egress. Pods may resolve cluster DNS, and the frontend may reach only the
matching backend Pod on port 8080. PR-controlled images are built in a workflow
with read-only repository permissions and no secrets; only the trusted
default-branch workflow can publish packages or receive the namespace
kubeconfig.

### Weekly ephemeral namespace cleanup

Every job that creates a temporary namespace removes it in an `always()` step,
but a cancelled run, an expired runner token or a cluster hiccup can still
leave one behind, and a leaked namespace holds its CPU and memory requests
forever. Eight abandoned `sre-manual-e2e-*` namespaces, the oldest 61 days old,
once held 1700m CPU and 2176Mi of requests on this cluster.

The `Cleanup E2E Namespaces` workflow reclaims them every Monday. It runs only
from the default branch, so it never executes pull request code with the Azure
credentials and therefore needs no approval gate. Run it by hand with
`workflow_dispatch`, which defaults to reporting only, or locally:

```bash
make cleanup-e2e-namespaces                 # report what would be removed
DRY_RUN=false make cleanup-e2e-namespaces   # actually reclaim
```

The safety model, in the order the script applies it:

1. Only namespaces matching an allow-listed prefix are considered, and every
   prefix must start with `sre-` and be long enough to be selective.
2. Protected namespaces are then removed from the candidate list, so
   production and the `sre-dependabot-e2e*` pool survive a widened prefix.
3. A candidate must be older than `CLEANUP_MIN_AGE_HOURS` (24 by default),
   far above the 60 minute timeout of any job that creates one.
4. A `sre-pr-<number>` namespace is kept while that pull request still has a
   workflow run in flight.
5. Nothing is deleted unless `DRY_RUN` is explicitly `false`.

It also uninstalls Helm releases left inside a pool namespace that no run
currently claims, which is the other way pool capacity leaks.

### Cluster capacity monitoring

The Terraform baseline keeps the `Standard_B2s` node shape and lets the
cluster autoscaler grow the system pool from one to five nodes. Increasing the
maximum does not provision idle nodes: AKS adds a node only when pending pods
cannot fit from their declared requests, then removes unneeded nodes. This
provides burst room for concurrent E2E namespaces without raising the
one-node steady-state floor.

Prefer changing `aks_node_count_min` and `aks_node_count_max` in Terraform and
reviewing `make tf-plan`. For read-only inspection or an emergency live
adjustment, use parameterized Azure CLI commands and never paste subscription
IDs, resource names, or command output into public documentation:

```bash
az aks nodepool show \
  --subscription "$AZURE_SUBSCRIPTION_ID" \
  --resource-group "$AKS_RG" \
  --cluster-name "$AKS_CLUSTER" \
  --name system \
  --query '{count:count,min:minCount,max:maxCount,autoscaling:enableAutoScaling}'

az aks nodepool update \
  --subscription "$AZURE_SUBSCRIPTION_ID" \
  --resource-group "$AKS_RG" \
  --cluster-name "$AKS_CLUSTER" \
  --name system \
  --update-cluster-autoscaler \
  --min-count 1 \
  --max-count 5
```

The update command changes live state and can create Terraform drift. Reflect
the same bounds in Terraform and run `make tf-plan` before the next apply.

Node utilisation alone is a misleading capacity signal. AKS reserves part of
each node before workloads run, while the kubelet, container runtime and page
cache add a fixed floor that deleting application pods cannot reclaim.
Increasing VM size from utilisation alone can therefore buy capacity that the
scheduler does not need.

The number that actually constrains this repository is *schedulable* headroom,
because a new E2E namespace has to fit in what pod requests have not already
reserved. Requested and used resources can differ substantially, so the
cluster can refuse to schedule a pull request while looking almost idle.

`make cluster-capacity-report` reports that headroom, estimates how many more
E2E namespaces still fit, and lists requested versus actually used resources
per namespace so over-requesting is visible. It is strictly read-only; the
test suite fails if any mutating `kubectl` verb ever appears in it.

```bash
make cluster-capacity-report                      # fails below the thresholds
CAPACITY_STRICT=false make cluster-capacity-report # report only
MIN_FREE_CPU_PERCENT=25 make cluster-capacity-report
```

The weekly cleanup workflow runs it after reclaiming namespaces, and a
scheduled run that fails is mailed to the repository owner. That is the whole
alerting mechanism, and it is deliberate: an in-cluster Prometheus and Grafana
stack would consume several hundred Mi on nodes that have little to spare,
making the problem it observes worse, and no third-party monitoring service
gets access to this cluster.

Observation alone does not bound the damage, so `make dependabot-e2e-pool`
also applies a `ResourceQuota` and a `LimitRange` to every pool namespace. The
E2E identity holds the built-in `admin` role inside its namespace, so a quota
set by the cluster admin is the only ceiling that identity cannot lift. It is
sized from what the deploy really asks for, including the frontend autoscaler
that `scripts/aks-deploy.sh` enables up to 3 replicas, with roughly double
that as headroom. The `LimitRange` supplies default requests and limits, which
is what stops the quota from rejecting any container that omits them.

For local operator access, keep the base64-encoded namespace kubeconfig in
gitignored `backend/.env.local` as `DEPENDABOT_E2E_KUBECONFIG_B64`, then run
`make dependabot-e2e-kubeconfig`. The target validates and writes the decoded
credential with mode `0600` to
`~/.config/sresimulator/dependabot-e2e-kubeconfig`.

Local invocation against an existing environment:

```bash
make playwright-install
LIVE_E2E_BASE_URL=https://e2e.example.test \
LIVE_E2E_AUTH_SESSION_SECRET=<session-signing-secret> \
make test-e2e-live
```

Never print the session secret. PRs from forks cannot receive privileged
environment credentials and must be moved to a trusted same-repository branch
before merge.

## Production and infra guidance

For production environment safety checks and sequencing:

- [infra/POST_APPLY_CHECKLIST.md](../infra/POST_APPLY_CHECKLIST.md)

For release/tag policy and CI/CD gating:

- [docs/RELEASES.md](RELEASES.md)

### Public URL and DNS

The canonical public URL for the AKS production path is
`https://play.sresimulator.osadev.cloud`.

- Exposure modes and the frontend-only public edge are described in
  [docs/ARCHITECTURE.md](ARCHITECTURE.md) under "Cluster Exposure Model".
- Gateway TLS, DNS zone, and certificate automation details are captured in
  [docs/superpowers/specs/2026-04-24-aks-gateway-tls-design.md](superpowers/specs/2026-04-24-aks-gateway-tls-design.md).
- After Terraform changes, use
  [infra/POST_APPLY_CHECKLIST.md](../infra/POST_APPLY_CHECKLIST.md)
  to sequence DNS verification, certificate checks, and the final deploy flow.

For AKS, `publicService` remains the rollback exposure mode when operators need
to temporarily expose only the frontend through a `LoadBalancer` service. ARO
still uses the Route-based fallback described in the architecture doc.

## Live platform-session verification

For impactful gameplay changes, run the full deployed platform-session probe:

1. Bootstrap local gitignored env files into the worktree when they exist:
   `backend/.env.local`, `infra/.tf-backend.env`, and (only when intentionally
   reusing a namespace) `data/e2e-azure-route.env`.
2. Verify required local settings:
   `make env-check`
3. Deploy the temporary environment:
   `make e2e-azure-route`
4. Load local secrets into the shell without printing them and source the
   route metadata from `data/e2e-azure-route.env`.
5. Run deployed integration coverage with:
   `E2E_BACKEND_URL="$URL" E2E_AUTH_SESSION_SECRET="$AUTH_SESSION_SECRET" E2E_GAMEPLAY_ADMIN_TOKEN="$GAMEPLAY_ADMIN_TOKEN" make test-integration`
6. Confirm the platform-session suite covers `aro-classic`, `aro-hcp`, and
   `aks`, including score submission and platform-filtered analytics.
7. Keep the temporary namespace until reviewer signoff, then tear it down with
   `NS="$NS" make e2e-azure-route-down`.
