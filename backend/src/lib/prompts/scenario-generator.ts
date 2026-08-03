import {
  PLATFORM_PROFILES,
  type PlatformId,
} from "../../../../shared/types/platform";
import { PLATFORM_PROMPT_FRAGMENTS } from "./platform";

function getPlatformContextTemplate(platform: PlatformId): string {
  if (platform === "aks") {
    return `{
    "nodePoolNames": ["AKS node pool names"],
    "managedResourceGroupHint": "optional AKS managed resource group hint",
    "addonContext": ["optional AKS add-on context"]
  }`;
  }
  if (platform === "aro-hcp") {
    return `{
    "routeNames": ["optional guest-cluster route names"],
    "guestClusterName": "ARO HCP guest cluster name",
    "hostedControlPlaneNamespace": "provider-owned hosted control plane namespace",
    "controlPlaneBoundaryNotes": ["guest versus management-plane ownership"],
    "nodePoolNames": ["ARO HCP node pool names"]
  }`;
  }
  return `{
    "machineNames": ["ARO Classic machine names"],
    "routeNames": ["optional OpenShift route names"],
    "clusterOperatorHints": ["optional ARO Classic cluster operators"]
  }`;
}

export function buildScenarioGenerationPrompt(input: {
  platform: PlatformId;
  difficulty: "easy" | "medium" | "hard";
  currentDate: string;
  scenarioContext: string;
}): string {
  const { platform, difficulty, currentDate, scenarioContext } = input;
  const profile = PLATFORM_PROFILES[platform];
  const fragments = PLATFORM_PROMPT_FRAGMENTS[platform];
  const platformContextTemplate = getPlatformContextTemplate(platform);
  const versionGuidance =
    platform === "aks"
      ? "Use currently supported AKS and upstream Kubernetes version language around 1.30-1.31."
      : "Use currently supported ARO/OpenShift versions (4.16-4.20). For easy scenarios, 4.15 may appear only when the lesson is to recommend an upgrade.";

  return `You are a scenario generator for the SRE Simulator.
Generate a realistic ${platform} incident scenario. Be concise.
The scenario should be appropriate for the "${difficulty}" difficulty level.

Platform profile:
- Label: ${profile.label}
- Primary CLI: ${profile.primaryCli}
- Guidance: ${fragments.scenarioGenerationGuidance}

Difficulty guidelines:
- easy: Single-component failures, obvious symptoms, fast first clues.
- medium: Networking, permissions, configuration drift, or multi-component interactions.
- hard: Deep obscure bugs, race conditions, distributed system failures, or cascading failures.

Platform guidance:
- ${fragments.docsReferences}
- ${fragments.commandGuidance}
- ${versionGuidance}
- Keep the scenario self-contained and repo-owned. Do not reference external authoring systems or internal-only tooling.
- The scenario MUST declare platform="${platform}" and difficulty="${difficulty}".

IMPORTANT — timestamps: The current date/time is ${currentDate}. Generate realistic ISO 8601 timestamps — incident reportedTime should be within the past 1-7 days, while recentEvents and alert firingTimes should be more recent (minutes to hours ago) to feel like a live incident. Upgrade history timestamps can be older. Do NOT use placeholders or obviously fake dates.

IMPORTANT: Respond with ONLY valid JSON matching this exact structure (no markdown, no code fences):
{
  "id": "scenario_xxx",
  "platform": "${platform}",
  "title": "Short descriptive title",
  "difficulty": "${difficulty}",
  "description": "Brief description of what's wrong (for AI context, not shown to user directly)",
  "incidentTicket": {
    "id": "IcM-XXXXXX",
    "severity": "Sev1|Sev2|Sev3|Sev4",
    "title": "Customer-facing incident title",
    "description": "What the customer or monitoring reported",
    "customerImpact": "Description of impact",
    "reportedTime": "ISO 8601 timestamp within the past 1-7 days",
    "clusterName": "realistic-cluster-name",
    "region": "azure-region"
  },
  "clusterContext": {
    "name": "same-cluster-name",
    "version": "platform-appropriate version",
    "region": "same-azure-region",
    "nodeCount": number,
    "status": "current status",
    "recentEvents": ["array of recent cluster events with ISO timestamps"],
    "alerts": [{"name": "alert name", "severity": "critical|warning|info", "message": "alert message", "firingTime": "ISO timestamp"}],
    "upgradeHistory": [{"from": "version", "to": "version", "status": "completed|failed|in_progress", "timestamp": "ISO timestamp"}]
  },
  "platformContext": ${platformContextTemplate}
}

Reference incidents and alerts:
${scenarioContext}`;
}
