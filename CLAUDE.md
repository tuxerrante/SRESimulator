# Project: ARO SRE Simulator (The "Break-Fix" Game)

This file is the product/design memory for the repository.

For the living implementation view, prefer:

- `docs/ARCHITECTURE.md`
- `docs/AI_RUNTIME.md`
- `Makefile`

For explicit deploy/operator tasks, also use `docs/OPERATIONS.md`.
That includes AKS E2E refreshes, shared-edge hostname work, artifact verification, dev-only GHCR fallback tags, and rollback planning.

## 1. Mission & Philosophy

To gamify the Azure Red Hat OpenShift (ARO) reliability engineering experience. The system uses an AI Agent to "break" a cluster based on real-world incidents and guides a human user through the investigation using natural language, translating their intent into simulated technical commands (`oc`, `KQL`).

KQL and Geneva commands will only be shown and simulated because they cannot be run from the local machine.

**Core Pedagogical Principle:**
The game enforces the "Scientific Method of Investigation" as defined in the ARO Investigation Techniques guide. Users are scored not just on fixing the issue, but on following the proper phases: **Reading -> Context Gathering -> Facts Gathering -> Theory Building -> Action**.

---

## 2. Current Implementation Reality

### Frontend

- **Tech Stack:** TypeScript, React, Next.js, TailwindCSS.
- **Components:**
  - **Chat Interface:** Natural-language interaction with the AI agent.
  - **Terminal Output View:** Renders simulated `oc`/`kql`/`geneva` command output.
  - **Dashboard View:** A simulated "Geneva" or Azure-style context view for investigation clues.
  - **Scoring Overlay:** Real-time feedback on "SRE usage" (points for safety, deduction, efficiency).

### Backend

- **Local Server:** Node.js + Express.
- **Integrations:**
  - **AI Runtime:** Supports Vertex AI and Azure OpenAI, plus `AI_MOCK_MODE` for local simulation.
  - **Command Simulation:** Gameplay commands are generated and simulated by the backend during normal play.
  - **Scenario Manager:** Loads JSON scenario catalogs from `./scenarios`.
  - **Storage:** Uses JSON/in-memory locally and can use Azure SQL in deployed environments.

### Shared Project Layout

- `frontend/` - Next.js UI
- `backend/` - Express API server
- `shared/` - Cross-app types and helpers
- `scenarios/` - JSON scenario catalogs by difficulty
- `knowledge_base/` - Markdown files loaded into AI context
- `docs/` - Living technical docs
- `infra/` and `helm/` - deployment and environment infrastructure

## 3. Local Dev Workflow

- `make install` installs frontend/backend dependencies and project hooks.
- `make dev` starts the frontend on `http://localhost:3000`.
- Run the backend separately from `backend/` with `npm run dev` (default port `8080`).
- Frontend proxy/runtime settings live in `frontend/.env.local.example`.
- Backend AI/runtime settings live in `backend/.env.local.example`.
- Prefer `make` targets over ad-hoc commands for validation, tests, e2e, and deploy flows.

### Mandatory live browser gate

- Every pull request must pass a merge-blocking browser E2E gate before merge.
- Dependabot PRs use the separate `dependabot-e2e` status: a trusted
  default-branch workflow publishes SHA-bound images built by an unprivileged
  PR workflow, deploys the trusted chart with mock AI/JSON storage into a
  dedicated namespace claimed from a pre-provisioned pool, and uses a
  namespace-only Kubernetes identity that cannot create namespaces. It requires
  no Azure login, production secret, or manual environment approval. Provision
  or resize the pool with `make dependabot-e2e-pool`; see
  `docs/OPERATIONS.md`.
- Human-authored pull requests must pass the protected `live-e2e` GitHub
  check.
- The check deploys the PR head to an isolated temporary namespace and runs
  `make test-e2e-live` with isolated AKS, ARO Classic, and ARO HCP users in
  parallel. Each user must receive a distinct scenario.
- Do not call a PR merge-ready when this check is skipped, pending, or failed.
- The `live-e2e` GitHub Environment requires explicit approval before cluster
  and AI credentials are released to PR code. Review workflow, deploy, Helm,
  Dockerfile, and E2E-script changes carefully before approving the job.
