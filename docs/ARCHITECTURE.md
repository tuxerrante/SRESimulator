# Architecture & Game Design

> AI provider integration, token management, and context compaction are
> documented in [AI_RUNTIME.md](AI_RUNTIME.md).

## Tech Stack

- **Framework:** Next.js 16 (App Router, TypeScript)
- **API Backend:** Node.js + Express
- **Styling:** Tailwind CSS v4
- **State:** Zustand
- **AI Providers:** Vertex AI (Anthropic SDK) + Azure OpenAI/Foundry (chat completions REST)
- **AI Runtime:** Provider-agnostic adapter in `backend/src/lib/ai-runtime.ts`
- **NLP:** compromise (sentence-level fact/hypothesis extraction for context compaction)
- **Tokenizer:** gpt-tokenizer (o200k_base BPE, used for compaction budget estimation)
- **Markdown:** react-markdown + remark-gfm
- **Icons:** Lucide React

---

## Project Structure

```text
SRESimulator/
├── CLAUDE.md                             # Design document and game spec
├── README.md
├── Makefile                              # Build, lint, dev, and CI targets
├── helm/sre-simulator/                   # OpenShift/Kubernetes deployment manifests
├── knowledge_base/                       # Reference docs loaded into AI context
│   ├── sre-investigation-techniques.md
│   ├── Openshift-clusters-alerts-resolutions.md
│   └── Community-reported-issues.md
├── docs/
│   ├── ARCHITECTURE.md                   # This file
│   └── AI_RUNTIME.md                     # AI provider, compaction, token management
├── frontend/                             # Next.js application (UI only)
│   ├── src/
│   │   ├── app/
│   │   │   ├── page.tsx                  # Landing page (scenario selection)
│   │   │   ├── game/page.tsx             # Main game page
│   │   │   ├── leaderboard/page.tsx      # Hall of fame view
│   │   │   └── api/[...path]/route.ts    # Internal BFF proxy to backend service
│   │   ├── components/
│   │   │   ├── chat/                     # Chat panel, messages, input
│   │   │   ├── terminal/                 # Terminal output display
│   │   │   ├── dashboard/                # Cluster overview and alerts
│   │   │   ├── scoring/                  # Phase tracker, score breakdown
│   │   │   ├── layout/                   # Game layout, header, right panel
│   │   │   └── shared/                   # Code blocks, incident ticket
│   │   ├── hooks/                        # useChat, useCommand, useScoring
│   │   ├── stores/                       # Zustand game state
│   │   ├── lib/                          # API client helpers
│   │   └── types/                        # TypeScript type definitions
│   └── .env.local                        # Environment variables (not committed)
└── backend/                              # Express API server
    └── src/
        ├── index.ts                      # API wiring and middleware
        ├── routes/                       # /api/chat, /api/command, /api/scenario, /api/scores, /api/ai
        └── lib/
            ├── ai-runtime.ts             # Provider-agnostic AI adapter (Vertex + Azure)
            ├── ai-config.ts              # Provider detection, readiness checks
            ├── context-compactor.ts       # Chat history compaction with retained-state
            ├── nlp-extract.ts            # Compromise-based fact/hypothesis extraction
            ├── profanity.ts              # Nickname profanity filter (static blocklist)
            ├── token-logger.ts            # Per-route token usage observability
            ├── rate-limit.ts             # Per-IP rate limiting for AI routes
            ├── knowledge.ts              # Knowledge base file loader
            ├── prompts/system.ts         # System prompt builder
            └── storage/                  # Pluggable persistence layer
                ├── types.ts              # ISessionStore, ILeaderboardStore, IMetricsStore
                ├── index.ts              # Factory (selects JSON or Azure SQL)
                ├── migrate.ts            # T-SQL migration runner
                ├── json-*-store.ts       # JSON/in-memory implementations
                ├── mssql-*-store.ts      # Azure SQL (T-SQL) implementations
                └── migrations/           # Numbered .sql migration files
```

---

## OpenShift Exposure Model

Short answer: **only the frontend is internet-exposed; backend stays private inside the cluster**.

### What is exposed

- A single OpenShift Route maps `https://<host>/` to the frontend `ClusterIP` service.
- There is **no** backend Route (`/api` is not published by the OpenShift router).
- The backend remains a private `ClusterIP` service reachable only from inside the namespace network.

### How the internal proxy works

- Browser still calls same-origin paths like `/api/chat`.
- Those requests hit the frontend Next.js server first.
- Frontend route handler (`app/api/[...path]/route.ts`) proxies server-to-server to `http://<release>-backend:<port>`.
- Backend `NetworkPolicy` only allows ingress from frontend Pods on backend port.

