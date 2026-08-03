# Platform Multi-Path Sessions Design

## Goal

Add a first-class session platform selector so SRESimulator can run
platform-correct incident sessions for `aro-classic`, `aro-hcp`, and `aks`
inside one product, while keeping the gameplay loop, storage model, and asset
ownership shared.

## Current Context

- The current product is difficulty-first. The landing page, session store,
  telemetry, leaderboard, and admin analytics do not carry a platform
  dimension.
- Gameplay content is still ARO-assumptive in multiple layers:
  - scenario assets use ARO/OpenShift cluster names and expectations
  - prompt builders hardcode ARO wording
  - terminal/chat command types only understand `oc | kql | geneva`
  - mock scenarios and mock command paths always generate ARO-shaped output
- The scenario catalog loader only indexes `scenarios/<difficulty>/*.json` and
  returns the first matching file, so it cannot express a reachability matrix
  across multiple platforms and multiple scenarios.
- The repository already has multi-platform host deployment concerns
  (`CLUSTER_FLAVOR=aks|aro`), but that is infrastructure for running the
  simulator itself, not a player-facing gameplay dimension.
- Knowledge retrieval is currently one shared OpenShift-heavy bundle, which is
  not enough for hosted control plane or AKS-specific session guidance.

## Non-Negotiable Decisions

- Keep one shared gameplay flow across platforms.
- Introduce a first-class platform model with per-platform profiles:
  - `aro-classic`
  - `aro-hcp`
  - `aks`
- AKS sessions use `kubectl + KQL + dashboard`.
- Persist platform in session, analytics, and leaderboard data.
- Keep SRESimulator fully independent from any external authoring repo or
  workflow.
- Allow optional external incident-authoring workflows only when they export
  plain sanitized assets that this repo can own directly.
- Make catalog selection support multiple reachable scenarios per platform and
  difficulty.
- Verify the change with linters, unit tests, integration tests, and new live
  e2e coverage.

## Platform Boundary

The selected gameplay platform is not the same thing as the cluster flavor used
to host the simulator application.

- `CLUSTER_FLAVOR` and `PROD_CLUSTER_FLAVOR` remain deployment concerns for the
  app infrastructure.
- `PlatformId` is a new gameplay concern for simulated incident sessions.
- No code path should infer the session platform from the host deployment
  flavor, or vice versa.

This separation is required because the simulator can be deployed on AKS or ARO
while still presenting an `aro-classic`, `aro-hcp`, or `aks` session to the
player.

## Chosen Approach

Use a session-platform dispatcher.

The player chooses platform first and difficulty second. The chosen platform
selects a `PlatformProfile` that controls:

- cluster CLI wording (`oc` or `kubectl`)
- platform-specific prompt fragments
- platform-specific knowledge bundles
- catalog filtering and reachability checks
- dashboard framing and labels
- leaderboard and analytics slicing

Everything else stays shared:

- incident ticket flow
- investigation phases
- chat loop
- dashboard layout
- telemetry capture
- scoring
- score submission

This keeps the product as one simulator with three content paths instead of
forking the app into separate platform-specific implementations.

## Shared Gameplay Flow

Every supported platform follows the same session lifecycle:

1. Player selects a platform.
2. Player selects a difficulty.
3. `POST /api/scenario` creates a session that is bound to that platform.
4. Backend chooses a reachable scenario for `(platform, difficulty)` and loads
   platform-aware prompt and knowledge inputs.
5. Player uses the same chat, dashboard, and terminal workflow, but the
   platform profile controls which cluster CLI vocabulary is valid.
6. Gameplay telemetry, score submission, leaderboard writes, and analytics all
   persist the same platform value that was chosen at session creation time.

The gameplay loop remains one loop. Platform changes the content contract, not
the application architecture.

## Platform Profiles

Introduce a shared `PlatformId` union and a repo-owned `PlatformProfile`
registry.

### `aro-classic`

