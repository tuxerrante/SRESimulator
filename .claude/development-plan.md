# Development Plan

Incremental feature roadmap for the SRE Simulator.

---

## Feature 1: Terminal loading indicator [DONE]

**Problem:** Pressing "Run" on a command (especially Geneva) takes ~10 seconds with no feedback — the app looks frozen.

**Solution:** Moved `isExecuting` state from the `useCommand` hook into the Zustand store. `TerminalPanel` subscribes to it and shows a spinning `Loader2` icon with "Simulating command execution..." at the bottom of the terminal while the `/api/command` response is pending.

**Files changed:** `stores/gameStore.ts`, `hooks/useCommand.ts`, `components/terminal/TerminalPanel.tsx`

---

## Feature 2: Leaderboard / Hall of Fame

**Goal:** Store the top 10 scores per difficulty level, plus an aggregated "Hall of Fame" showing the best overall. Top 3 get trophy icons (gold, silver, bronze). Ranking considers both score and time-to-resolution.

**Design decisions needed:**

- For local-only (current): SQLite via `better-sqlite3` or a simple JSON file
- For OpenShift deployment (Feature 5): Azure PostgreSQL or Cosmos DB
- Nickname prompt at game end (before submitting score)
- New API routes: `POST /api/scores` (submit), `GET /api/scores?difficulty=easy` (leaderboard)
- New page or modal: `/leaderboard` or overlay accessible from landing page

---

## Feature 3: Score change animation [DONE]

**Problem:** Score updates were silent — the user couldn't tell when points were awarded or deducted.

**Solution:** When new `scoringEvents` arrive, a floating `+N` or `-N` badge appears above the score in the header, drifts upward, and fades out over 1.5 seconds. Green for bonuses, red for penalties. Multiple events stack if they arrive simultaneously.

**Files changed:** `components/layout/Header.tsx`, `app/globals.css`

---

## Feature 3b: Command rate limiting [DONE]

**Problem:** Players can spam "Run" on commands, overloading the backend with Claude API calls.

**Solution:** Each suggested command can only be run once. After clicking "Run", the button permanently changes to a greyed-out "Ran" with a checkmark icon. The global `isExecuting` flag still prevents running two commands simultaneously.

**Rationale:** Per-command (not time-based) limiting is more natural — the Dungeon Master suggests specific commands, and running each once is realistic SRE behavior. Combined with the existing progressive efficiency penalty (after 5+ commands), this discourages spam without frustrating thoughtful investigation.

**Files changed:** `components/shared/CodeBlock.tsx`, `hooks/useCommand.ts`, `stores/gameStore.ts`, `components/terminal/TerminalPanel.tsx`

---

## Feature 4: Update knowledge base to current ARO versions [DONE]

**Context (as of Feb 2026):**

| Version | Status | EOL (Stable) | EOL (EUS) |
|---------|--------|--------------|-----------|
| 4.15 | **EOL** | Aug 2025 | N/A |
| 4.16 | EUS only | Dec 2025 | Jun 2026 |
| 4.17 | Supported | Apr 2026 | N/A |
| 4.18 | Supported | Aug 2026 | Feb 2027 |
| 4.19 | Supported | Dec 2026 | N/A |
| 4.20 | Supported | Apr 2027 | Oct 2027 |

Source: <https://learn.microsoft.com/en-us/azure/openshift/support-lifecycle#azure-red-hat-openshift-release-calendar>

**Changes made:**

- Added official documentation reference links (ARO lifecycle, support policies, OpenShift docs, Red Hat KB) to both knowledge base files
- Updated all doc links from old versions (4.8, 4.9, 4.10, 4.11, 4.12) to 4.18
- Updated version-specific entries: generalized illustrative version numbers to `4.x` with historical notes (e.g., `4.12.54` → `4.x (any version; originally observed on 4.12)`)
- Marked fixed bugs with resolution versions (e.g., `4.14 (fixed in 4.14.39+)`)
- Updated CRI-O/kubelet dependency bug note as fixed in 4.16+
- Updated accelerated networking version notes with CPMSO context
- Updated OKD migration doc link from `4.15` to `latest`
- Added ARO support lifecycle table to the Dungeon Master system prompt (`lib/prompts/system.ts`) with EOL version guidance
- Added "Documentation References" section to system prompt — AI now cites official docs (Red Hat Solutions, OpenShift docs, runbooks) in responses to encourage learning
- Scenario generation prompt (`api/scenario/route.ts`) was already updated in a prior session with `4.16–4.20` guidance

**Files changed:** `knowledge_base/Openshift-clusters-alerts-resolutions.md`, `knowledge_base/Community-reported-issues.md`, `frontend/src/lib/prompts/system.ts`

---

## Feature 5: OpenShift deployment & backend separation

**Goal:** Deploy on OpenShift with persistent storage so SREs can compete over time.

**Architecture:**

- **Frontend container:** Next.js static build served by nginx or Node
- **Backend container:** Rewrite API routes in Go for a standalone backend service
  - Handles Claude API calls, command simulation, score storage
  - Connects to database
- **Database:** Azure PostgreSQL or Cosmos DB (or Azure Storage Account)
  - Accessible **only** from the backend container (ClusterIP service + NetworkPolicy)
  - No public endpoint
- **DB connection pooler:** PgBouncer sidecar or separate container (if PostgreSQL)

**Deployment artifacts needed:**

- Dockerfiles for frontend and backend
- OpenShift manifests (Deployment, Service, Route, NetworkPolicy, Secret)
- Helm chart or Kustomize overlay for environment-specific config
- CI/CD pipeline (GitHub Actions -> build images -> push to ACR -> deploy)

**Considerations:**

- Backend Go rewrite is significant — scope as a separate phase
- Start with Next.js API routes containerized as-is, then extract to Go
- Environment variables for DB connection string, Claude credentials
