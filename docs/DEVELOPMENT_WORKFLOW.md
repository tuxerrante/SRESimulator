# Default Development Workflow

This is the default flow for any non-trivial change in this repository,
including changes driven by an AI agent. It exists so that parallel work stays
isolated, disk usage stays bounded, review quality stays high, and the
mandatory browser gate is never bypassed.

Deviating from this flow is allowed only when the change is a single-file
documentation edit or an emergency rollback, and the deviation must be stated
explicitly in the pull request body.

## 1. Always start from fresh `main`

```bash
git fetch origin --prune
git -C . rev-parse origin/main
```

Never branch from a stale local `main`, and never stack a new change on an
unmerged branch unless the dependency is real and documented in the pull
request body.

## 2. One worktree per change, under `./.worktrees/`

Each independent change gets its own git worktree so that several changes can
progress in parallel without cross-contaminating the working tree:

```bash
git worktree add -b chore/my-change .worktrees/my-change origin/main
```

`.worktrees/` is git-ignored (see `.gitignore`).

Rules:

- One worktree, one branch, one pull request, one reviewable concern.
- Two parallel worktrees must not own the same file. If two planned changes
  both touch, for example, `backend/Dockerfile`, sequence them instead of
  running them in parallel, and rebase the second one after the first merges.
- Agents working in a worktree stay inside that worktree. The main checkout at
  the repository root is never used as a scratch area for branch work.

## 3. Share caches, do not duplicate data on disk

Worktrees multiply build artifacts very quickly (`node_modules`, `.next`,
`dist`, container layers). Always reuse the shared, user-level caches instead
of creating per-worktree copies:

- Package manager cache: the global cache directory (`~/.npm`, and
  `~/.bun/install/cache` when Bun is used) is shared automatically. Do not
  override it to a worktree-local path.
- Container builds: reuse the shared BuildKit builder
  (`AKS_E2E_CACHE_BUILDER`, default `sre-e2e-cache`) and the registry layer
  cache enabled by `AKS_E2E_IMAGE_CACHE`. See
  [docs/OPERATIONS.md](OPERATIONS.md).
- Do not install dependencies in a worktree whose change is configuration or
  documentation only.
- Delete large intermediates (`.next`, `dist`, throwaway images) as soon as a
  validation step is done.

## 4. Validate locally before pushing

Prefer the `make` targets over ad-hoc commands, and run the smallest set that
actually covers the change:

```bash
make lint
make test
make test-shell
```

Shell and deploy-script behaviour is covered by `scripts/*.test.sh`, which use
fake `docker`/`kubectl` binaries and therefore do not need a cluster.

## 5. Open one pull request per worktree

The pull request body must state what changed, why, how it was validated, and
the rollback plan. Use Conventional Commit messages.

## 6. Automated review loop until clean

Every pull request is reviewed by GitHub Copilot code review (Balanced),
requested through the GitHub GraphQL API:

```bash
OWNER=<repository-owner>   # e.g. the value of `gh repo view --json owner`
REPO=<repository-name>
PR=<pull-request-number>

PR_NODE_ID=$(gh api graphql -f query='
  query($owner:String!,$repo:String!,$number:Int!){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$number){ id }
    }
  }' -F owner="$OWNER" -F repo="$REPO" -F number="$PR" \
  --jq .data.repository.pullRequest.id)

# Bot id of copilot-pull-request-reviewer[bot]; read it once from any PR that
# Copilot has already reviewed. Filter by login: `.[0]` may be a human review.
#   gh api repos/$OWNER/$REPO/pulls/$PR/reviews \
#     --jq 'map(select(.user.login=="copilot-pull-request-reviewer[bot]"))
#           | .[0].user.node_id'
COPILOT_BOT_ID=<bot-node-id>

gh api graphql -f query='
  mutation($pullRequestId:ID!,$botIds:[ID!]){
    requestReviews(input:{
      pullRequestId:$pullRequestId, botIds:$botIds, union:true
    }){ pullRequest { number } }
  }' -F pullRequestId="$PR_NODE_ID" -f botIds="$COPILOT_BOT_ID"
```

