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
            ├── token-logger.ts            # Per-route token usage observability
            ├── rate-limit.ts             # Per-IP rate limiting for AI routes
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

## Multiplayer Scaling & Resilience

### Concurrency model

The backend is stateless per-request for AI calls (chat, command, scenario). All conversation state lives in the browser and is sent with each request. This means multiple users can play independently against the same backend without session affinity.

Two pieces of server-side state exist:

- **Score tokens**: in-memory `Map` with 24h TTL (`backend/src/lib/sessions.ts`). Lost on pod restart; acceptable since they are ephemeral anti-cheat tokens.
- **Leaderboard**: JSON file on PVC (`backend/src/lib/leaderboard.ts`). Writes are serialized through an in-process async mutex to prevent concurrent read-modify-write races.

### Rate limiting & throttle handling

See [AI_RUNTIME.md — Rate Limiting](AI_RUNTIME.md#rate-limiting--throttle-handling) for per-IP rate limits, Azure 429 retry strategy, and AOAI capacity sizing guidelines.
