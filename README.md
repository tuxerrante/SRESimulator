# 🎮 SRE Simulator

## _The Break-Fix Game for Azure Red Hat OpenShift_

> An AI-powered training tool that gamifies the SRE investigation experience.
> An AI **Dungeon Master** 🧙 generates realistic ARO cluster incidents, and you investigate them using the proper methodology:
>
> **📖 Reading → 🔍 Context Gathering → 📊 Facts Gathering → 💡 Theory Building → 🔧 Action**

You're scored on how well you follow the process, not just whether you find the fix!

---

## 🕹️ How It Works

1. 🎯 **Pick a difficulty** — Junior SRE (easy), Shift Lead (medium), or Principal Engineer (hard)
2. 📋 **Read the incident ticket** — the AI generates a realistic IcM ticket with cluster context
3. 💬 **Investigate via chat** — describe what you want to check; the Dungeon Master suggests `oc` commands, KQL queries, and Geneva checks
4. ▶️ **Run commands** — click "Run" on suggested commands to see simulated cluster output in the terminal panel
5. 📊 **Check the dashboard** — view cluster health, active alerts, and upgrade history
6. ✅ **Resolve the incident** — identify the root cause and apply the fix

Your score tracks four dimensions: **Efficiency**, **Safety**, **Documentation**, and **Accuracy** — starting from 0 and climbing with every smart move. See [Architecture & Game Design](docs/ARCHITECTURE.md) for full details.

---

## 📋 Prerequisites

| Requirement                    | Version                                |
| ------------------------------ | -------------------------------------- |
| 🟢 Node.js                     | >= 20                                  |
| 📦 npm                         | >= 10                                  |
| ☁️ Google Cloud SDK (`gcloud`) | Authenticated with access to Vertex AI |
| 🤖 Claude on Vertex AI         | Enabled in your GCP project            |

---

## 🔑 LLM Setup (Claude on Vertex AI)

### Step 1 — Authenticate

```bash
gcloud auth login
gcloud auth application-default login
```

### Step 2 — Configure environment

```bash
cp frontend/.env.local.example frontend/.env.local
```

Edit `frontend/.env.local`:

```env
CLOUD_ML_REGION=us-east5
ANTHROPIC_VERTEX_PROJECT_ID=your-gcp-project-id
```

> 💡 The SDK authenticates via Application Default Credentials. No API keys needed.

### Step 3 — Verify access

```bash
source frontend/.env.local
gcloud config set project $ANTHROPIC_VERTEX_PROJECT_ID
curl -s -X POST \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  "https://${CLOUD_ML_REGION}-aiplatform.googleapis.com/v1/projects/${ANTHROPIC_VERTEX_PROJECT_ID}/locations/${CLOUD_ML_REGION}/publishers/anthropic/models/claude-sonnet-4@20250514:rawPredict" \
  -d '{"anthropic_version":"vertex-2023-10-16","messages":[{"role":"user","content":"hi"}],"max_tokens":10}'
```

A `200` response means you're ready. If not, ensure the Vertex AI API and Claude models are enabled in your GCP project.

---

## 🚀 Getting Started

```bash
git clone https://github.com/tuxerrante/SRESimulator.git
cd SRESimulator

# Configure environment (see LLM Setup above)
cp frontend/.env.local.example frontend/.env.local

# Install and run
make install
make dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Make targets

| Command          | Description                         |
| ---------------- | ----------------------------------- |
| `make install`   | Install all dependencies            |
| `make dev`       | Start Next.js dev server            |
| `make build`     | Build the production bundle         |
| `make lint`      | Run all linters                     |
| `make typecheck` | Run TypeScript type checking        |
| `make security`  | Run security audit + lockfile check |
| `make all`       | Full CI pipeline                    |
| `make clean`     | Remove build artifacts              |

---

## 📚 Documentation

- **[Architecture & Game Design](docs/ARCHITECTURE.md)** — project structure, tech stack, scoring system, investigation methodology, API routes
- **[CLAUDE.md](CLAUDE.md)** — original design document and game spec