### Request flow in OpenShift

1. User opens `https://<host>/` (frontend Route).
2. Frontend calls `fetch("/api/...")`.
3. Frontend pod proxies the request internally to backend `ClusterIP`.
4. Backend responds to frontend pod; frontend returns response to client.

### Security outcome

- Backend is not directly reachable from the internet.
- External traffic terminates at frontend only.
- Backend remains isolated with least-privilege pod-to-pod access.

---

## Investigation Methodology

The game enforces the SRE "Scientific Method of Investigation":

| Phase | What to do | Example prompt from DM |
| --------------------- | ---------------------------------- | ------------------------------------ |
| **Reading** | Read the incident ticket carefully | _"What inconsistencies do you see?"_ |
| **Context Gathering** | Check dashboards, cluster history | _"Have you checked Geneva first?"_ |
| **Facts Gathering** | Run commands, collect evidence | `oc get nodes`, KQL queries |
| **Theory Building** | Form a hypothesis | _"What do you think is happening?"_ |
| **Action** | Apply the fix (safely) | _"Is this reversible?"_ |

The AI Dungeon Master enforces phase ordering and pushes back if you try to skip ahead.

---

## Scoring System

You start at **0/100** and earn points through good investigation practices.

### Dimensions

| Dimension | Max | What earns points | What loses points |
| ------------- | --- | --------------------------------------------- | ------------------------------------ |
| Efficiency | 25 | Focused, targeted investigation | Excessive or irrelevant commands |
| Safety | 25 | Checking dashboards first, suggesting backups | Running commands without context |
| Documentation | 25 | Following phases in order, thorough analysis | Skipping phases, jumping to action |
| Accuracy | 25 | Correct hypotheses, proper root cause | Wrong theories, misidentified causes |

### How scoring works

**AI-driven scoring:** The Dungeon Master evaluates your approach in real-time and awards/deducts points after each interaction using `[SCORE:dimension:+/-points:reason]` markers embedded in responses. These are parsed by the frontend and hidden from the user.

**Automatic scoring:** The system also tracks behavior directly:

- Opening the Dashboard tab before running commands → safety bonus
- Running commands without checking the dashboard → safety penalty
- Running commands during the Reading phase → documentation penalty
- Exceeding 5 commands → progressive efficiency penalties
- Command rate limit: each suggested command can only be run once (button shows "Ran" after execution)

### Grades

| Grade | Score |
| ----- | ----- |
| A | 90+ |
| B | 80+ |
| C | 70+ |
| D | 60+ |
| F | < 60 |

---

## AI Integration

The backend integrates with LLM providers for chat, command simulation,
and scenario generation. See **[AI_RUNTIME.md](AI_RUNTIME.md)** for full
details on provider abstraction, context compaction, token management,
per-route deployments, and environment variable reference.

Key design highlights:

- **Dual-provider support** — Vertex AI (Claude) and Azure OpenAI behind a
  single adapter, switchable via `AI_PROVIDER` env var.
- **Hybrid context compaction** — regex for structured markers + NLP
  (compromise library) for fact/hypothesis extraction, with BPE token
  estimation for accurate budget tracking.
- **Reasoning-model compatibility** — automatic o-series detection skips
  unsupported parameters and manages `reasoning_effort`.
- **Section-based KB retrieval** — only scenario-relevant knowledge base
  sections are sent (~10K tokens vs ~32K full KB).
- **Prompt caching** — static instruction block first in system prompt to
  maximize Azure OpenAI cache hits across players.
- **Per-route deployments** — separate Azure OpenAI deployments per route
  for independent rate-limit pools.
- **Graceful degradation** — retries with reduced reasoning effort, then
  falls back to mock output if the model exhausts its budget.

---

## Backend API Routes

In OpenShift, browser requests hit the frontend at `/api/*`; the frontend BFF proxy forwards them internally to this backend service.

### `POST /api/scenario`

Generates a scenario for the given difficulty. Calls the configured AI provider with knowledge-base context to produce a realistic incident ticket and cluster context. In `AI_MOCK_MODE=true`, returns a deterministic mock scenario.

### `POST /api/chat`

Streaming chat endpoint. Builds a system prompt with Dungeon Master persona, methodology enforcement, active scenario, and knowledge base. Chat history is automatically compacted when token estimates exceed the budget. Returns SSE stream from the configured provider (or a mock stream in mock mode).

### `POST /api/command`