- Cluster CLI: `oc`
- Secondary surfaces: `kql`, dashboard
- Guidance model: classic ARO/OpenShift operations, including machine API and
  classic control plane remediation patterns
- Knowledge emphasis: OpenShift lifecycle, routes, machine objects, cluster
  operators, ARO classic failure modes

### `aro-hcp`

- Cluster CLI: `oc`
- Secondary surfaces: `kql`, dashboard
- Guidance model: hosted control plane boundaries, with prompts that distinguish
  guest-cluster investigation from management-plane responsibilities
- Knowledge emphasis: hosted control plane limits, safe guest-cluster actions,
  nodepool and control-plane ownership boundaries

### `aks`

- Cluster CLI: `kubectl`
- Secondary surfaces: `kql`, dashboard
- Guidance model: AKS and Kubernetes terminology, managed control plane
  constraints, and nodepool-centric investigation
- Knowledge emphasis: AKS nodepools, managed cluster behavior, Kubernetes
  objects, and AKS-flavored incident patterns

### Dashboard

The dashboard becomes the first-class read-only context surface across all
platforms. New platform-aware sessions should stop treating "Geneva" as a
distinct primary gameplay mode.

For migration safety:

- legacy `geneva` markers can remain as a compatibility alias while existing
  tests and fixtures are updated
- new prompts, shared types, and UI copy should treat the dashboard as the
  canonical surface name

## Data And API Model

### Shared Types

Add `PlatformId` and `PlatformProfile` to the shared model, then thread
`platform` through the existing session and analytics contracts.

At minimum, the following models become platform-aware:

- `Scenario`
- `GameSession`
- `CreateGameSessionInput`
- `GameplayTelemetryEvent`
- `GameplayRecord`
- `GameplayAnalytics`
- `GameplayDifficultyAnalytics`
- `GameplayScenarioAnalytics`
- `RecentGameplaySession`
- `LeaderboardEntry`
- derived leaderboard and Hall of Fame view models

`Scenario` should gain an explicit `platform: PlatformId` field so every
scenario payload is self-describing.

### Platform-Specific Scenario Context

Keep the current generic scenario fields, but add an optional structured
`platformContext` object for platform-specific identifiers that should not be
hidden inside free-form text.

Examples:

- `aro-classic`: machine names, route names, cluster operator hints
- `aro-hcp`: guest-cluster identifiers, hosted control plane boundary notes
- `aks`: nodepool names, managed resource group hints, cluster add-on context

Prompt builders should prefer this structured context when available, with the
current text-extraction helpers kept only as a compatibility fallback.

### Session Creation

`POST /api/scenario` must accept `platform` alongside `difficulty`.

The session store becomes the source of truth:

- the session is created with a specific `platform`
- the chosen scenario must have the same `platform`
- later chat, command, gameplay, and score-submission routes must validate
  against the stored session platform rather than trusting the browser

### Command Surface

Platform-aware sessions should separate executable commands from read-only
dashboard context.

- Executable command types become:
  - `oc`
  - `kubectl`
  - `kql`
- Dashboard inspection remains a shared UI surface, not a terminal command type.
- Legacy `geneva` parsing can remain temporarily as a migration alias to the
  dashboard concept, but it should not remain a first-class long-term command
  type.

This makes the AKS path explicit without forking the overall gameplay flow.

### Scores And Analytics APIs

- `GET /api/scores` should accept a `platform` filter.
- `GET /api/gameplay/admin` should expose platform-aware analytics and support a
  `platform` filter or all-platform admin view.
- Player-facing leaderboards should default to platform-filtered results.
- Cross-platform public competition is out of scope for the initial change.

## Persistence Design

Add `platform` to every persisted gameplay record that already stores
difficulty-dependent or scenario-dependent state:

- `sessions`
- `gameplay_metrics`
- `leaderboard_entries`

### SQL Changes

Add a `platform` column with a constrained enum-like check:

