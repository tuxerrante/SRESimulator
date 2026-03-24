# Architecture & Game Design

## Tech Stack

- **Framework:** Next.js 16 (App Router, TypeScript)
- **API Backend:** Node.js + Express
- **Styling:** Tailwind CSS v4
- **State:** Zustand
- **AI Providers:** Vertex AI (Anthropic SDK) + Azure OpenAI/Foundry (chat completions REST)
- **AI Runtime:** Provider-agnostic adapter in `backend/src/lib/ai-runtime.ts`
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
│   └── ARCHITECTURE.md                   # This file
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
            ├── token-logger.ts            # Per-route token usage observability
            ├── knowledge.ts              # Knowledge base file loader
            └── prompts/system.ts         # System prompt builder
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

## Context Management & Token Efficiency

The backend manages AI context to prevent token exhaustion, especially with high-reasoning models (e.g. gpt-5.x) that can consume the entire completion budget on internal reasoning without producing output text.

### Chat history compaction

Long conversations are automatically compacted before each AI request. The compactor (`backend/src/lib/context-compactor.ts`) estimates message token counts and, when the total exceeds the budget (default ~12k tokens for messages, accounting for the system prompt), replaces older messages with a structured summary while keeping the most recent messages verbatim.

**Retained-state schema** (best-effort heuristic extraction; may miss or simplify some details):

| Field | Description |
| ---------------------- | --------------------------------------------------------- |
| `phase` | Current investigation phase |
| `knownFacts` | Evidence confirmed during the investigation |
| `hypotheses` | User theories about root cause |
| `mentionedCommands` | Commands suggested by DM or referenced by user |
| `unresolvedQuestions` | Questions the user asked that remain unanswered |
| `summaryOfDiscussion` | Scoring events and key discussion milestones |

The compactor uses a heuristic token estimator (~4 chars/token) rather than a tokenizer dependency to keep the backend lightweight.

### Command simulation prompt optimization

The command route (`/api/command`) builds system prompts from extracted helper functions rather than inline string literals. Only the scenario context and temporal rules are sent as dynamic content; the static instruction layer is shared across calls.

### Fallback behavior

If Azure OpenAI returns empty text (e.g. reasoning tokens consumed the completion budget), the command route falls back to deterministic mock output so gameplay continues unblocked.

---

## Per-Route AI Deployments

Each API route can use a different Azure OpenAI deployment, allowing cost/performance optimization per workload. The runtime resolves deployments in this order:

1. Route-specific env var (e.g. `AI_AZURE_OPENAI_DEPLOYMENT_CHAT`)
2. Global fallback (`AI_AZURE_OPENAI_DEPLOYMENT`)

The global `AI_AZURE_OPENAI_DEPLOYMENT` is still required for readiness validation and serves as the default for any route without a specific override. If neither is set for a given route, the runtime throws a clear error.

| Route | Env var override | Recommended model characteristics |
| ---------- | ----------------------------------------- | ----------------------------------- |
| `chat` | `AI_AZURE_OPENAI_DEPLOYMENT_CHAT` | High quality, streaming support |
| `command` | `AI_AZURE_OPENAI_DEPLOYMENT_COMMAND` | Fast, good at structured output |
| `scenario` | `AI_AZURE_OPENAI_DEPLOYMENT_SCENARIO` | Good at JSON generation |
| `probe` | `AI_AZURE_OPENAI_DEPLOYMENT_PROBE` | Cheapest/fastest available |

All route-specific overrides are optional. When not set, all routes share the global deployment.

---

## Token Observability

The backend logs token usage per route and per request (`backend/src/lib/token-logger.ts`). Both Vertex (streaming and non-streaming) and Azure OpenAI requests emit structured log lines. The `model` field is the configured model name; Azure logs also include a `deployment` field since deployment names may differ from the model. When chat history was compacted before the request, the log includes the compacted message count:

```text
[token-usage] route=chat model=gpt-5.2 deployment=gpt5-eastus prompt=3200 completion=450 reasoning=0 total=3650 latency=1200ms
[token-usage] route=chat model=gpt-5.2 deployment=gpt5-eastus prompt=1800 completion=500 reasoning=0 total=2300 latency=900ms compacted=14msgs
[token-usage] route=command model=gpt-4o-mini deployment=gpt4o-mini-eastus prompt=800 completion=200 reasoning=0 total=1000 latency=600ms
```

An admin endpoint is available for inspecting aggregated metrics:

### `GET /api/ai/token-metrics`

Returns per-route totals (requests, prompt/completion/reasoning tokens, errors) and recent request entries. Protected by `x-ai-probe-token` in production.

