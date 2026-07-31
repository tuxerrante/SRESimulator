# Platform Multi-Path Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class gameplay platform selector and platform-aware session model so one SRESimulator deployment can run `aro-classic`, `aro-hcp`, and `aks` incident sessions using repo-owned scenarios, knowledge bundles, prompts, storage, analytics, and live verification.

**Architecture:** Introduce a shared `PlatformId` contract plus a repo-owned platform registry. The chosen platform is written once when the session is created and becomes the source of truth for scenario selection, prompt composition, command vocabulary, telemetry, leaderboards, and analytics; no runtime path may infer gameplay platform from `CLUSTER_FLAVOR`. Repo-owned JSON and Markdown assets under `scenarios/` and `knowledge_base/platforms/` replace any need for runtime lookups into `aro-ai-tools` or another authoring repository.

**Tech Stack:** TypeScript, Next.js 16 App Router, Express 5, Zustand, Vitest, Azure SQL/JSON storage backends, repo-owned Markdown knowledge bundles, Makefile-driven validation and Azure route e2e workflow.

## Global Constraints

- Keep one shared gameplay flow across platforms.
- Supported gameplay platforms are exactly `aro-classic`, `aro-hcp`, and `aks`.
- `PlatformId` is a gameplay concern; `CLUSTER_FLAVOR` and `PROD_CLUSTER_FLAVOR` remain deployment concerns only.
- AKS sessions use `kubectl + KQL + dashboard`.
- Persist platform in session, analytics, and leaderboard data.
- Keep SRESimulator fully independent from any external authoring repo or workflow.
- Optional authoring workflows may export only plain sanitized assets that this repo owns directly.
- Use repo-owned prompt fragments and knowledge bundles; do not inject executable prompt logic from external content.
- Treat `Dashboard` as the canonical read-only surface name; keep `geneva` only as a compatibility alias while older fixtures are being updated.
- Guarantee at least one reachable scenario for every supported `(platform, difficulty)` pair before catalog-backed startup succeeds.
- Final implementation verification must run through `make validate`, `make test`, `make test-integration`, and `make e2e-azure-route`.

---

## File Structure

### Shared contracts

- Create: `shared/types/platform.ts`  
  Source of truth for `PlatformId`, `PlatformProfile`, `PlatformContext`, command-surface unions, `PLATFORM_IDS`, and `DEFAULT_PLATFORM_ID`.
- Modify: `shared/types/game.ts`  
  Add `platform: PlatformId` and `platformContext?: PlatformContext` to `Scenario`.
- Modify: `shared/types/chat.ts`  
  Extend extracted command unions to include `kubectl`.
- Modify: `shared/types/terminal.ts`  
  Extend terminal entry command type to include `kubectl`.
- Modify: `shared/types/gameplay.ts`  
  Add `platform` to telemetry payloads and analytics view models; add `byPlatform` analytics.
- Modify: `shared/types/leaderboard.ts`  
  Add `platform` to leaderboard and Hall of Fame models.

### Backend runtime and persistence

- Create: `backend/src/lib/platform-profiles.ts`  
  Repo-owned runtime registry that maps each `PlatformId` to its primary CLI, allowed command surfaces, knowledge files, and prompt fragment selection.
- Modify: `backend/src/lib/scenario-catalog.ts`  
  Replace difficulty-only indexing with `(platform, difficulty)` indexing and optional `scenarioId` selection.
- Modify: `backend/src/lib/knowledge.ts`  
  Load shared KB files plus platform-specific bundle files.
- Create: `backend/src/lib/prompts/platform.ts`  
  Platform-specific prompt fragments for chat, command, and scenario-generation flows.
- Create: `backend/src/lib/prompts/scenario-generator.ts`  
  Build platform-aware scenario-generation prompts instead of keeping the prompt inline in the route.
- Modify: `backend/src/lib/prompts/system.ts`
- Modify: `backend/src/lib/prompts/command.ts`
- Modify: `backend/src/lib/mock-ai.ts`
- Modify: `backend/src/lib/scenario-validation.ts`
- Modify: `backend/src/lib/session-scenario.ts`
- Modify: `backend/src/routes/scenario.ts`
- Modify: `backend/src/routes/chat.ts`
- Modify: `backend/src/routes/command.ts`
- Modify: `backend/src/routes/scores.ts`
- Modify: `backend/src/routes/gameplay.ts`
- Modify: `backend/src/index.ts`
- Modify: `backend/src/lib/storage/types.ts`
- Modify: `backend/src/lib/storage/json-session-store.ts`
- Modify: `backend/src/lib/storage/json-leaderboard-store.ts`
- Modify: `backend/src/lib/storage/json-metrics-store.ts`
- Modify: `backend/src/lib/storage/mssql-session-store.ts`
- Modify: `backend/src/lib/storage/mssql-leaderboard-store.ts`
- Modify: `backend/src/lib/storage/mssql-metrics-store.ts`
- Create: `backend/src/lib/storage/migrations/006_platform_dimension.sql`

### Repo-owned scenario and knowledge assets

- Create: `scenarios/aro-classic/easy/master-node-deleted.json`
- Create: `scenarios/aro-classic/medium/mco-permissions-drift.json`
- Create: `scenarios/aro-classic/hard/etcd-quorum-loss.json`
- Create: `scenarios/aro-hcp/easy/guest-router-503-networkpolicy.json`
- Create: `scenarios/aro-hcp/medium/nodepool-config-drift.json`
- Create: `scenarios/aro-hcp/hard/guest-cluster-upgrade-boundary-stall.json`
- Create: `scenarios/aks/easy/image-pull-backoff.json`
- Create: `scenarios/aks/medium/coredns-egress-break.json`
- Create: `scenarios/aks/hard/nodepool-upgrade-pdb-deadlock.json`
- Create: `knowledge_base/platforms/aro-classic/platform-operations.md`
- Create: `knowledge_base/platforms/aro-hcp/platform-operations.md`
- Create: `knowledge_base/platforms/aks/platform-operations.md`

### Frontend platform flow and filtering

- Create: `frontend/src/components/home/PlatformSelector.tsx`
- Modify: `frontend/src/app/page.tsx`
- Modify: `frontend/src/components/home/DifficultyGrid.tsx`
- Modify: `frontend/src/app/game/page.tsx`
- Modify: `frontend/src/app/leaderboard/page.tsx`
- Modify: `frontend/src/app/admin/page.tsx`
- Modify: `frontend/src/app/about/page.tsx`
- Modify: `frontend/src/components/chat/ChatMessage.tsx`
- Modify: `frontend/src/components/shared/CodeBlock.tsx`
- Modify: `frontend/src/components/terminal/CommandBlock.tsx`
- Modify: `frontend/src/components/dashboard/DashboardPanel.tsx`
- Modify: `frontend/src/stores/gameStore.ts`
- Modify: `frontend/src/lib/auth/scenario-request.ts`
- Modify: `frontend/src/lib/gameplayTelemetry.ts`
- Modify: `frontend/src/hooks/useChat.ts`
- Modify: `frontend/src/hooks/useCommand.ts`

### Tests

