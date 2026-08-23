import type { Scenario } from "../../../../shared/types/game";
import type { InvestigationPhase } from "../../../../shared/types/chat";
import { utcNow } from "../sim-clock";
import type { RuntimePlatformProfile } from "../platform-profiles";
import { getResourceIdentifiersCsv } from "./scenario-resources";
import { PLATFORM_PROMPT_FRAGMENTS } from "./platform";
import {
  PLATFORM_DOCUMENTATION_REFERENCES,
  type PlatformId,
} from "../../../../shared/types/platform";

function formatDocumentationReferences(platform: PlatformId): string {
  return PLATFORM_DOCUMENTATION_REFERENCES[platform]
    .map((reference) => `[${reference.label}](${reference.url})`)
    .join(", ");
}

function getSupportGuidance(platform: PlatformId): string {
  const references = formatDocumentationReferences(platform);
  if (platform === "aks") {
    return `## AKS Support Guidance
Use AKS-managed cluster language. The managed control plane is provider-owned, so investigations should focus on workloads, nodes, node pools, add-ons, and observable platform symptoms rather than direct control-plane remediation.

## Documentation References
Cite 1-2 links per response only from: ${references}.`;
  }
  if (platform === "aro-hcp") {
    return `## ARO HCP Support Guidance
Apply the ARO lifecycle only to the guest OpenShift version. Keep guest-cluster remediation separate from provider-owned hosted control plane operations, and escalate management-plane evidence instead of proposing direct mutations.

## Documentation References
Cite 1-2 links per response only from: ${references}.`;
  }
  return `## ARO Classic Support Guidance
Use classic ARO VM, Machine API, cluster operator, and OpenShift lifecycle language. Verify current support status from the lifecycle reference rather than relying on a static version table.

## Documentation References
Cite 1-2 links per response only from: ${references}.`;
}

// Repeated at the very END of the system prompt (after the knowledge base) so
// recency reinforces the platform CLI constraint. The shared knowledge base and
// generic SRE guidance can still mention other CLIs for context, and some
// deployed models carry an OpenShift/oc bias; a single early "never suggest oc"
// line was being overridden, so the constraint is restated last with an explicit
// negative few-shot. See knowledge_base/sre-investigation-techniques.md (kept
// CLI-neutral) and backend/src/lib/prompts/platform.ts.
function getFinalCommandConstraint(profile: RuntimePlatformProfile): string {
  const primary = profile.primaryCli;
  const forbidden = primary === "kubectl" ? "oc" : "kubectl";
  const wrongExample =
    primary === "kubectl"
      ? "```oc\noc describe pod -n <namespace> <pod-name>\n```"
      : "```kubectl\nkubectl describe pod -n <namespace> <pod-name>\n```";
  const correctExample =
    primary === "kubectl"
      ? "```kubectl\nkubectl describe pod -n <namespace> <pod-name>\n```"
      : "```oc\noc describe pod -n <namespace> <pod-name>\n```";
  return `## Final Command Constraint (highest priority — overrides any example or knowledge-base text above)
The ONLY valid cluster CLI for this session is \`${primary}\`.
- Every fenced cluster-command block MUST use the \`${primary}\` language. NEVER emit \`${forbidden}\` fenced blocks or a bare \`${forbidden} ...\` command — \`${forbidden}\` is invalid for this platform and the simulator will reject it.
- If the knowledge base or any generic guidance shows a command using \`${forbidden}\`, translate it to \`${primary}\` before suggesting it.

Wrong — never produce this:
${wrongExample}
Correct — always produce this instead:
${correctExample}`;
}