- `aro-classic`
- `aro-hcp`
- `aks`

Required data changes:

- backfill legacy rows to `aro-classic`
- update session writes to persist `platform`
- update gameplay telemetry writes to persist `platform`
- update leaderboard writes and uniqueness constraints to include `platform`

The persistent leaderboard uniqueness key should become:

- `(github_user_id, platform, difficulty, traffic_source)`

That keeps best-score semantics fair within a platform and difficulty without
mixing fundamentally different investigation surfaces.

### JSON Store Changes

The JSON and in-memory stores must persist the same `platform` field so local
development and tests use the same contract as SQL mode.

## Catalog And Asset Model

### Scenario Asset Layout

Move to a platform-aware catalog layout:

```text
scenarios/
  aro-classic/
    easy/
    medium/
    hard/
  aro-hcp/
    easy/
    medium/
    hard/
  aks/
    easy/
    medium/
    hard/
```

Each scenario file remains plain sanitized JSON and must declare:

- `id`
- `platform`
- `difficulty`
- the normal scenario payload fields

The runtime should validate that the file path and the file body agree on
platform and difficulty.

### Multi-Platform And Multi-Scenario Reachability

Catalog loading must build an index of all reachable scenarios for each
supported `(platform, difficulty)` pair.

Required behavior:

- startup validation fails if any supported pair has zero reachable scenarios
- catalog selection no longer returns "the first file in the directory"
- normal selection chooses one candidate from the full reachable set for that
  pair using a standard random pick
- deterministic tests and admin tooling can request a specific `scenarioId`

This is the minimum behavior required to support both multiple platforms and
multiple scenario options within the same product.

### AI-Generated Scenarios

If AI-generated scenarios remain supported, the generator must receive the same
`PlatformProfile` and return a scenario tagged with the chosen `platform`.

The AI path should not remain ARO-hardcoded once platform-aware sessions exist.

## Knowledge Bundles And Prompt Fragments

### Shared Plus Platform-Specific Composition

Keep the current investigation-method bundle as shared content, then add
platform-specific bundles and prompt fragments on top.

Proposed composition order:

1. Shared investigation methodology bundle
2. Shared simulator prompt fragments
3. Platform-specific knowledge bundles
4. Platform-specific prompt fragments
5. Scenario-specific context

### Knowledge Bundles

Keep the current shared files repo-owned, then add platform-specific knowledge
under a dedicated layout such as:

```text
knowledge_base/
  sre-investigation-techniques.md
  Openshift-clusters-alerts-resolutions.md
  Community-reported-issues.md
  platforms/
    aro-classic/
    aro-hcp/
    aks/
```

The retrieval layer should combine shared and platform-specific bundles for the
active session instead of using one universal OpenShift-heavy set for every
platform.

### Prompt Fragments

Refactor hardcoded prompt builders so repo-owned fragments can be composed by
profile.

At minimum:

- chat system prompt stops hardcoding ARO-only product identity
- command prompt stops assuming `oc` as the only cluster CLI
- scenario-generation prompt stops hardcoding ARO-specific version and platform
  guidance
- mock AI paths become profile-aware so local and integration tests exercise the
  correct command vocabulary

Prompt fragments remain repo-owned implementation assets. External authoring
workflows must not be allowed to inject executable prompt logic into runtime.

## Frontend And UX Changes

### Home Flow

The landing page becomes platform-first:

- add a platform selector above the difficulty grid
- keep the difficulty grid and access rules shared
- persist the last selected platform in client state for convenience
- if no prior selection exists, use a repo-owned application default constant
  for the initial platform selection; that default must not be inferred from
  the live host cluster flavor at runtime

### Game State

Frontend game state must persist the chosen platform with the rest of the
session contract:

- selected platform
- active scenario
- session token
- telemetry payload construction

### Leaderboard And Admin Views

- player-facing leaderboard adds platform filters and should default to
  platform-specific views