Simulates command execution. Given an `oc`, KQL, or Geneva command and the current scenario, the configured provider generates realistic output consistent with the incident. In `AI_MOCK_MODE=true`, returns mock command output. Falls back to mock output when reasoning models exhaust the completion budget.

### `GET /api/ai/readiness`

Returns AI runtime readiness checks (safe diagnostics only, no secrets).

### `GET /api/ai/probe?live=true`

Performs an active live probe against the configured provider to validate in-cluster connectivity end-to-end.

### `GET /api/ai/token-metrics`

Returns per-route token usage totals and recent request entries. See [AI_RUNTIME.md — Token Observability](AI_RUNTIME.md#token-observability).

---

## Persistence & Storage Backends

The backend supports two storage modes, selected via the `STORAGE_BACKEND`
environment variable (`json` or `mssql`).

### JSON mode (default)

Best for local development and single-replica deployments.

- **Sessions**: In-memory `Map` with 24h TTL. Lost on pod restart.
- **Leaderboard**: JSON file on PVC (`data/leaderboard.json`). Writes are
  serialized through an in-process async mutex.
- **Metrics**: Log-only (no persistent storage).

Constraints:

- Single backend replica only (PVC is `ReadWriteOnce`, sessions are in-process).
- No data survives pod restarts (except leaderboard file on PVC).

### Azure SQL mode

Required for multi-replica deployments and production use.  Uses Azure SQL
Database free tier (100K vCore-seconds/month, 32 GB storage, $0/month).

- **Sessions**: Stored in `sessions` table. Shared across replicas.
  Stale entries (>24h) are cleaned up opportunistically.
- **Leaderboard**: Stored in `leaderboard_entries` table. Uses `MERGE`
  to atomically keep the best score per (nickname, difficulty).
  Per-difficulty trim to 10 entries happens after each insert.
- **Metrics**: Stored in `gameplay_metrics` table. Captures per-session
  analytics (commands executed, scoring events, AI token consumption) with
  an open JSON `metadata` column for future extensibility.

To enable:

```bash
STORAGE_BACKEND=mssql
DATABASE_URL="Server=<fqdn>;Database=sresimulator;User Id=sresimadmin;Password=<pwd>;Encrypt=true"
```

Migrations run automatically on startup using `sp_getapplock` for
cross-replica serialization. Schema is managed via numbered `.sql` files
in `backend/src/lib/storage/migrations/`.

### Why Azure SQL free tier

- **Zero cost**: 100K vCore-seconds/month + 32 GB included permanently.
- **Zero maintenance**: HA, backups, patching handled by Azure.
- **Auto-pause**: Database sleeps after 60 min idle; resumes on next request.
- **Point-in-time restore**: Built-in backup retention (7 days default).

When the monthly free allocation is exhausted the database auto-pauses
until the next billing cycle (configurable to continue with pay-as-you-go
instead).

### Storage interface pattern

All persistence is abstracted behind three interfaces (`ISessionStore`,
`ILeaderboardStore`, `IMetricsStore`) in `backend/src/lib/storage/types.ts`.
The factory in `backend/src/lib/storage/index.ts` selects the implementation
at startup based on `STORAGE_BACKEND`.

---

## Multiplayer Scaling & Resilience

### Concurrency model

The backend is stateless per-request for AI calls (chat, command, scenario).
All conversation state lives in the browser and is sent with each request.
This means multiple users can play independently against the same backend
without session affinity.

### Scaling by storage mode

| Concern | JSON mode | Azure SQL mode |
| --- | --- | --- |
| Backend replicas | **1 only** | **N (horizontal)** |
| Session survival | Lost on restart | Survives restarts |
| Leaderboard consistency | Single-writer mutex | Database MERGE |
| Sticky sessions needed | No | No |
| Connection pooling | N/A | `mssql.ConnectionPool` |

When using Azure SQL, increase `backend.replicas` in Helm values as needed.
No sticky sessions or session affinity are required since all state is in
the database.

### Infrastructure

- **Azure SQL Database free tier** ($0/month):
  Provisioned via `infra/sql-database.tf` when `enable_database = true`.
  Protected by `prevent_destroy` lifecycle rule.
  Serverless General Purpose (GP_S_Gen5_2) with auto-pause after 60 min idle.
  Free offer includes 100K vCore-seconds/month and 32 GB storage.

### Rate limiting & throttle handling

See [AI_RUNTIME.md — Rate Limiting](AI_RUNTIME.md#rate-limiting--throttle-handling) for per-IP rate limits, Azure 429 retry strategy, and AOAI capacity sizing guidelines.
