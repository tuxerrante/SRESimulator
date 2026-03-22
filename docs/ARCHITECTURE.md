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
        └── lib/                          # AI runtime, scoring, leaderboard, prompts
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

| Phase                 | What to do                         | Example prompt from DM               |
| --------------------- | ---------------------------------- | ------------------------------------ |
| **Reading**           | Read the incident ticket carefully | _"What inconsistencies do you see?"_ |
| **Context Gathering** | Check dashboards, cluster history  | _"Have you checked Geneva first?"_   |
| **Facts Gathering**   | Run commands, collect evidence     | `oc get nodes`, KQL queries          |
| **Theory Building**   | Form a hypothesis                  | _"What do you think is happening?"_  |
| **Action**            | Apply the fix (safely)             | _"Is this reversible?"_              |

The AI Dungeon Master enforces phase ordering and pushes back if you try to skip ahead.

---

## Scoring System

You start at **0/100** and earn points through good investigation practices.

### Dimensions

| Dimension     | Max | What earns points                             | What loses points                    |
| ------------- | --- | --------------------------------------------- | ------------------------------------ |
| Efficiency    | 25  | Focused, targeted investigation               | Excessive or irrelevant commands     |
| Safety        | 25  | Checking dashboards first, suggesting backups | Running commands without context     |
| Documentation | 25  | Following phases in order, thorough analysis  | Skipping phases, jumping to action   |
| Accuracy      | 25  | Correct hypotheses, proper root cause         | Wrong theories, misidentified causes |

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
| A     | 90+   |
| B     | 80+   |
| C     | 70+   |
| D     | 60+   |
| F     | < 60  |

---

## Backend API Routes

In OpenShift, browser requests hit the frontend at `/api/*`; the frontend BFF proxy forwards them internally to this backend service.

### `POST /api/scenario`

Generates a scenario for the given difficulty. Calls the configured AI provider with knowledge-base context to produce a realistic incident ticket and cluster context. In `AI_MOCK_MODE=true`, returns a deterministic mock scenario.

### `POST /api/chat`

Streaming chat endpoint. Builds a system prompt with Dungeon Master persona, methodology enforcement, active scenario, and knowledge base. Returns SSE stream from the configured provider (or a mock stream in mock mode).

### `POST /api/command`

Simulates command execution. Given an `oc`, KQL, or Geneva command and the current scenario, the configured provider generates realistic output consistent with the incident. In `AI_MOCK_MODE=true`, returns mock command output.

If a live provider response is empty (for example, some high-reasoning models can exhaust completion budget without emitting text), the backend falls back to deterministic mock command output to keep gameplay unblocked.

### `GET /api/ai/readiness`

Returns AI runtime readiness checks (safe diagnostics only, no secrets).

### `GET /api/ai/probe?live=true`

Performs an active live probe against the configured provider to validate in-cluster connectivity end-to-end.

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

`CLAUDE_MODEL` is still accepted as a backward-compatible alias, but `AI_MODEL` is the preferred variable.