- admin analytics adds platform-aware grouping and filtering
- recent sessions, scenario breakdowns, and difficulty breakdowns should show
  the stored platform so mixed-platform operational analysis is possible

## External Authoring Boundary

SRESimulator must stay fully usable from this repository alone.

That means:

- no runtime fetches from an authoring repo
- no build-time requirement to clone or sync an external repo
- no submodule, MCP, or CI dependency that is required just to run the simulator
- no opaque authoring-only IDs or remote workflow state in the runtime contract

Optional external incident-authoring workflows are acceptable only if they
export plain sanitized assets that this repo can own directly, such as:

- scenario JSON files
- markdown knowledge documents
- static catalog manifests

Those exported assets must be fully resolved before runtime. The simulator
should not need an external authoring tool to interpret them.

## Migration Strategy

Use a compatibility-first rollout.

### Data Backfill

- backfill missing persisted platform values to `aro-classic`
- treat existing scenario assets as `aro-classic` until they are moved into the
  platform-aware catalog layout

### API Compatibility

During the migration window only:

- missing `platform` in incoming scenario requests can default to
  `aro-classic`
- legacy `geneva` command markers can be parsed as dashboard aliases

Once the frontend, tests, and fixtures are fully updated, these compatibility
fallbacks should be removed.

### Content Rollout

Roll out in this order:

1. add shared `PlatformId` and persistence plumbing
2. add platform selector and session contract updates
3. migrate catalog and prompt composition
4. migrate leaderboard and analytics filters
5. remove temporary ARO-only fallbacks

## Verification Design

Verification must cover both contract correctness and end-to-end session
behavior.

### Repository Gates

- `make validate`
- `make test`
- `make test-integration`

### New Coverage Requirements

Add focused unit and integration coverage for:

- platform profile resolution
- catalog reachability validation
- scenario selection by `(platform, difficulty)`
- prompt and knowledge composition by platform
- session validation rejecting platform mismatches
- leaderboard uniqueness and filtering by platform
- analytics grouping and filtering by platform
- mock chat and command paths using the correct cluster CLI

### New Live E2E Coverage

Add new live e2e session coverage that exercises the real deployed app through
the existing temporary route workflow.

Minimum live coverage:

- start a session for `aro-classic`
- start a session for `aro-hcp`
- start a session for `aks`
- verify the correct command surface is emitted for each path
- complete telemetry and score submission
- verify platform-aware leaderboard or analytics visibility

Because the selected gameplay platform is simulated content, not host cluster
infrastructure, this live e2e matrix can run against one live deployed
SRESimulator environment. It does not require the host cluster flavor to match
the simulated session platform.

The existing `make e2e-azure-route` deployment flow remains the right place to
bootstrap that live app endpoint; the new platform-session checks should layer
on top of it rather than invent a separate deployment workflow.

## Out Of Scope

- changing the existing scoring model per platform
- inventing a cross-platform public Hall of Fame ranking in the initial change
- adding a hard dependency on any external incident-authoring system
- reusing `CLUSTER_FLAVOR` as the gameplay platform field
- provisioning new infrastructure just to represent `aro-hcp` as simulated
  gameplay content

## Success Criteria

- A player can start a session for `aro-classic`, `aro-hcp`, or `aks` from one
  shared landing page.
- The session stores and validates the chosen platform end to end.
- ARO sessions surface `oc`, while AKS sessions surface `kubectl`, without
  changing the shared gameplay loop.
- Platform-specific knowledge bundles and prompt fragments are used for the
  active session.
- Catalog validation guarantees at least one reachable scenario for every
  supported `(platform, difficulty)` pair.
- Leaderboard and admin analytics persist and expose platform-aware data.
- The repository remains fully functional without any external authoring repo or
  workflow.
- `make validate`, `make test`, `make test-integration`, and the new live e2e
  platform-session coverage pass before implementation is considered complete.
