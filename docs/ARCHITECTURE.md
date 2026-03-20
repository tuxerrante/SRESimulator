# Architecture & Game Design

## Tech Stack

| Layer     | Technology                                        |
| --------- | ------------------------------------------------- |
| Framework | Next.js 16 (App Router, TypeScript)               |
| Styling   | Tailwind CSS v4                                   |
| State     | Zustand                                           |
| LLM       | Claude via Vertex AI (`@anthropic-ai/vertex-sdk`) |
| Markdown  | react-markdown + remark-gfm                       |
| Icons     | Lucide React                                      |

---

## Project Structure

```text
SRESimulator/
├── CLAUDE.md                             # Design document and game spec
├── README.md
├── Makefile                              # Build, lint, dev, and CI targets
├── knowledge_base/                       # Reference docs loaded into AI context
│   ├── sre-investigation-techniques.md
│   ├── Openshift-clusters-alerts-resolutions.md
│   └── Community-reported-issues.md
├── docs/
│   └── ARCHITECTURE.md                   # This file
└── frontend/                             # Next.js application
    ├── src/
    │   ├── app/
    │   │   ├── page.tsx                  # Landing page (scenario selection)
    │   │   ├── game/page.tsx             # Main game page
    │   │   └── api/
    │   │       ├── chat/route.ts         # Claude streaming chat endpoint
    │   │       ├── command/route.ts      # Simulated command execution
    │   │       └── scenario/route.ts     # Scenario generation
    │   ├── components/
    │   │   ├── chat/                     # Chat panel, messages, input
    │   │   ├── terminal/                 # Terminal output display
    │   │   ├── dashboard/                # Cluster overview and alerts
    │   │   ├── scoring/                  # Phase tracker, score breakdown
    │   │   ├── layout/                   # Game layout, header, right panel
    │   │   └── shared/                   # Code blocks, incident ticket
    │   ├── hooks/                        # useChat, useCommand, useScoring
    │   ├── stores/                       # Zustand game state
    │   ├── lib/                          # Claude client, knowledge loader, prompts
    │   └── types/                        # TypeScript type definitions
    └── .env.local                        # Environment variables (not committed)
```

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

### `POST /api/scenario`

Generates a scenario for the given difficulty. Calls Claude with the full knowledge base to produce a realistic incident ticket and cluster context. In `AI_MOCK_MODE=true`, returns a deterministic mock scenario.

### `POST /api/chat`

Streaming chat endpoint. Builds a system prompt with Dungeon Master persona, methodology enforcement, active scenario, and knowledge base. Returns SSE stream of Claude's response.

### `POST /api/command`

Simulates command execution. Given an `oc`, KQL, or Geneva command and the current scenario, Claude generates realistic output consistent with the incident. In `AI_MOCK_MODE=true`, returns mock command output.

### `GET /api/ai/readiness`

Returns AI runtime readiness checks (safe diagnostics only, no secrets).

### `GET /api/ai/probe?live=true`

Performs an active Claude-on-Vertex probe to validate in-cluster connectivity end-to-end.

---

## Changing the model

Set the model through the backend environment variable:

```bash
CLAUDE_MODEL=claude-sonnet-4@20250514
```

Use the Vertex AI model name format: `model-name@date` (with `@`, not `-`).