- Create: `backend/src/lib/platform-profiles.test.ts`
- Create: `backend/src/lib/prompts/scenario-generator.test.ts`
- Create: `backend/src/integration/platform-session-flows.test.ts`
- Create: `frontend/src/components/home/PlatformSelector.test.tsx`
- Modify: `backend/src/lib/scenario-catalog.test.ts`
- Modify: `backend/src/lib/knowledge.test.ts`
- Modify: `backend/src/lib/prompts/system.test.ts`
- Modify: `backend/src/lib/prompts/command.test.ts`
- Modify: `backend/src/lib/mock-ai.test.ts`
- Modify: `backend/src/lib/storage/mssql-stores.test.ts`
- Modify: `backend/src/lib/storage/json-leaderboard-store.test.ts`
- Modify: `backend/src/routes/scenario.test.ts`
- Modify: `backend/src/routes/command.test.ts`
- Modify: `backend/src/routes/chat.test.ts`
- Modify: `backend/src/routes/scores.test.ts`
- Modify: `backend/src/routes/gameplay.test.ts`
- Modify: `backend/src/integration/helpers.ts`
- Modify: `backend/src/integration/helpers.test.ts`
- Modify: `backend/src/integration/game-flow.test.ts`
- Modify: `backend/src/integration/concurrent-sessions.test.ts`
- Modify: `frontend/src/lib/auth/scenario-request.test.ts`
- Modify: `frontend/src/stores/gameStore.test.ts`
- Modify: `frontend/src/hooks/useCommand.test.tsx`

### Documentation and repo boundary

- Create: `docs/CONTENT_BOUNDARY.md`
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/AI_RUNTIME.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `backend/.env.local.example`

---

### Task 1: Establish shared platform contracts

**Files:**

- Create: `shared/types/platform.ts`
- Modify: `shared/types/game.ts`
- Modify: `shared/types/chat.ts`
- Modify: `shared/types/terminal.ts`
- Modify: `shared/types/gameplay.ts`
- Modify: `shared/types/leaderboard.ts`
- Create: `backend/src/lib/platform-profiles.ts`
- Test: `backend/src/lib/platform-profiles.test.ts`

**Interfaces:**

- Consumes: existing `Difficulty`, `Scenario`, `GameplayTelemetryEvent`, `LeaderboardEntry`, and terminal/chat command unions.
- Produces:
  - `export type PlatformId = "aro-classic" | "aro-hcp" | "aks";`
  - `export type PrimaryClusterCli = "oc" | "kubectl";`
  - `export type ExecutableCommandType = PrimaryClusterCli | "kql";`
  - `export type CompatibleCommandType = ExecutableCommandType | "geneva";`
  - `export interface PlatformContext { machineNames?: string[]; routeNames?: string[]; clusterOperatorHints?: string[]; guestClusterName?: string; hostedControlPlaneNamespace?: string; controlPlaneBoundaryNotes?: string[]; nodePoolNames?: string[]; managedResourceGroupHint?: string; addonContext?: string[]; }`
  - `export interface PlatformProfile { id: PlatformId; label: string; description: string; primaryCli: PrimaryClusterCli; secondarySurfaces: readonly ["kql", "dashboard"]; }`
  - `export const DEFAULT_PLATFORM_ID: PlatformId = "aro-classic";`
  - `getRuntimePlatformProfile(platform: PlatformId): RuntimePlatformProfile`
  - `isCommandTypeAllowedForPlatform(platform: PlatformId, type: CompatibleCommandType): boolean`
  - `Scenario.platform: PlatformId`
  - `Scenario.platformContext?: PlatformContext`
  - `GameplayTelemetryEvent.platform: PlatformId`
  - `LeaderboardEntry.platform: PlatformId`

- [ ] **Step 1: Write the failing platform-registry unit test**

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_PLATFORM_ID, PLATFORM_PROFILES } from "../../../shared/types/platform";
import { isCommandTypeAllowedForPlatform } from "./platform-profiles";

