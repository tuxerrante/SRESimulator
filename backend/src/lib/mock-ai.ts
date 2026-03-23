import type { InvestigationPhase } from "../../../shared/types/chat";
import type { Difficulty, Scenario } from "../../../shared/types/game";

const REGION = "eastus";

function nowIso(offsetMinutes: number): string {
  return new Date(Date.now() + offsetMinutes * 60 * 1000).toISOString();
}

function recentDaysAgoIso(minDays = 1, maxDays = 7): string {
  const lo = Math.max(0, Math.min(minDays, maxDays));
  const hi = Math.max(minDays, maxDays);
  const days = lo + Math.floor(Math.random() * (hi - lo + 1));
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function severityForDifficulty(difficulty: Difficulty): "Sev2" | "Sev3" | "Sev4" {
  if (difficulty === "hard") return "Sev2";
  if (difficulty === "medium") return "Sev3";
  return "Sev4";
}

export function generateMockScenario(difficulty: Difficulty): Scenario {
  const clusterName = `aro-${difficulty}-mock`;
  return {
    id: `scenario_mock_${difficulty}`,
    title: `Mock ${difficulty.toUpperCase()} scenario`,
    difficulty,
    description:
      "Mock AI mode scenario used to validate cluster deployment wiring.",
    incidentTicket: {
      id: `IcM-MOCK-${difficulty.toUpperCase()}`,
      severity: severityForDifficulty(difficulty),
      title: `Mock incident for ${difficulty} difficulty`,
      description:
        "This ticket is generated in AI mock mode to validate end-to-end plumbing.",
      customerImpact:
        "No customer impact. This is a non-production mock validation scenario.",
      reportedTime: recentDaysAgoIso(),
      clusterName,
      region: REGION,
    },
    clusterContext: {
      name: clusterName,
      version: "4.19.9",
      region: REGION,
      nodeCount: difficulty === "easy" ? 6 : difficulty === "medium" ? 9 : 12,
      status: "Degraded (mock)",
      recentEvents: [
        `${nowIso(-40)} - monitor: mock alert triggered`,
        `${nowIso(-35)} - kubelet: probe timeout observed`,
      ],
      alerts: [
        {
          name: "MockProbeFailure",
          severity: difficulty === "hard" ? "critical" : "warning",
          message: "Mock AI mode alert to validate UI and command path.",
          firingTime: nowIso(-25),
        },
      ],
      upgradeHistory: [
        {
          from: "4.19.8",
          to: "4.19.9",
          status: "completed",
          timestamp: nowIso(-180),
        },
      ],
    },
  };
}

export function generateMockChatResponse(phase: InvestigationPhase): string {
  const markerPhase = phase || "reading";
  return [
    "**Mock AI mode is enabled.**",
    "",
    "The backend is reachable and chat streaming works, but no live Vertex call is performed.",
    "",
    "**Next step:** use `/api/ai/probe?live=true` with AI_MOCK_MODE disabled to verify real connectivity.",
    "",
    `[PHASE:${markerPhase}]`,
    "[SCORE:efficiency:+1:Validated mock AI chat path]",
  ].join("\n");
}

export function generateMockCommandOutput(
  command: string,
  type: "oc" | "kql" | "geneva"
): string {
  if (type === "oc") {
    return [
      "NAME                                   STATUS   ROLES    AGE   VERSION",
      "master-0                               Ready    master   90d   v1.30.4+mock",
      "master-1                               Ready    master   90d   v1.30.4+mock",
      "worker-0                               Ready    worker   90d   v1.30.4+mock",
      "",
      `# mock command received: ${command}`,
    ].join("\n");
  }

  if (type === "kql") {
    return [
      "TimeGenerated                Level    Message",
      `${nowIso(-12)}    Warning  Mock probe event`,
      `${nowIso(-10)}    Info     Command path validated`,
      "",
      `// mock query received: ${command}`,
    ].join("\n");
  }

  return [
    "Dashboard: Mock Geneva View",
    `LastUpdated: ${nowIso(-5)}`,
    "Status: healthy (mock)",
    "",
    `# mock command received: ${command}`,
  ].join("\n");
}