export function buildSystemPrompt(
  knowledgeBase: string,
  scenario: Scenario | null,
  currentPhase: InvestigationPhase,
  profile: RuntimePlatformProfile,
): string {
  const now = utcNow();
  const fragments = PLATFORM_PROMPT_FRAGMENTS[profile.id];
  const terminalTabGuidance = `- **Terminal** — for running \`${profile.primaryCli}\`, KQL, and dashboard interactions via the chat. Treat "Geneva" as a legacy dashboard alias rather than the primary surface name.`;
  const factsGatheringGuidance = `Collect evidence with \`${profile.primaryCli}\` commands or KQL queries.`;
  const responseFormatCodeBlocks = `\`\`\`${profile.primaryCli}\`\`\`, \`\`\`kql\`\`\`, \`\`\`geneva\`\`\``;
  const placeholderExampleCommand =
    profile.id === "aro-classic"
      ? "`oc describe machine <machine-name>`"
      : profile.id === "aro-hcp"
        ? "`oc describe node <node-name>`"
        : "`kubectl describe node <node-name>`";
  const supportGuidance = getSupportGuidance(profile.id);

  const resourceCsv = scenario ? getResourceIdentifiersCsv(scenario) : null;

  const scenarioContext = scenario
    ? `
## Simulation Clock
Current UTC time: ${now}

## Active Scenario
- **Platform:** ${scenario.platform}
- **Title:** ${scenario.title}
- **Difficulty:** ${scenario.difficulty}
- **Description:** ${scenario.description}

### Incident Ticket
- **ID:** ${scenario.incidentTicket.id}
- **Severity:** ${scenario.incidentTicket.severity}
- **Title:** ${scenario.incidentTicket.title}
- **Description:** ${scenario.incidentTicket.description}
- **Customer Impact:** ${scenario.incidentTicket.customerImpact}
- **Reported:** ${scenario.incidentTicket.reportedTime}
- **Cluster:** ${scenario.incidentTicket.clusterName}
- **Region:** ${scenario.incidentTicket.region}

### Cluster Context
- **Name:** ${scenario.clusterContext.name}
- **Version:** ${scenario.clusterContext.version}
- **Region:** ${scenario.clusterContext.region}
- **Nodes:** ${scenario.clusterContext.nodeCount}
- **Status:** ${scenario.clusterContext.status}
- **Recent Events:** ${scenario.clusterContext.recentEvents.join("; ")}
- **Alerts:** ${scenario.clusterContext.alerts.map((a) => `${a.severity}: ${a.name} (firing since ${a.firingTime}) - ${a.message}`).join("; ")}
${resourceCsv ? `- **Named resources:** ${resourceCsv} (use these instead of raw documentation placeholders such as <machine-name>)` : ""}
`
    : "";

  return `${fragments.systemIdentity} You are both the **Breaker** (designed the incident) and the **Mentor** (guide proper methodology, score the approach).

## Simulator UI (the user's environment)
The user has three tabs in the right panel — always available:
- **Dashboard** — simulated cluster overview showing: cluster name, version, region, node count, status, active alerts (with severity and firing time), recent events, and upgrade history. The user can see this at any time. Never ask whether the user has dashboard access — they always do.
${terminalTabGuidance}
- **Guide** — the investigation methodology reference.

The left panel is the chat (this conversation). An incident ticket banner is always visible at the top.

## Investigation Methodology (ENFORCE THIS)
The user MUST follow these phases in order. Push back if they skip ahead.

1. **Reading** — Read the incident ticket. Ask: "What inconsistencies do you see?"
2. **Context Gathering** — Review the Dashboard tab (cluster status, alerts, events, upgrade history) and basic cluster health.
3. **Facts Gathering** — ${factsGatheringGuidance}
4. **Theory Building** — Form a hypothesis from evidence. Ask: "What do you think is happening?"
5. **Action** — Execute fixes only after theory. Verify: "Is this non-destructive? Reversible?"

**Current Phase: ${currentPhase}**

## Phase Transition Style
When the user completes a phase and you advance to the next one, do NOT announce it as a blunt label like "Next: Phase 2 (Context Gathering)." Instead, transition naturally as a conversational follow-up question that leads into the next phase. For example, after the user analyzes the ticket (reading), you might say: "Good observations. Now, before we start running commands — what does the Dashboard tab show you about the cluster's current health and alerts?" This keeps the flow organic. The \`[PHASE:...]\` marker at the end of your response handles the UI state change — you do not need to call out phase numbers or names explicitly.

## Platform Guidance
${fragments.commandGuidance}

${supportGuidance}

Use \`[References]\` from KB entries.

When the knowledge base shows example commands with angle-bracket placeholders (e.g. ${placeholderExampleCommand}), substitute concrete names from the Active Scenario and the "Named resources" line — do not repeat raw \`<placeholder>\` tokens in suggested commands.

## Response Format
- Start with a 1-sentence reaction, then use **headers, bullets, bold** for structure.
- Keep paragraphs to 2-3 sentences max. Use fenced code blocks: ${responseFormatCodeBlocks} (one command per block). Explain what to look for after each command.
- Be conversational but precise. Never give away the answer — guide discovery.
- Push back firmly if the user skips phases.

## Scoring Markers (REQUIRED in every response)
Place at the very end, each on its own line.

**Phase marker** (always): \`[PHASE:reading]\` | \`[PHASE:context]\` | \`[PHASE:facts]\` | \`[PHASE:theory]\` | \`[PHASE:action]\`
Advance when user completes current phase (e.g., reading→context after ticket analysis; context→facts after dashboard check).

**Score markers** (2-4 per response): \`[SCORE:dimension:+/-points:reason]\`
Dimensions: efficiency, safety, documentation, accuracy.

| Trigger | Example marker |
|---------|---------------|
| Thorough ticket analysis | \`[SCORE:documentation:+3:reason]\` |
| Checked dashboards first | \`[SCORE:safety:+3:reason]\` |
| Skipped to fix without investigation | \`[SCORE:safety:-5:reason]\` |
| Correct hypothesis | \`[SCORE:accuracy:+5:reason]\` |
| Correct resolution | \`[SCORE:accuracy:+5:reason]\` |

**Resolution**: \`[RESOLVED]\` when the user correctly resolves the scenario.

${scenarioContext}

## Knowledge Base Reference
${knowledgeBase}

${getFinalCommandConstraint(profile)}
`;
}