describe("platform profiles", () => {
  it("maps each gameplay platform to the expected primary CLI", () => {
    expect(DEFAULT_PLATFORM_ID).toBe("aro-classic");
    expect(PLATFORM_PROFILES["aro-classic"].primaryCli).toBe("oc");
    expect(PLATFORM_PROFILES["aro-hcp"].primaryCli).toBe("oc");
    expect(PLATFORM_PROFILES["aks"].primaryCli).toBe("kubectl");
  });

  it("rejects mismatched cluster CLIs while allowing kql everywhere", () => {
    expect(isCommandTypeAllowedForPlatform("aro-classic", "oc")).toBe(true);
    expect(isCommandTypeAllowedForPlatform("aro-classic", "kubectl")).toBe(false);
    expect(isCommandTypeAllowedForPlatform("aks", "kubectl")).toBe(true);
    expect(isCommandTypeAllowedForPlatform("aks", "kql")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the new test to confirm the missing platform contract**

Run: `npm --prefix backend run test -- src/lib/platform-profiles.test.ts`

Expected: FAIL because `shared/types/platform.ts` and `backend/src/lib/platform-profiles.ts` do not exist yet.

- [ ] **Step 3: Add the shared platform contract file**

```ts
export type PlatformId = "aro-classic" | "aro-hcp" | "aks";
export type PrimaryClusterCli = "oc" | "kubectl";
export type ExecutableCommandType = PrimaryClusterCli | "kql";
export type CompatibleCommandType = ExecutableCommandType | "geneva";

export interface PlatformContext {
  machineNames?: string[];
  routeNames?: string[];
  clusterOperatorHints?: string[];
  guestClusterName?: string;
  hostedControlPlaneNamespace?: string;
  controlPlaneBoundaryNotes?: string[];
  nodePoolNames?: string[];
  managedResourceGroupHint?: string;
  addonContext?: string[];
}

export interface PlatformProfile {
  id: PlatformId;
  label: string;
  description: string;
  primaryCli: PrimaryClusterCli;
  secondarySurfaces: readonly ["kql", "dashboard"];
}

export const DEFAULT_PLATFORM_ID: PlatformId = "aro-classic";
export const PLATFORM_IDS: readonly PlatformId[] = ["aro-classic", "aro-hcp", "aks"];

export const PLATFORM_PROFILES: Record<PlatformId, PlatformProfile> = {
  "aro-classic": {
    id: "aro-classic",
    label: "ARO Classic",
    description: "Classic Azure Red Hat OpenShift cluster operations.",
    primaryCli: "oc",
    secondarySurfaces: ["kql", "dashboard"],
  },
  "aro-hcp": {
    id: "aro-hcp",
    label: "ARO HCP",
    description: "Hosted control plane investigations with guest-cluster boundaries.",
    primaryCli: "oc",
    secondarySurfaces: ["kql", "dashboard"],
  },
  "aks": {
    id: "aks",
    label: "AKS",
    description: "Azure Kubernetes Service investigations with node-pool terminology.",
    primaryCli: "kubectl",
    secondarySurfaces: ["kql", "dashboard"],
  },
};
```

- [ ] **Step 4: Thread the new contract into shared models and backend runtime helpers**

```ts
export interface Scenario {
  id: string;
  platform: PlatformId;
  title: string;
  difficulty: Difficulty;
  description: string;
  incidentTicket: IncidentTicket;
  clusterContext: ClusterContext;
  platformContext?: PlatformContext;
}

export interface RuntimePlatformProfile extends PlatformProfile {
  knowledgeFiles: readonly string[];
  allowedCommandTypes: readonly CompatibleCommandType[];
}

export function isCommandTypeAllowedForPlatform(
  platform: PlatformId,
  type: CompatibleCommandType,
): boolean {
  const profile = RUNTIME_PLATFORM_PROFILES[platform];
  return profile.allowedCommandTypes.includes(type);
}
```

- [ ] **Step 5: Re-run the shared contract test**

Run: `npm --prefix backend run test -- src/lib/platform-profiles.test.ts`

Expected: PASS with `aro-classic` and `aro-hcp` resolving to `oc`, `aks` resolving to `kubectl`, and `kubectl` rejected for ARO sessions.

---

### Task 2: Persist platform in sessions, telemetry, and leaderboard storage

**Files:**

- Modify: `backend/src/lib/storage/types.ts`
- Modify: `backend/src/lib/storage/json-session-store.ts`
- Modify: `backend/src/lib/storage/json-leaderboard-store.ts`
- Modify: `backend/src/lib/storage/json-metrics-store.ts`
- Modify: `backend/src/lib/storage/mssql-session-store.ts`
- Modify: `backend/src/lib/storage/mssql-leaderboard-store.ts`
- Modify: `backend/src/lib/storage/mssql-metrics-store.ts`
- Create: `backend/src/lib/storage/migrations/006_platform_dimension.sql`
- Test: `backend/src/lib/storage/mssql-stores.test.ts`
- Test: `backend/src/lib/storage/json-leaderboard-store.test.ts`
- Test: `backend/src/routes/scores.test.ts`
- Test: `backend/src/routes/gameplay.test.ts`

**Interfaces:**

- Consumes: `PlatformId`, updated `Scenario`, updated `LeaderboardEntry`, updated `GameplayTelemetryEvent`.
- Produces:
  - `GameSession.platform: PlatformId`
  - `CreateGameSessionInput.platform: PlatformId`
  - `GameplayRecord.platform: PlatformId`
  - `ILeaderboardStore.getLeaderboard(filters?: { difficulty?: Difficulty; platform?: PlatformId }): Promise<LeaderboardEntry[]>`
  - `ILeaderboardStore.getHallOfFame(platform: PlatformId): Promise<HallOfFameEntry[]>`
  - `IMetricsStore.getGameplayAnalytics(filters?: { platform?: PlatformId }): Promise<GameplayAnalytics>`

- [ ] **Step 1: Write the failing storage tests for platform persistence and filtering**

```ts
it("create() stores platform on a session row", async () => {
  await store.create({
    platform: "aks",
    difficulty: "easy",
    scenarioTitle: "AKS ImagePullBackOff",
    identityKind: "github",
    githubUserId: "12345",
    githubLogin: "octocat",
    anonymousClaimKey: null,
    persistentScoreEligible: true,
  });

  expect(req.input).toHaveBeenCalledWith("platform", "aks");
});

it("keeps separate persistent leaderboard rows per platform", async () => {
  await store.addEntry({ ...baseEntry, id: "aro-entry", platform: "aro-classic", difficulty: "easy" });
  await store.addEntry({ ...baseEntry, id: "aks-entry", platform: "aks", difficulty: "easy" });

  expect((await store.getLeaderboard({ platform: "aro-classic", difficulty: "easy" }))).toHaveLength(1);
  expect((await store.getLeaderboard({ platform: "aks", difficulty: "easy" }))).toHaveLength(1);
});

it("records platform on gameplay telemetry and returns platform-filtered analytics", async () => {
  await getMetricsStore().recordGameplay({
    sessionToken: token,
    platform: "aro-hcp",
    lifecycleState: "completed",
    difficulty: "medium",
    scenarioTitle: "NodePool Config Drift",
  });

  const analytics = await getMetricsStore().getGameplayAnalytics({ platform: "aro-hcp" });
  expect(analytics.byPlatform[0]?.platform).toBe("aro-hcp");
  expect(analytics.recentSessions[0]?.platform).toBe("aro-hcp");
});
```

- [ ] **Step 2: Run the focused storage tests**

Run: `npm --prefix backend run test -- src/lib/storage/mssql-stores.test.ts src/lib/storage/json-leaderboard-store.test.ts src/routes/scores.test.ts src/routes/gameplay.test.ts`

Expected: FAIL because the storage interfaces, JSON implementations, SQL queries, and route expectations do not include `platform` yet.

- [ ] **Step 3: Add `platform` to storage contracts and in-memory implementations**

```ts
export interface GameSession {
  token: string;
  platform: PlatformId;
  difficulty: Difficulty;
  scenarioId: string | null;
  scenarioTitle: string;
  scenarioPayload: string | null;
  startTime: number;
  used: boolean;
  trafficSource: TrafficSource;
  identityKind: SessionIdentityKind;
  githubUserId: string | null;
  githubLogin: string | null;
  anonymousClaimKey: string | null;
  persistentScoreEligible: boolean;
}

export interface CreateGameSessionInput {
  platform: PlatformId;
  difficulty: Difficulty;
  scenarioId?: string | null;
  scenarioTitle: string;
  scenarioPayload?: string | null;
  trafficSource?: TrafficSource;
  identityKind: SessionIdentityKind;
  githubUserId?: string | null;
  githubLogin?: string | null;
  anonymousClaimKey?: string | null;
  persistentScoreEligible: boolean;
}

sessions.set(token, {
  token,
  platform: input.platform,
  difficulty: input.difficulty,
  scenarioId: input.scenarioId ?? null,
  scenarioTitle: input.scenarioTitle,
  scenarioPayload: input.scenarioPayload ?? null,
  startTime: Date.now(),
  used: false,
  trafficSource: input.trafficSource ?? "player",
  identityKind: input.identityKind,
  githubUserId: input.githubUserId ?? null,
  githubLogin: input.githubLogin ?? null,
  anonymousClaimKey: input.anonymousClaimKey ?? null,
  persistentScoreEligible: input.persistentScoreEligible,
});
```

- [ ] **Step 4: Add the SQL migration and platform-aware SQL queries**

```sql
IF COL_LENGTH('sessions', 'platform') IS NULL
BEGIN
  ALTER TABLE sessions ADD platform VARCHAR(16) NOT NULL
    CONSTRAINT df_sessions_platform DEFAULT 'aro-classic';
END;

IF COL_LENGTH('gameplay_metrics', 'platform') IS NULL
BEGIN
  ALTER TABLE gameplay_metrics ADD platform VARCHAR(16) NOT NULL
    CONSTRAINT df_gameplay_metrics_platform DEFAULT 'aro-classic';
END;

IF COL_LENGTH('leaderboard_entries', 'platform') IS NULL
BEGIN
  ALTER TABLE leaderboard_entries ADD platform VARCHAR(16) NOT NULL
    CONSTRAINT df_leaderboard_entries_platform DEFAULT 'aro-classic';
END;

UPDATE sessions SET platform = 'aro-classic' WHERE platform IS NULL;
UPDATE gameplay_metrics SET platform = 'aro-classic' WHERE platform IS NULL;
UPDATE leaderboard_entries SET platform = 'aro-classic' WHERE platform IS NULL;

IF EXISTS (
  SELECT * FROM sys.indexes
  WHERE name = 'ux_leaderboard_entries_github_difficulty'
    AND object_id = OBJECT_ID('leaderboard_entries')
)
  DROP INDEX ux_leaderboard_entries_github_difficulty ON leaderboard_entries;

CREATE UNIQUE INDEX ux_leaderboard_entries_github_platform_difficulty_traffic
ON leaderboard_entries (github_user_id, platform, difficulty, traffic_source)
WHERE github_user_id IS NOT NULL;
```

- [ ] **Step 5: Re-run the storage and route tests**

Run: `npm --prefix backend run test -- src/lib/storage/mssql-stores.test.ts src/lib/storage/json-leaderboard-store.test.ts src/routes/scores.test.ts src/routes/gameplay.test.ts`

Expected: PASS with session creation, gameplay writes, platform-filtered leaderboard reads, and platform-aware analytics all using the stored `platform` field.

---

### Task 3: Build the repo-owned multi-platform catalog and knowledge bundle layout

**Files:**

- Modify: `backend/src/lib/scenario-catalog.ts`
- Modify: `backend/src/lib/knowledge.ts`
- Modify: `backend/src/index.ts`
- Create: `scenarios/aro-classic/easy/master-node-deleted.json`
- Create: `scenarios/aro-classic/medium/mco-permissions-drift.json`
- Create: `scenarios/aro-classic/hard/etcd-quorum-loss.json`
- Create: `scenarios/aro-hcp/easy/guest-router-503-networkpolicy.json`
- Create: `scenarios/aro-hcp/medium/nodepool-config-drift.json`
- Create: `scenarios/aro-hcp/hard/guest-cluster-upgrade-boundary-stall.json`
- Create: `scenarios/aks/easy/image-pull-backoff.json`
- Create: `scenarios/aks/medium/coredns-egress-break.json`
- Create: `scenarios/aks/hard/nodepool-upgrade-pdb-deadlock.json`
- Create: `knowledge_base/platforms/aro-classic/platform-operations.md`
- Create: `knowledge_base/platforms/aro-hcp/platform-operations.md`
- Create: `knowledge_base/platforms/aks/platform-operations.md`
- Create: `docs/CONTENT_BOUNDARY.md`
- Test: `backend/src/lib/scenario-catalog.test.ts`
- Test: `backend/src/lib/knowledge.test.ts`

**Interfaces:**

- Consumes: `PlatformId`, `Difficulty`, `Scenario`, `RuntimePlatformProfile`.
- Produces:
  - `type ScenarioCatalogIndex = Record<PlatformId, Record<Difficulty, Scenario[]>>`
  - `getCatalogScenario(input: { platform: PlatformId; difficulty: Difficulty; scenarioId?: string }): Promise<Scenario>`
  - `assertCatalogCoverage(): Promise<void>`
  - `loadKnowledgeSections(platform: PlatformId): Promise<KBSection[]>`

- [ ] **Step 1: Write failing tests for platform-aware catalog reachability and knowledge composition**

```ts
it("loads scenarios from platform/difficulty directories instead of a single difficulty folder", async () => {
  const scenario = await getCatalogScenario({ platform: "aks", difficulty: "easy" });
  expect(scenario.platform).toBe("aks");
  expect(scenario.difficulty).toBe("easy");
});

it("fails startup validation when any supported platform/difficulty pair has zero catalog scenarios", async () => {
  await expect(assertCatalogCoverage()).rejects.toMatchObject({
    clientMessage: "Scenario catalog is invalid.",
  });
});

it("combines shared and platform-specific knowledge files for aks sessions", async () => {
  const sections = await loadKnowledgeSections("aks");
  const result = queryKnowledgeSections(sections, ["nodepool", "managed cluster"], 8000);
  expect(result).toContain("The Five Phases");
  expect(result).toContain("AKS");
});
```

- [ ] **Step 2: Run the catalog and knowledge tests**

Run: `npm --prefix backend run test -- src/lib/scenario-catalog.test.ts src/lib/knowledge.test.ts`

Expected: FAIL because the loader only indexes `scenarios/<difficulty>` and the knowledge loader only reads the shared OpenShift-heavy file list.

- [ ] **Step 3: Replace the catalog loader with a `(platform, difficulty)` index**

```ts
type ScenarioCatalogIndex = Record<PlatformId, Record<Difficulty, Scenario[]>>;

export async function getCatalogScenario(input: {
  platform: PlatformId;
  difficulty: Difficulty;
  scenarioId?: string;
}): Promise<Scenario> {
  const catalog = await loadCatalog();
  const candidates = catalog[input.platform][input.difficulty];

  if (candidates.length === 0) {
    throw unavailableCatalog(input.platform, input.difficulty);
  }

  if (input.scenarioId) {
    const exact = candidates.find((scenario) => scenario.id === input.scenarioId);
    if (!exact) {
      throw invalidCatalog(`No catalog scenario ${input.scenarioId} for ${input.platform}/${input.difficulty}`);
    }
    return hydrateScenarioTemplate(exact);
  }

  const picked = candidates[Math.floor(Math.random() * candidates.length)];
  return hydrateScenarioTemplate(picked);
}

export async function assertCatalogCoverage(): Promise<void> {
  const catalog = await loadCatalog();
  for (const platform of PLATFORM_IDS) {
    for (const difficulty of DIFFICULTIES) {
      if (catalog[platform][difficulty].length === 0) {
        throw invalidCatalog(`Missing scenario coverage for ${platform}/${difficulty}`);
      }
    }
  }
}
```

- [ ] **Step 4: Add the minimum sanitized asset matrix and platform knowledge bundles**

```ts
const REQUIRED_SCENARIOS = [
  { path: "scenarios/aro-classic/easy/master-node-deleted.json", id: "aro-classic-easy-master-node-deleted", platform: "aro-classic", difficulty: "easy", title: "Master Node Deleted" },
  { path: "scenarios/aro-classic/medium/mco-permissions-drift.json", id: "aro-classic-medium-mco-permissions-drift", platform: "aro-classic", difficulty: "medium", title: "MCO Permissions Drift" },
  { path: "scenarios/aro-classic/hard/etcd-quorum-loss.json", id: "aro-classic-hard-etcd-quorum-loss", platform: "aro-classic", difficulty: "hard", title: "Etcd Quorum Loss" },
  { path: "scenarios/aro-hcp/easy/guest-router-503-networkpolicy.json", id: "aro-hcp-easy-guest-router-503-networkpolicy", platform: "aro-hcp", difficulty: "easy", title: "Guest Route 503" },
  { path: "scenarios/aro-hcp/medium/nodepool-config-drift.json", id: "aro-hcp-medium-nodepool-config-drift", platform: "aro-hcp", difficulty: "medium", title: "NodePool Config Drift" },
  { path: "scenarios/aro-hcp/hard/guest-cluster-upgrade-boundary-stall.json", id: "aro-hcp-hard-guest-cluster-upgrade-boundary-stall", platform: "aro-hcp", difficulty: "hard", title: "Guest Cluster Upgrade Boundary Stall" },
  { path: "scenarios/aks/easy/image-pull-backoff.json", id: "aks-easy-image-pull-backoff", platform: "aks", difficulty: "easy", title: "ImagePullBackOff in AKS" },
  { path: "scenarios/aks/medium/coredns-egress-break.json", id: "aks-medium-coredns-egress-break", platform: "aks", difficulty: "medium", title: "CoreDNS Egress Break" },
  { path: "scenarios/aks/hard/nodepool-upgrade-pdb-deadlock.json", id: "aks-hard-nodepool-upgrade-pdb-deadlock", platform: "aks", difficulty: "hard", title: "NodePool Upgrade PDB Deadlock" },
] as const;

const PLATFORM_KB_FILES: Record<PlatformId, readonly string[]> = {
  "aro-classic": ["platforms/aro-classic/platform-operations.md"],
  "aro-hcp": ["platforms/aro-hcp/platform-operations.md"],
  "aks": ["platforms/aks/platform-operations.md"],
};
```

- [ ] **Step 5: Document the sanitized asset boundary**

```md
# Content Boundary

Runtime content in this repository may only depend on repo-owned, sanitized assets:

- `scenarios/**/*.json`
- `knowledge_base/**/*.md`
- static manifests committed in this repository

Runtime content may not depend on:

- `aro-ai-tools`
- git submodules
- MCP lookups
- remote authoring identifiers
- build-time sync scripts that are required for the simulator to start

All imported incident material must remove customer names, secrets, internal URLs, and non-public incident identifiers before it is committed here.
```

- [ ] **Step 6: Re-run catalog and knowledge tests**

Run: `npm --prefix backend run test -- src/lib/scenario-catalog.test.ts src/lib/knowledge.test.ts`

Expected: PASS with deterministic platform/difficulty lookup, startup coverage validation, and shared-plus-platform knowledge loading.

---

### Task 4: Make scenario, chat, command, and mock runtime paths platform-aware

**Files:**

- Create: `backend/src/lib/prompts/platform.ts`
- Create: `backend/src/lib/prompts/scenario-generator.ts`
- Modify: `backend/src/lib/prompts/system.ts`
- Modify: `backend/src/lib/prompts/command.ts`
- Modify: `backend/src/lib/mock-ai.ts`
- Modify: `backend/src/lib/scenario-validation.ts`
- Modify: `backend/src/lib/session-scenario.ts`
- Modify: `backend/src/routes/scenario.ts`
- Modify: `backend/src/routes/chat.ts`
- Modify: `backend/src/routes/command.ts`
- Test: `backend/src/lib/prompts/system.test.ts`
- Test: `backend/src/lib/prompts/command.test.ts`
- Test: `backend/src/lib/prompts/scenario-generator.test.ts`
- Test: `backend/src/lib/mock-ai.test.ts`
- Test: `backend/src/routes/scenario.test.ts`
- Test: `backend/src/routes/command.test.ts`
- Test: `backend/src/routes/chat.test.ts`

**Interfaces:**

- Consumes: `PlatformId`, `RuntimePlatformProfile`, platform-specific KB loader, session platform from storage.
- Produces:
  - `ScenarioRequestBody { platform: PlatformId; difficulty: Difficulty; turnstileToken?: string }`
  - `buildScenarioGenerationPrompt(input: { platform: PlatformId; difficulty: Difficulty; currentDate: string; scenarioContext: string }): string`
  - `buildSystemPrompt(knowledgeBase: string, scenario: Scenario | null, currentPhase: InvestigationPhase, profile: RuntimePlatformProfile): string`
  - `buildCommandSystemPrompt(type: CompatibleCommandType, scenarioContext: string, simNow: string, history?: CommandHistoryEntry[], profile?: RuntimePlatformProfile): string`
  - `generateMockScenario(difficulty: Difficulty, platform: PlatformId): Scenario`

- [ ] **Step 1: Write the failing runtime tests for platform-aware prompts and command validation**

```ts
it("requires scenario.platform to match the stored session platform", () => {
  const result = validateSessionScenario(
    {
      platform: "aro-hcp",
      scenarioPayload: JSON.stringify({ id: "s1", platform: "aks", title: "Wrong", difficulty: "easy" }),
      scenarioTitle: "Wrong",
      difficulty: "easy",
      scenarioId: "s1",
    },
    null,
  );

  expect(result).toEqual({
    ok: false,
    error: "Scenario does not match the active session",
  });
});

it("labels kubectl commands as Kubernetes CLI for aks", () => {
  const prompt = buildCommandSystemPrompt("kubectl", "ctx", "now", undefined, getRuntimePlatformProfile("aks"));
  expect(prompt).toContain("Kubernetes CLI (kubectl)");
});

it("rejects kubectl commands for aro-classic sessions", async () => {
  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toEqual({
    error: "Command type kubectl does not match platform aro-classic",
  });
});
```

- [ ] **Step 2: Run the backend prompt and route tests**

Run: `npm --prefix backend run test -- src/lib/prompts/system.test.ts src/lib/prompts/command.test.ts src/lib/prompts/scenario-generator.test.ts src/lib/mock-ai.test.ts src/routes/scenario.test.ts src/routes/command.test.ts src/routes/chat.test.ts`

Expected: FAIL because prompt builders are still ARO-only, the command route does not understand `kubectl`, and session validation does not compare `platform`.

- [ ] **Step 3: Move inline prompt text into explicit platform fragments**

```ts
export const PLATFORM_PROMPT_FRAGMENTS: Record<PlatformId, {
  systemIdentity: string;
  docsReferences: string;
  commandGuidance: string;
  scenarioGenerationGuidance: string;
}> = {
  "aro-classic": {
    systemIdentity: "You are the Dungeon Master of the SRE Simulator for classic Azure Red Hat OpenShift operations.",
    docsReferences: "Use ARO lifecycle, ARO policies, OpenShift docs, Red Hat KB, and runbooks.",
    commandGuidance: "Preferred cluster CLI: oc. Machine API and cluster operator language is valid.",
    scenarioGenerationGuidance: "Use classic ARO/OpenShift failure modes and version language.",
  },
  "aro-hcp": {
    systemIdentity: "You are the Dungeon Master of the SRE Simulator for Azure Red Hat OpenShift hosted control plane sessions.",
    docsReferences: "Use OpenShift guest-cluster documentation and hosted control plane boundary guidance.",
    commandGuidance: "Preferred cluster CLI: oc. Distinguish guest-cluster actions from management-plane responsibilities.",
    scenarioGenerationGuidance: "Keep hosted control plane ownership boundaries explicit.",
  },
  "aks": {
    systemIdentity: "You are the Dungeon Master of the SRE Simulator for Azure Kubernetes Service sessions.",
    docsReferences: "Use AKS documentation, Kubernetes docs, and Azure Monitor/KQL references.",
    commandGuidance: "Preferred cluster CLI: kubectl. Use node-pool terminology and managed control plane limits.",
    scenarioGenerationGuidance: "Use AKS-managed cluster language and node-pool-centric incident patterns.",
  },
};
```

- [ ] **Step 4: Update routes and mock paths to read the stored session platform**

```ts
interface ScenarioRequestBody {
  platform: PlatformId;
  difficulty: Difficulty;
  turnstileToken?: string;
}

const profile = getRuntimePlatformProfile(platform);
const catalogScenario = await getCatalogScenario({ platform, difficulty });

const sessionToken = await getSessionStore().create({
  platform,
  difficulty,
  scenarioId: scenario.id,
  scenarioTitle: scenario.title,
  scenarioPayload: JSON.stringify(scenario),
  trafficSource,
  identityKind: accessDecision.sessionIdentityKind,
  githubUserId: viewer?.githubUserId ?? null,
  githubLogin: viewer?.githubLogin ?? null,
  anonymousClaimKey: reservedClaimKeys[0] ?? null,
  persistentScoreEligible: accessDecision.sessionIdentityKind === "github",
});

if (!isCommandTypeAllowedForPlatform(session.platform, type)) {
  res.status(409).json({ error: `Command type ${type} does not match platform ${session.platform}` });
  return;
}
```

- [ ] **Step 5: Make mocks and knowledge composition platform-specific**

```ts
export function generateMockScenario(
  difficulty: Difficulty,
  platform: PlatformId,
): Scenario {
  const primaryCli = PLATFORM_PROFILES[platform].primaryCli;
  const clusterName =
    platform === "aks"
      ? `aks-${difficulty}-mock`
      : `${platform}-${difficulty}-mock`;

  return {
    id: `${platform}-scenario-mock-${difficulty}`,
    platform,
    title: `Mock ${platform} ${difficulty.toUpperCase()} scenario`,
    difficulty,
    description: `Mock ${platform} scenario used to validate ${primaryCli} platform flows.`,
    incidentTicket: {
      id: `IcM-MOCK-${platform.toUpperCase()}-${difficulty.toUpperCase()}`,
      severity: severityForDifficulty(difficulty),
      title: `Mock ${platform} incident`,
      description: `Platform-aware mock for ${platform}`,
      customerImpact: "No customer impact. This is a synthetic validation run.",
      reportedTime: utcDaysAgo(),
      clusterName,
      region: "westus3",
    },
    clusterContext: {
      name: clusterName,
      version: platform === "aks" ? "1.31.2" : "4.19.9",
      region: "westus3",
      nodeCount: difficulty === "easy" ? 6 : difficulty === "medium" ? 9 : 12,
      status: "Degraded (mock)",
      recentEvents: [`${utcOffsetMinutes(-25)} - ${primaryCli}: mock signal triggered`],
      alerts: [{ name: "MockPlatformAlert", severity: difficulty === "hard" ? "critical" : "warning", message: `Mock ${platform} alert`, firingTime: utcOffsetMinutes(-10) }],
      upgradeHistory: [],
    },
  };
}
```

- [ ] **Step 6: Re-run the prompt, mock, and route tests**

Run: `npm --prefix backend run test -- src/lib/prompts/system.test.ts src/lib/prompts/command.test.ts src/lib/prompts/scenario-generator.test.ts src/lib/mock-ai.test.ts src/routes/scenario.test.ts src/routes/command.test.ts src/routes/chat.test.ts`

Expected: PASS with `platform` validated end to end, `kubectl` accepted for AKS only, and prompt builders selecting the correct platform voice and command vocabulary.

---

### Task 5: Add platform-first frontend state and command UX

**Files:**

- Create: `frontend/src/components/home/PlatformSelector.tsx`
- Create: `frontend/src/components/home/PlatformSelector.test.tsx`
- Modify: `frontend/src/app/page.tsx`
- Modify: `frontend/src/components/home/DifficultyGrid.tsx`
- Modify: `frontend/src/app/game/page.tsx`
- Modify: `frontend/src/app/about/page.tsx`
- Modify: `frontend/src/components/chat/ChatMessage.tsx`
- Modify: `frontend/src/components/shared/CodeBlock.tsx`
- Modify: `frontend/src/components/terminal/CommandBlock.tsx`
- Modify: `frontend/src/components/dashboard/DashboardPanel.tsx`
- Modify: `frontend/src/stores/gameStore.ts`
- Modify: `frontend/src/lib/auth/scenario-request.ts`
- Modify: `frontend/src/lib/gameplayTelemetry.ts`
- Modify: `frontend/src/hooks/useCommand.ts`
- Test: `frontend/src/lib/auth/scenario-request.test.ts`
- Test: `frontend/src/stores/gameStore.test.ts`
- Test: `frontend/src/hooks/useCommand.test.tsx`
- Test: `frontend/src/components/home/PlatformSelector.test.tsx`

**Interfaces:**

- Consumes: `DEFAULT_PLATFORM_ID`, `PLATFORM_PROFILES`, `Scenario.platform`, `CompatibleCommandType`.
- Produces:
  - `GameState.selectedPlatform: PlatformId`
  - `setSelectedPlatform(platform: PlatformId): void`
  - `hydrateSelectedPlatform(): void`
  - `PlatformSelectorProps { value: PlatformId; onChange: (platform: PlatformId) => void }`
  - `buildScenarioRequestBody({ difficulty, platform, viewer, fingerprintHash, turnstileToken }): Record<string, unknown>`
  - Runnable markdown languages list includes `kubectl`

- [ ] **Step 1: Write the failing frontend tests for selected platform persistence and request bodies**

```ts
it("includes platform in scenario requests for both anonymous and GitHub viewers", () => {
  expect(
    buildScenarioRequestBody({
      platform: "aks",
      difficulty: "easy",
      viewer: null,
      fingerprintHash: "fp_hash",
      turnstileToken: "ts_token",
    }),
  ).toEqual({
    platform: "aks",
    difficulty: "easy",
    fingerprintHash: "fp_hash",
    turnstileToken: "ts_token",
  });
});

it("persists the selected platform in the game store", () => {
  useGameStore.getState().setSelectedPlatform("aro-hcp");
  expect(useGameStore.getState().selectedPlatform).toBe("aro-hcp");
});
```

- [ ] **Step 2: Run the focused frontend tests**

Run: `npm --prefix frontend run test -- src/lib/auth/scenario-request.test.ts src/stores/gameStore.test.ts src/hooks/useCommand.test.tsx src/components/home/PlatformSelector.test.tsx`

Expected: FAIL because the store has no `selectedPlatform`, the request body omits `platform`, and the UI does not render a platform selector or `kubectl` command type.

- [ ] **Step 3: Add selected-platform state and landing-page selector**

```ts
const PLATFORM_KEY = "sre-platform";

interface GameState {
  selectedPlatform: PlatformId;
  setSelectedPlatform: (platform: PlatformId) => void;
  hydrateSelectedPlatform: () => void;
}

setSelectedPlatform: (platform) => {
  globalThis.localStorage?.setItem(PLATFORM_KEY, platform);
  set({ selectedPlatform: platform });
},

hydrateSelectedPlatform: () => {
  const raw = globalThis.localStorage?.getItem(PLATFORM_KEY);
  if (raw === "aro-classic" || raw === "aro-hcp" || raw === "aks") {
    set({ selectedPlatform: raw });
  }
},

startGame: (scenario, sessionToken) =>
  set({
    selectedPlatform: scenario.platform,
    status: "playing",
    scenario,
    sessionToken,
    startTime: Date.now(),
    endTime: null,
    messages: [],
    currentPhase: "reading",
    phaseHistory: ["reading"],
    checkedDashboard: false,
    terminalEntries: [],
    commandCount: 0,
    isExecuting: false,
    score: { ...initialScore },
    scoringEvents: [],
    isStreaming: false,
  }),
```

- [ ] **Step 4: Send `platform` in scenario creation and telemetry payloads**

```ts
export function buildScenarioRequestBody(input: BuildScenarioRequestBodyInput): Record<string, unknown> {
  if (input.viewer?.kind === "github") {
    return {
      platform: input.platform,
      difficulty: input.difficulty,
    };
  }

  return {
    platform: input.platform,
    difficulty: input.difficulty,
    fingerprintHash: input.fingerprintHash,
    turnstileToken: input.turnstileToken,
  };
}

const payload: GameplayTelemetryEvent = {
  sessionToken: state.sessionToken,
  platform: state.scenario.platform,
  lifecycleState,
  nickname: state.nickname ?? undefined,
  commandCount: state.commandCount,
  commandsExecuted: state.terminalEntries.map((entry) => entry.command),
  scoringEvents: state.scoringEvents,
  chatMessageCount: state.messages.filter((message) => message.role === "user").length,
  durationMs,
  metadata: {
    currentPhase: state.currentPhase,
    phaseHistory: state.phaseHistory,
    checkedDashboard: state.checkedDashboard,
    scenarioId: state.scenario.id,
    scenarioTitle: state.scenario.title,
  },
};
```

- [ ] **Step 5: Add `kubectl` to runnable markdown and terminal rendering**

```ts
if (lang && ["oc", "kubectl", "kql", "geneva", "bash"].includes(lang)) {
  return <CodeBlock code={codeStr} language={lang} onRun={onRunCommand} />;
}

const LANGUAGE_LABELS: Record<string, string> = {
  oc: "OpenShift CLI",
  kubectl: "Kubernetes CLI",
  kql: "KQL Query",
  geneva: "Dashboard (legacy alias)",
  bash: "Bash",
};

const TYPE_COLORS: Record<string, string> = {
  oc: "text-emerald-400",
  kubectl: "text-cyan-400",
  kql: "text-blue-400",
  geneva: "text-purple-400",
};
```

- [ ] **Step 6: Update visible copy to platform-neutral wording**

```tsx
<p className="text-zinc-300 text-sm text-center mb-10 max-w-lg leading-relaxed">
  Select a platform, then a difficulty. The AI Dungeon Master will break the session,
  and your job is to investigate and fix it using the proper SRE methodology.
</p>

<p>
  <span className="text-zinc-200 font-semibold">SRE Simulator</span>{" "}
  is a break-fix training game for ARO Classic, ARO HCP, and AKS.
</p>
```

- [ ] **Step 7: Re-run the frontend tests**

Run: `npm --prefix frontend run test -- src/lib/auth/scenario-request.test.ts src/stores/gameStore.test.ts src/hooks/useCommand.test.tsx src/components/home/PlatformSelector.test.tsx`

Expected: PASS with persisted platform selection, `platform` included in `/api/scenario` requests, and `kubectl` rendered as a runnable command surface.

---

### Task 6: Add platform filters to leaderboard and admin analytics

**Files:**

- Modify: `backend/src/routes/scores.ts`
- Modify: `backend/src/routes/gameplay.ts`
- Modify: `frontend/src/app/leaderboard/page.tsx`
- Modify: `frontend/src/app/admin/page.tsx`
- Test: `backend/src/routes/scores.test.ts`
- Test: `backend/src/routes/gameplay.test.ts`

**Interfaces:**

- Consumes: platform-aware storage methods from Task 2, `DEFAULT_PLATFORM_ID`, updated shared analytics/leaderboard models.
- Produces:
  - `GET /api/scores?platform=aks&difficulty=easy`
  - `GET /api/gameplay/admin?platform=aro-hcp`
  - platform tabs on the leaderboard page
  - `all | PlatformId` filter on the admin page

- [ ] **Step 1: Write the failing route tests for platform query handling**

```ts
it("GET /api/scores filters to the requested gameplay platform", async () => {
  const response = await httpRequest(app, "GET", "/api/scores?platform=aks&difficulty=easy");
  expect(response.status).toBe(200);
  expect((response.body.entries as Array<{ platform: string }>).every((entry) => entry.platform === "aks")).toBe(true);
});

it("GET /api/gameplay/admin filters analytics by platform when requested", async () => {
  const response = await httpRequest(app, "GET", "/api/gameplay/admin?platform=aro-classic", undefined, {
    authorization: "Bearer gameplay-admin-secret",
  });

  expect(response.status).toBe(200);
  expect((response.body.recentSessions as Array<{ platform: string }>).every((entry) => entry.platform === "aro-classic")).toBe(true);
});
```

- [ ] **Step 2: Run the route tests**

Run: `npm --prefix backend run test -- src/routes/scores.test.ts src/routes/gameplay.test.ts`

Expected: FAIL because the routes do not parse `platform`, the storage methods do not accept platform filters, and analytics/leaderboard responses do not expose platform fields yet.

- [ ] **Step 3: Parse `platform` in the API routes and default the public leaderboard to one platform**

```ts
const platform = parsePlatformQuery(req.query.platform) ?? DEFAULT_PLATFORM_ID;
const entries = await leaderboard.getLeaderboard({ platform, difficulty });
const hallOfFame = await leaderboard.getHallOfFame(platform);

const analyticsPlatform = parsePlatformQuery(req.query.platform);
const analytics = await getMetricsStore().getGameplayAnalytics({ platform: analyticsPlatform });
res.json(analytics);
```

- [ ] **Step 4: Add platform filters to the leaderboard and admin pages**

```tsx
const PLATFORM_TABS: PlatformId[] = ["aro-classic", "aro-hcp", "aks"];
const [activePlatform, setActivePlatform] = useState<PlatformId>(DEFAULT_PLATFORM_ID);
const [activeDifficulty, setActiveDifficulty] = useState<"all" | Difficulty>("all");

const params = new URLSearchParams();
params.set("platform", activePlatform);
if (activeDifficulty !== "all") {
  params.set("difficulty", activeDifficulty);
}

const data = await fetchJsonObject(`/api/scores?${params.toString()}`, undefined, "Failed to load scores");
```

- [ ] **Step 5: Re-run the route tests**

Run: `npm --prefix backend run test -- src/routes/scores.test.ts src/routes/gameplay.test.ts`

Expected: PASS with platform-filtered leaderboard and analytics responses, plus `platform` surfaced on recent sessions and scenario breakdowns.

---

### Task 7: Update runtime docs and the repo boundary contract

**Files:**

- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/AI_RUNTIME.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `backend/.env.local.example`
- Modify: `docs/CONTENT_BOUNDARY.md`

**Interfaces:**

- Consumes: completed platform model, live e2e procedure, sanitized content/export-only boundary.
- Produces:
  - platform-first product docs
  - live e2e command sequence using the existing Azure route workflow
  - explicit statement that runtime does not depend on `aro-ai-tools`

- [ ] **Step 1: Update the top-level product flow and docs index**

```md
## How a session works

1. Choose a platform.
2. Choose a difficulty.
3. Investigate via chat, commands, and dashboard context.
4. Build and test hypotheses using observed evidence.
5. Apply the fix and review score quality and platform-specific guidance.

## Documentation

- Product architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Runtime internals: [docs/AI_RUNTIME.md](docs/AI_RUNTIME.md)
- Content boundary: [docs/CONTENT_BOUNDARY.md](docs/CONTENT_BOUNDARY.md)
- Setup and live verification: [docs/OPERATIONS.md](docs/OPERATIONS.md)
```

- [ ] **Step 2: Document the gameplay/hosting boundary and prompt composition**

```md
`PlatformId` is a gameplay dimension stored on each simulated session.
`CLUSTER_FLAVOR` remains a deployment dimension for where the simulator runs.
The simulator can be hosted on AKS while presenting `aro-classic`, `aro-hcp`, or `aks` gameplay content.

Prompt composition order:
1. Shared investigation methodology bundle
2. Shared simulator prompt fragments
3. Platform-specific knowledge bundles
4. Platform-specific prompt fragments
5. Scenario-specific context
```

- [ ] **Step 3: Document the live e2e platform-session procedure**

```md
### Live platform-session verification

1. Run `make e2e-azure-route`
2. Load local secrets into the shell without printing them:
   `set -a && . backend/.env.local && set +a`
3. Load the deployed route metadata:
   `. data/e2e-azure-route.env`
4. Run live integration tests against the deployed URL:
   `E2E_BACKEND_URL="$URL" E2E_AUTH_SESSION_SECRET="$AUTH_SESSION_SECRET" E2E_GAMEPLAY_ADMIN_TOKEN="$GAMEPLAY_ADMIN_TOKEN" make test-integration`
5. Keep the temporary namespace until reviewer signoff; later tear it down with:
   `NS="$NS" make e2e-azure-route-down`
```

- [ ] **Step 4: Update the local env example for platform-session verification**

```dotenv
AUTH_SESSION_SECRET=replace-with-long-random-session-secret
GAMEPLAY_ADMIN_TOKEN=replace-with-long-random-gameplay-admin-token
AUTOMATED_TRAFFIC_TOKEN=replace-with-long-random-automated-traffic-token
# Optional local/e2e bypass. When true, backend accepts any non-empty token.
# Keep false for production.
# TURNSTILE_TEST_MODE=true
```

- [ ] **Step 5: Re-read the docs pages and confirm the repo boundary is explicit**

Run: `npm --prefix backend run test -- src/lib/knowledge.test.ts`

Expected: PASS unchanged; the docs update does not affect runtime tests, and the content boundary document explicitly states that runtime never depends on `aro-ai-tools`.

---

### Task 8: Add integration and live e2e platform-session coverage

**Files:**

- Modify: `backend/src/integration/helpers.ts`
- Modify: `backend/src/integration/helpers.test.ts`
- Modify: `backend/src/integration/game-flow.test.ts`
- Modify: `backend/src/integration/concurrent-sessions.test.ts`
- Create: `backend/src/integration/platform-session-flows.test.ts`

**Interfaces:**

- Consumes: deployed frontend proxy URL, `AUTH_SESSION_SECRET`, `GAMEPLAY_ADMIN_TOKEN`, platform-aware scenario route, platform-aware score/admin responses.
- Produces:
  - `getViewerAuthCookie(): string | undefined`
  - `getGameplayAdminHeaders(): Record<string, string>`
  - `createScenarioSession(baseUrl: string, platform: PlatformId, difficulty: Difficulty): Promise<ScenarioResponse>`
  - `ensureExternalSessionTokens(baseUrl: string, count: number): Promise<string[]>`
  - deployed platform-session integration coverage for `aro-classic`, `aro-hcp`, and `aks`

- [ ] **Step 1: Write the failing helper and live-flow tests**

```ts
it("creates a viewer auth cookie from E2E_AUTH_SESSION_SECRET for external targets", () => {
  vi.stubEnv("E2E_BACKEND_URL", "https://example.test");
  vi.stubEnv("E2E_AUTH_SESSION_SECRET", "external-secret");
  expect(getViewerAuthCookie()).toContain("github");
});

it("runs one full easy session for each supported gameplay platform", async () => {
  for (const platform of ["aro-classic", "aro-hcp", "aks"] as const) {
    const scenario = await createScenarioSession(baseUrl, platform, "easy");
    expect(scenario.scenario.platform).toBe(platform);
  }
});
```

- [ ] **Step 2: Run the integration tests locally to confirm the missing helper behavior**

Run: `npm --prefix backend run test:integration -- src/integration/helpers.test.ts src/integration/concurrent-sessions.test.ts src/integration/platform-session-flows.test.ts`

Expected: FAIL because the integration helpers do not know how to mint an external GitHub viewer cookie or pass an admin token, and there is no platform-session live flow test yet.

- [ ] **Step 3: Add external auth-cookie and admin-header helpers**

```ts
export function getViewerAuthCookie(): string | undefined {
  const secret = (process.env.E2E_AUTH_SESSION_SECRET ?? process.env.AUTH_SESSION_SECRET ?? "").trim();
  if (!secret) {
    return undefined;
  }

  return `${VIEWER_SESSION_COOKIE}=${createViewerSessionToken(
    {
      kind: "github",
      githubUserId: "e2e-platform-user",
      githubLogin: "e2e-platform-user",
      displayName: "E2E Platform User",
      avatarUrl: null,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 5 * 60 * 1000,
    },
    secret,
  )}`;
}

export function getGameplayAdminHeaders(): Record<string, string> {
  const token = (process.env.E2E_GAMEPLAY_ADMIN_TOKEN ?? process.env.GAMEPLAY_ADMIN_TOKEN ?? "").trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}

export async function createScenarioSession(
  baseUrl: string,
  platform: PlatformId,
  difficulty: Difficulty,
): Promise<ScenarioResponse> {
  const cookie = getViewerAuthCookie();
  const response = await fetch(`${baseUrl}/api/scenario`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ platform, difficulty }),
  });

  if (!response.ok) {
    throw new Error(`Scenario bootstrap failed (${response.status})`);
  }

  return (await response.json()) as ScenarioResponse;
}

export async function ensureExternalSessionTokens(
  baseUrl: string,
  count: number,
): Promise<string[]> {
  const sessions = await Promise.all(
    Array.from({ length: count }, () =>
      createScenarioSession(baseUrl, "aro-classic", "easy"),
    ),
  );

  return sessions.map((session) => session.sessionToken);
}
```

- [ ] **Step 4: Add a dedicated deployed platform-session integration test**

```ts
for (const platform of ["aro-classic", "aro-hcp", "aks"] as const) {
  const cliType = platform === "aks" ? "kubectl" : "oc";
  const cliCommand = platform === "aks" ? "kubectl get nodes" : "oc get nodes";

  const scenarioResponse = await createScenarioSession(baseUrl, platform, "easy");
  expect(scenarioResponse.scenario.platform).toBe(platform);

  const commandResponse = await fetch(`${baseUrl}/api/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionToken: scenarioResponse.sessionToken,
      command: cliCommand,
      type: cliType,
      scenario: scenarioResponse.scenario,
    }),
  });
  expect(commandResponse.status).toBe(200);

  const telemetryResponse = await fetch(`${baseUrl}/api/gameplay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionToken: scenarioResponse.sessionToken,
      platform,
      lifecycleState: "completed",
      nickname: `e2e-${platform}`,
      commandCount: 1,
      chatMessageCount: 1,
      durationMs: 1000,
      scoringEvents: [],
    }),
  });
  expect(telemetryResponse.status).toBe(202);

  const scoreResponse = await fetch(`${baseUrl}/api/scores`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(getViewerAuthCookie() ? { cookie: getViewerAuthCookie() } : {}),
    },
    body: JSON.stringify({
      sessionToken: scenarioResponse.sessionToken,
      nickname: `e2e-${platform}`,
    }),
  });
  expect([200, 201]).toContain(scoreResponse.status);

  const analyticsResponse = await fetch(`${baseUrl}/api/gameplay/admin?platform=${platform}`, {
    headers: getGameplayAdminHeaders(),
  });
  expect(analyticsResponse.status).toBe(200);
}
```

- [ ] **Step 5: Update the external concurrent-session suite to self-bootstrap tokens**

```ts
beforeAll(async () => {
  if (isExternalTarget()) {
    chatSessionTokens = await ensureExternalSessionTokens(getBackendUrl(), 24);
    baseUrl = getBackendUrl();
    return;
  }

  const app = await createLocalApp(false);
  const result = await startLocalServer(app);
  baseUrl = result.url;
  localServer = result.server;
  const { getSessionStore } = await import("../lib/storage");
  const sessionStore = getSessionStore();
  chatSessionTokens = await Promise.all(
    Array.from({ length: 24 }, (_, index) =>
      sessionStore.create({
        platform: "aro-classic",
        difficulty: "easy",
        scenarioTitle: `Concurrent Chat ${index + 1}`,
        identityKind: "github",
        githubUserId: `local-${index + 1}`,
        githubLogin: `local-${index + 1}`,
        anonymousClaimKey: null,
        persistentScoreEligible: true,
      }),
    ),
  );
});
```

- [ ] **Step 6: Re-run the integration tests locally**

Run: `npm --prefix backend run test:integration -- src/integration/helpers.test.ts src/integration/concurrent-sessions.test.ts src/integration/platform-session-flows.test.ts`

Expected: PASS locally with mock mode, proving the new integration harness can create platform sessions, submit scores, and read platform-filtered analytics.

- [ ] **Step 7: Run the repository gates and the real deployed e2e flow**

Run: `make validate`

Expected: PASS

Run: `make test`

Expected: PASS

Run: `make test-integration`

Expected: PASS against the local mock/in-process integration suites, including `platform-session-flows.test.ts`.

Run: `make e2e-azure-route`

Expected: PASS with `Probe status: 200` and a populated `data/e2e-azure-route.env`.

Run: `set -a && . backend/.env.local && set +a && . data/e2e-azure-route.env && E2E_BACKEND_URL="$URL" E2E_AUTH_SESSION_SECRET="$AUTH_SESSION_SECRET" E2E_GAMEPLAY_ADMIN_TOKEN="$GAMEPLAY_ADMIN_TOKEN" make test-integration`

Expected: PASS against the deployed temporary route, with `concurrent-sessions.test.ts` self-bootstrapping its session tokens and `platform-session-flows.test.ts` proving `aro-classic`, `aro-hcp`, and `aks` sessions can each start, emit the correct command surface, submit telemetry, submit a score, and appear in platform-filtered analytics.

- [ ] **Step 8: Confirm the worktree branch is ready for review**

Run: `git status --short`

Expected: only task-related files are modified, the branch remains inside `C:\Users\b-aaffinito\DEV\SRESimulator\.worktrees\platform-multi-path-sessions`, and the implementation is ready for commit and PR work after the user approves execution.