---

## Backend API Routes

In OpenShift, browser requests hit the frontend at `/api/*`; the frontend BFF proxy forwards them internally to this backend service.

### `POST /api/scenario`

Generates a scenario for the given difficulty. Calls the configured AI provider with knowledge-base context to produce a realistic incident ticket and cluster context. In `AI_MOCK_MODE=true`, returns a deterministic mock scenario.

### `POST /api/chat`

Streaming chat endpoint. Builds a system prompt with Dungeon Master persona, methodology enforcement, active scenario, and knowledge base. Chat history is automatically compacted when token estimates exceed the budget. Returns SSE stream from the configured provider (or a mock stream in mock mode).

### `POST /api/command`

Simulates command execution. Given an `oc`, KQL, or Geneva command and the current scenario, the configured provider generates realistic output consistent with the incident. In `AI_MOCK_MODE=true`, returns mock command output.

If a live provider response is empty (for example, some high-reasoning models can exhaust completion budget without emitting text), the backend falls back to deterministic mock command output to keep gameplay unblocked.

### `GET /api/ai/readiness`

Returns AI runtime readiness checks (safe diagnostics only, no secrets).

### `GET /api/ai/probe?live=true`

Performs an active live probe against the configured provider to validate in-cluster connectivity end-to-end.

Token metrics are also available at `GET /api/ai/token-metrics` (see [Token Observability](#token-observability) above).

---

## Changing provider and model

Set runtime via backend env vars:

```bash
AI_PROVIDER=vertex              # or azure-openai
AI_MODEL=claude-sonnet-4@20250514
```

For Vertex mode, set:

```bash
CLOUD_ML_REGION=us-east5
ANTHROPIC_VERTEX_PROJECT_ID=<gcp-project-id>
```

For Azure OpenAI/Foundry mode, set:

```bash
AI_AZURE_OPENAI_ENDPOINT=https://<account>.cognitiveservices.azure.com
AI_AZURE_OPENAI_DEPLOYMENT=<deployment-name>
AI_AZURE_OPENAI_API_VERSION=2024-10-21
AI_AZURE_OPENAI_API_KEY=<api-key>
```

Optional per-route deployment overrides:

```bash
AI_AZURE_OPENAI_DEPLOYMENT_CHAT=gpt-5.2
AI_AZURE_OPENAI_DEPLOYMENT_COMMAND=gpt-4o-mini
AI_AZURE_OPENAI_DEPLOYMENT_SCENARIO=gpt-4o-mini
```

`CLAUDE_MODEL` is still accepted as a backward-compatible alias, but `AI_MODEL` is the preferred variable.

---

## Multiplayer Scaling & Resilience

### Concurrency model

The backend is stateless per-request for AI calls (chat, command, scenario). All conversation state lives in the browser and is sent with each request. This means multiple users can play independently against the same backend without session affinity.

Two pieces of server-side state exist:

- **Score tokens**: in-memory `Map` with 24h TTL (`backend/src/lib/sessions.ts`). Lost on pod restart; acceptable since they are ephemeral anti-cheat tokens.
- **Leaderboard**: JSON file on PVC (`backend/src/lib/leaderboard.ts`). Writes are serialized through an in-process async mutex to prevent concurrent read-modify-write races.

### Rate limiting

AI-backed routes (`/api/chat`, `/api/command`, `/api/scenario`) are rate-limited per IP using `express-rate-limit` (15 req/min per client). This prevents a single user from exhausting the shared AOAI TPM quota and affecting other users.

### Azure OpenAI throttle handling

When Azure OpenAI returns HTTP 429, the backend retries with exponential backoff and jitter (up to 3 attempts, respecting the `Retry-After` header). If all retries are exhausted, the client receives a 429 with a user-friendly message instead of a generic 500 error.

### AOAI capacity sizing

The `aoai_capacity` Terraform variable (default 80K TPM) controls the rate limit on the shared Azure OpenAI deployment. On Standard (pay-as-you-go) deployments, this only affects throttling — not cost. Per-route token consumption measured in PR #31:

| Route | Tokens/request | Peak rate (1 user) | Peak TPM |
| ------- | --------------- | ------------------- | ---------- |
| Chat | ~16K | 2-3/min | ~48K |
| Command | ~4K | 1-2/min | ~8K |
| Scenario | ~2.3K | burst | ~2K |

For multi-user deployments, multiply the single-user peak (~50K TPM) by the number of concurrent users and increase `aoai_capacity` accordingly. Creating or modifying Azure OpenAI deployments takes 1-2 hours, so always pre-provision capacity.
