# 🎮 SRE Simulator

## *The Break-Fix Game for Azure Red Hat OpenShift*

> An AI-powered training tool that gamifies the SRE investigation experience. An AI **Dungeon Master** 🧙 generates realistic ARO cluster incidents, and you investigate them using the proper methodology:
>
> **📖 Reading → 🔍 Context Gathering → 📊 Facts Gathering → 💡 Theory Building → 🔧 Action**

You're scored on how well you follow the process, not just whether you find the fix.

---

## 🕹️ How It Works

1. 🎯 **Pick a difficulty** — Junior SRE (easy), Shift Lead (medium), or Principal Engineer (hard)
2. 📋 **Read the incident ticket** — the AI generates a realistic IcM ticket with cluster context
3. 💬 **Investigate via chat** — describe what you want to check; the Dungeon Master suggests `oc` commands, KQL queries, and Geneva checks
4. ▶️ **Run commands** — click "Run" on suggested commands to see simulated cluster output in the terminal panel
5. 📊 **Check the dashboard** — view cluster health, active alerts, and upgrade history
6. ✅ **Resolve the incident** — identify the root cause and apply the fix

Your score tracks four dimensions: **Efficiency**, **Safety**, **Documentation**, and **Accuracy**.

---

## 📋 Prerequisites

| Requirement | Version |
| --- | --- |
| 🟢 Node.js | >= 20 (tested with v25.6.1) |
| 📦 npm | >= 10 |
| ☁️ Google Cloud SDK (`gcloud`) | Authenticated with access to Vertex AI |
| 🤖 Claude on Vertex AI | Enabled in your GCP project |

---

## 🔑 LLM Setup (Claude on Vertex AI)

This project uses Claude via Google Cloud's Vertex AI. You need a GCP project with the Anthropic Claude model enabled.

### Step 1 — 🔐 Authenticate with Google Cloud

```bash
gcloud auth login
gcloud auth application-default login
```

### Step 2 — ⚙️ Configure environment variables

```bash
cp frontend/.env.local.example frontend/.env.local
```

Edit `frontend/.env.local` with your values:

```env
CLOUD_ML_REGION=us-east5
ANTHROPIC_VERTEX_PROJECT_ID=your-gcp-project-id
```

| Variable | Description |
| --- | --- |
| `CLOUD_ML_REGION` | GCP region where Claude is available (e.g. `us-east5`) |
| `ANTHROPIC_VERTEX_PROJECT_ID` | Your GCP project ID |

> 💡 The SDK authenticates automatically using Application Default Credentials from `gcloud auth application-default login`. No API keys needed.

### Step 3 — ✅ Verify your project and region

Load the variables you just configured and set the active GCP project:

```bash
source frontend/.env.local
gcloud config set project $ANTHROPIC_VERTEX_PROJECT_ID
```

The model used is `claude-sonnet-4@20250514`. Verify it's available in your region:

```bash
source frontend/.env.local
curl -s -X POST \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  "https://${CLOUD_ML_REGION}-aiplatform.googleapis.com/v1/projects/${ANTHROPIC_VERTEX_PROJECT_ID}/locations/${CLOUD_ML_REGION}/publishers/anthropic/models/claude-sonnet-4@20250514:rawPredict" \
  -d '{"anthropic_version":"vertex-2023-10-16","messages":[{"role":"user","content":"hi"}],"max_tokens":10}'
```

If you get a `200` response, you're good to go! 🎉 If not, check that:

- ✅ The Vertex AI API is enabled in your project
- ✅ Claude models are enabled (via the Vertex AI Model Garden in the GCP Console)
- ✅ Your region supports Claude (common regions: `us-east5`, `us-central1`, `europe-west1`)

### 🔄 Changing the model

To use a different Claude model, edit the `CLAUDE_MODEL` constant in `frontend/src/lib/claude.ts`:

```typescript
export const CLAUDE_MODEL = "claude-sonnet-4@20250514";
```

Use the Vertex AI model name format: `model-name@date` (with `@`, not `-`).

---

## 🚀 Getting Started

