# Project: ARO SRE Simulator (The "Break-Fix" Game)

For the living implementation view, also see `docs/ARCHITECTURE.md`.

## 1. Mission & Philosophy

To gamify the Azure Red Hat OpenShift (ARO) reliability engineering experience. The system uses an AI Agent to "break" a cluster based on real-world incidents and guides a human user through the investigation using natural language, translating their intent into technical commands (`oc`, `KQL`).

KQL and Geneva commands will be only shown and simulated, since they cannot be run from the local machine.

**Core Pedagogical Principle:**
The game enforces the "Scientific Method of Investigation" as defined in the ARO Investigation Techniques guide. Users are scored not just on fixing the issue, but on following the proper phases: **Reading -> Context Gathering -> Facts Gathering -> Theory Building -> Action**.

---

## 2. System Architecture

### Frontend (The "Cockpit")

- **Tech Stack:** TypeScript, React (Next.js), TailwindCSS.
- **Components:**
  - **Chat Interface:** For natural language interaction with the AI Agent.
  - **Terminal Emulator:** (e.g., `xterm.js`) To display the execution of `oc` commands and raw logs.
  - **Dashboard View:** A simulated "Geneva" or "Azure Portal" view for context gathering.
  - **Scoring Overlay:** Real-time feedback on "SRE usage" (points for safety, deduction, efficiency).

### Backend (The "Engine")

- **Local Server:** Node.js or Python (FastAPI).
- **Integrations:**
  - **Cluster Connection:** Uses local `KUBECONFIG` to execute commands against the target cluster.
  - **LLM Provider:** API hooks for Claude Code / Gemini.
  - **Scenario Manager:** Loads scripts from the `./scenarios` folder to inject faults.

---

## 3. Game Mechanics & Difficulty Levels

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

## 4. The AI Agent Persona (The "Dungeon Master")

The AI acts as both the **Breaker** and the **Mentor**.

### Investigation Guidance (The Mentor)

When the user asks to "fix it," the AI must push back and enforce the workflow:

1. **Reading Phase:** Ask the user, "What inconsistencies do you see in the ticket?".
2. **Context Phase:** Encourage checking "Geneva" dashboards before touching `kubectl`.
   - _Hint:_ "Have you checked the cluster history or basic checks first?".
3. **Facts Gathering:** Translate user intent into KQL.
   - _User:_ "Show me who deleted the node."
   - _AI Action:_ Generate KQL for `ClusterAuditLogs` looking for `Verb == "delete"` and `objectRef_resource == "nodes"`.
4. **Action Phase:** Verify safety. "Are you sure this is non-destructive? Is this reversible?".

### Command Translation (Natural Language -> CLI)

The AI maps user intent to specific tools defined in the "Tools" documentation.

- **Intent:** "Check logs for pod crashes."
- **Execution:** `oc get events --sort-by='.lastTimestamp'` OR KQL: `ClusterLogs | where MESSAGE contains "error" ...`.

---

## 5. Directory Structure

```text
/
├── CLAUDE.md              # This design file
├── /frontend              # TypeScript/Next.js UI
├── /backend               # Local server for cluster connection
├── /scenarios             # The "Breaks"
│   ├── /easy
│   │   ├── scenario_001_master_down.yaml
│   │   └── solution_001.sh
│   ├── /medium
│   │   └── ...
│   └── /hard
│       └── ...
└── /knowledge_base        # RAG context
    ├── kusto_queries.md   #
    ├── investigation.md   #
    └── alerts.md          #
```

## 6. Scoring Metrics

- **Efficiency:** Number of commands run vs. optimal path.
- **Safety:** Did the user back up config? Did they check "Geneva" before SSH-ing?.

- **Documentation:** Did the user "Say what they do, do what they say"?.

- **Accuracy:** Was the root cause correctly identified (e.g., distinguishing between a "Network Issue" and a "Geneva Blip" )?

---

### Answer to your UI Question

**Q: Would it be possible to connect both the cluster and the LLM agent from a nice TypeScript local UI?**

**A: Yes, absolutely.** This is the ideal architecture for this tool.

You should use a **TypeScript/Electron** app or a local **Next.js** application. Here is how the connections would work:

1. **The Terminal Interface (`xterm.js`):**
    You don't need to re-implement a shell. You can embed `xterm.js` in your React UI. The frontend sends the AI-generated command (e.g., `oc get nodes`) to your local Node.js backend. The backend spawns a child process using the user's existing local shell (which already has the `KUBECONFIG` and `oc` binary loaded), executes the command, and streams the stdout/stderr back to the frontend.

2. **The LLM Integration:**
    The Frontend captures the user's natural language input (e.g., _"Why is the API server down?"_). It sends this to the LLM (Gemini/Claude) along with a system prompt containing the `CLAUDE.md` context and the `kusto_queries.md` content. The LLM returns a JSON object containing the suggested command and the explanation.

3. **The "Geneva" Simulation:**
    Since you likely cannot grant the game actual access to Microsoft's internal "Geneva" dashboards, your UI can simulate this. When the user asks to "Check Geneva," the LLM can generate a query based on the **Kusto Tables** file, run it against the cluster's log endpoint (if available) or a mock dataset, and render a graph in the UI using a library like **Recharts**.

### Next Step

Would you like me to generate the **Scenario 001 (Easy): "The Sleeping Cluster"** script and its corresponding solution file to populate your `/scenarios/easy` folder?