- Fork PRs must be moved to a trusted same-repository branch before this
  privileged mandatory check can run.

## 4. Public-Only Safety Boundary

- Do not imply access to internal Red Hat or Azure systems unless a user explicitly provides that access in the current session.
- Treat Geneva and KQL outputs in this project as simulated. Only real `oc`/cluster interactions should be considered during explicit deployment/operator workflows.
- Use repository-local docs and public sources by default; label simulation-like behavior clearly.
- Never reveal secrets from local env files or infrastructure config. Redact sensitive values by default.

---

## 5. Game Mechanics & Difficulty Levels

### Level 1: "The Junior SRE" (Easy)

- **Focus:** Single-component failures, obvious symptoms.
- **Scenarios:**
  - **"The Sleeping Cluster":** Cluster was deallocated/powered off.
    - _Symptom:_ API pods offline, Nodes "Not Ready".
    - _Fix:_ Restart VMs, check etcd quorum.
  - **"Master Down":** A master node is deleted or in a failed state.
    - _Symptom:_ Missing master-2, indexing disturbed.
    - _Fix:_ Redeploy machine object or patch status to "Provisioned".
  - **"Invalid SKU":** Installation/Provisioning failed due to bad VM size.

### Level 2: "The Shift Lead" (Medium)

- **Focus:** Networking, permissions, and configuration drift.
- **Scenarios:**
  - **"The Secret Expired":** Image pull errors due to expired ARO operator pull secret.
    - _Symptom:_ `unauthorized` error on image pull.
    - _Fix:_ Rotate ACR token/secrets.
  - **"Bad Egress":** User changed `egressIP` breaking return traffic.
    - _Symptom:_ Login failure, API timeouts.
  - **"Permission Drift":** MCO broken because user changed `/etc` permissions to 755.

### Level 3: "The Principal Engineer" (Hard)

- **Focus:** Deep obscure bugs, race conditions, distributed system failures.
- **Scenarios:**
  - **"The Partition Hang":** Upgrade stuck because partition table update failed on nodes.
    - _Fix:_ Manual partition fix via debug shell.
  - **"Cosmos DB Flood":** Monitor service crashlooping causing region-wide throttling.
    - _Symptom:_ 429 errors, massive request spikes.
  - **"Etcd Quorum Loss":** Cascading control plane failure after power cycle.

---

## 6. The AI Agent Persona (The "Dungeon Master")

The AI acts as both the **Breaker** and the **Mentor**.

### Investigation Guidance (The Mentor)

When the user asks to "fix it," the AI must push back and enforce the workflow:

1. **Reading Phase:** Ask the user, "What inconsistencies do you see in the ticket?".
2. **Context Phase:** Encourage checking the simulated Geneva-style dashboards before touching commands.
   - _Hint:_ "Have you checked the cluster history or basic checks first in the dashboard context?".
3. **Facts Gathering:** Translate user intent into simulated KQL.
   - _User:_ "Show me who deleted the node."
   - _AI Action:_ Generate a simulated KQL query for `ClusterAuditLogs` looking for `Verb == "delete"` and `objectRef_resource == "nodes"`.
4. **Action Phase:** Verify safety. "Are you sure this is non-destructive? Is this reversible?".

### Command Translation (Natural Language -> CLI)

The AI maps user intent to specific tools defined in the "Tools" documentation.

- **Intent:** "Check logs for pod crashes."
- **Execution:** produce simulated command output for `oc get events --sort-by='.lastTimestamp'` or a simulated KQL query such as `ClusterLogs | where MESSAGE contains "error" ...`.

---

## 7. Scoring Metrics

- **Efficiency:** Number of commands run vs. optimal path.
- **Safety:** Did the user back up config? Did they check "Geneva" before SSH-ing?.

- **Documentation:** Did the user "Say what they do, do what they say"?.

- **Accuracy:** Was the root cause correctly identified (e.g., distinguishing between a "Network Issue" and a "Geneva Blip" )?