```bash
# 1. Clone the repository
git clone <repo-url>
cd SRESimulator

# 2. Configure environment (see LLM Setup above)
cp frontend/.env.local.example frontend/.env.local
# ✏️ Edit frontend/.env.local with your GCP project ID and region

# 3. Install dependencies
make install

# 4. Start the development server
make dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser. 🌐

### 🛠️ Available Make targets

Run `make help` for the full list. Here are the most useful ones:

| Command | Description |
| --- | --- |
| `make install` | 📦 Install all dependencies |
| `make dev` | 🚀 Start Next.js dev server |
| `make build` | 🏗️ Build the production bundle |
| `make start` | 🏗️ + ▶️ Build and start production server |
| `make lint` | 🔍 Run all linters (TS, YAML, Markdown) |
| `make fmt` | ✨ Auto-fix formatting |
| `make typecheck` | 🔎 Run TypeScript type checking |
| `make validate` | 🔍 + 🔎 Lint + type check |
| `make security` | 🔒 Run security audit + lockfile check |
| `make all` | 🏁 Full CI pipeline (lint + typecheck + security + build) |
| `make clean` | 🧹 Remove build artifacts and node_modules |

---

## 📁 Project Structure

```text
SRESimulator/
├── 📄 CLAUDE.md                          # Design document and game spec
├── 📄 README.md                          # This file
├── 📄 Makefile                           # Build, lint, dev, and CI targets
├── 📚 knowledge_base/                    # Reference docs loaded into AI context
│   ├── sre-investigation-techniques.md
│   ├── Openshift-clusters-alerts-resolutions.md
│   └── Community-reported-issues.md
└── 🖥️ frontend/                          # Next.js application
    ├── src/
    │   ├── app/
    │   │   ├── page.tsx               # Landing page (scenario selection)
    │   │   ├── game/page.tsx          # Main game page
    │   │   └── api/
    │   │       ├── chat/route.ts      # Claude streaming chat endpoint
    │   │       ├── command/route.ts   # Simulated command execution
    │   │       └── scenario/route.ts  # Scenario generation
    │   ├── components/
    │   │   ├── chat/                  # Chat panel, messages, input
    │   │   ├── terminal/              # Terminal output display
    │   │   ├── dashboard/             # Cluster overview and alerts
    │   │   ├── scoring/               # Phase tracker, score overlay, breakdown
    │   │   ├── layout/                # Game layout, header, right panel
    │   │   └── shared/                # Code blocks, incident ticket
    │   ├── hooks/                     # useChat, useCommand, useScoring
    │   ├── stores/                    # Zustand game state
    │   ├── lib/                       # Claude client, knowledge loader, prompts
    │   └── types/                     # TypeScript type definitions
    └── .env.local                     # Environment variables (not committed)
```

---

## 🧰 Tech Stack

| Layer | Technology |
| --- | --- |
| ⚡ Framework | Next.js 15 (App Router, TypeScript) |
| 🎨 Styling | Tailwind CSS v4 |
| 🗃️ State | Zustand |
| 🤖 LLM | Claude via Vertex AI (`@anthropic-ai/vertex-sdk`) |
| 📝 Markdown | react-markdown + remark-gfm |
| 🎯 Icons | Lucide React |

---

## 🔬 Investigation Methodology

The game enforces the SRE "Scientific Method of Investigation":

| Phase | What to do | Example |
| --- | --- | --- |
| 📖 **Reading** | Read the incident ticket carefully | *"What inconsistencies do you see?"* |
| 🔍 **Context Gathering** | Check dashboards, cluster history | *"Have you checked Geneva first?"* |
| 📊 **Facts Gathering** | Run commands, collect evidence | `oc get nodes`, KQL queries |
| 💡 **Theory Building** | Form a hypothesis | *"What do you think is happening?"* |
| 🔧 **Action** | Apply the fix (safely) | *"Is this reversible?"* |

> ⚠️ The AI Dungeon Master will push back if you try to skip phases!

---

## 🏆 Scoring

| Dimension | Max | What's measured |
| --- | --- | --- |
| ⚡ Efficiency | 25 | Commands run vs. optimal path |
| 🛡️ Safety | 25 | Checked dashboards before commands, backed up config |
| 📝 Documentation | 25 | Followed methodology phases in order |
| 🎯 Accuracy | 25 | Correctly identified root cause |

**Final grade:** 🥇 A (90+) · 🥈 B (80+) · 🥉 C (70+) · D (60+) · F (<60)