`RequestReviewsInput` exposes `userIds`, `botIds`, `teamIds` and `union`;
Copilot is a `Bot` actor, so it must be passed through `botIds`. The equivalent
REST call, already documented in `.cursor/rules/pr-lifecycle.mdc`, is a valid
fallback:

```bash
gh api "repos/$OWNER/$REPO/pulls/$PR/requested_reviewers" \
  --method POST -f 'reviewers[]=copilot'
```

The loop is:

1. Request a review.
2. Fix every finding of **Medium severity or higher**.
3. Reply to each review thread with an explanation of the fix, or of why the
   finding does not apply, and resolve the thread.
4. Request a new review.
5. Repeat until a full review pass produces no Medium-or-higher finding.

A pull request is not merge-ready while any Medium-or-higher finding is open
or any review thread is unresolved and unexplained.

## 7. Mandatory live browser gate

The merge-blocking browser end-to-end gate described in
[CLAUDE.md](../CLAUDE.md) and [docs/OPERATIONS.md](OPERATIONS.md) still
applies without exception:

- Human-authored pull requests must pass the protected `live-e2e` check.
- Dependabot pull requests use the separate `dependabot-e2e` status.
- The `live-e2e` GitHub Environment requires an explicit deployment approval
  before cluster and AI credentials are released to pull request code. Review
  the workflow, deploy, Helm, Dockerfile, and E2E-script changes in the diff
  **before** approving.
- A pull request whose gate is skipped, pending, or failing is not
  merge-ready.

## 8. Clean up after the merge

Cleanup is part of the change, not an optional follow-up. The repository merges
pull requests with **squash** only, so the topic branch tip never becomes an
ancestor of `main` and `git branch -d` will refuse to delete it. Confirm the
pull request actually merged first, then force-delete the local branch. Run
this block from the **main checkout**, not from the task worktree: a worktree
cannot remove itself, and `.worktrees/my-change` would otherwise resolve
relative to the worktree you are standing in.

```bash
MAIN_CHECKOUT=/path/to/SRESimulator   # the main checkout, not .worktrees/*
cd "$MAIN_CHECKOUT"

gh pr view <PR> --json state,mergedAt --jq '{state,mergedAt}'   # expect MERGED

git fetch origin --prune
git worktree remove .worktrees/my-change
git worktree prune
git branch -D chore/my-change
```

Then reclaim build storage that the change created. `docker buildx prune`
only prunes the *currently selected* builder, while `scripts/aks-deploy.sh`
builds with `buildx build --builder ${AKS_E2E_CACHE_BUILDER:-sre-e2e-cache}`
without ever selecting it. Target that builder explicitly, and tolerate it not
existing:

```bash
BUILDER="${AKS_E2E_CACHE_BUILDER:-sre-e2e-cache}"
if docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  docker buildx prune --builder "$BUILDER" --filter until=168h -f
fi
docker buildx prune --filter until=168h -f   # default builder
docker image prune -f
```

Leave the shared package-manager caches in place: they are the mechanism that
keeps the next worktree cheap.

## 9. Manual verification session

To exercise the merged result in a browser against a real deployment, refresh
the personal end-to-end namespace instead of testing against production.

A merge alone does **not** publish new images: on AKS the target defaults to
`TAG=latest`, which only moves when a semver release is published, and
`docs/OPERATIONS.md` warns explicitly that a repository merge does not
guarantee E2E runs the new build. So either verify that a GHCR tag containing
the merged commit already exists and pass it explicitly, or build and publish
a dev image from a checkout that is actually on the merged commit:

```bash
git checkout main && git pull --ff-only

# Option A - a release tag containing the merged commit already exists:
make e2e-azure-route-refresh TAG=vX.Y.Z

# Option B - no release yet: publish a dev-only image from this checkout.
AKS_E2E_PUSH_DEV_IMAGES=true make e2e-azure-route-refresh
```

`make e2e-azure-route-refresh` with no arguments and no published tag will
silently redeploy the old `latest` image and prove nothing.

See [docs/OPERATIONS.md](OPERATIONS.md) for prerequisites, exposure modes, the
dev-image tag rules, and the safety rails that forbid targeting the production
namespace.
