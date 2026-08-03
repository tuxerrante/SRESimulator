import { describe, expect, it } from "vitest";
import type { Scenario } from "../../../shared/types/game";
import { validateSessionScenario } from "./session-scenario";

const scenario: Scenario = {
  id: "aks-easy",
  platform: "aks",
  title: "AKS image pull failure",
  difficulty: "easy",
  description: "An AKS workload cannot pull its image",
  incidentTicket: {
    id: "IcM-test",
    severity: "Sev3",
    title: "Image pull failure",
    description: "Pods cannot pull an image",
    customerImpact: "Workload unavailable",
    reportedTime: "2026-08-01T10:00:00.000Z",
    clusterName: "aks-test",
    region: "eastus2",
  },
  clusterContext: {
    name: "aks-test",
    version: "1.31.2",
    region: "eastus2",
    nodeCount: 3,
    status: "Degraded",
    recentEvents: [],
    alerts: [],
    upgradeHistory: [],
  },
};

describe("validateSessionScenario", () => {
  it("rejects a scenario from another platform", () => {
    const result = validateSessionScenario(
      {
        platform: "aro-classic",
        scenarioPayload: null,
        scenarioTitle: scenario.title,
        difficulty: scenario.difficulty,
        scenarioId: scenario.id,
      },
      scenario,
    );

    expect(result).toEqual({
      ok: false,
      error: "Scenario does not match the active session",
    });
  });
});
