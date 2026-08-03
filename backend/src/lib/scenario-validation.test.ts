import { describe, expect, it } from "vitest";
import type { Scenario } from "../../../shared/types/game";
import {
  getPlatformContentViolation,
  isPlatformContextForPlatform,
  isScenario,
} from "./scenario-validation";

function makeScenario(platform: Scenario["platform"]): Scenario {
  return {
    id: `scenario-${platform}`,
    platform,
    title: "Platform-scoped incident",
    difficulty: "easy",
    description: "A platform-appropriate workload issue",
    incidentTicket: {
      id: "IcM-test",
      severity: "Sev3",
      title: "Workload unavailable",
      description: "A workload is unavailable",
      customerImpact: "Requests fail",
      reportedTime: "2026-08-01T10:00:00.000Z",
      clusterName: "test-cluster",
      region: "eastus2",
    },
    clusterContext: {
      name: "test-cluster",
      version: platform === "aks" ? "1.31.2" : "4.18.12",
      region: "eastus2",
      nodeCount: 3,
      status: "Degraded",
      recentEvents: ["Workload health check failed"],
      alerts: [],
      upgradeHistory: [],
    },
  };
}

describe("platform scenario validation", () => {
  it("accepts only platform-specific context keys", () => {
    expect(
      isPlatformContextForPlatform(
        { managedResourceGroupHint: "MC_test", nodePoolNames: ["system"] },
        "aks",
      ),
    ).toBe(true);
    expect(
      isPlatformContextForPlatform({ machineNames: ["master-0"] }, "aks"),
    ).toBe(false);
    expect(
      isPlatformContextForPlatform(
        {
          guestClusterName: "guest",
          hostedControlPlaneNamespace: "clusters-guest",
        },
        "aro-hcp",
      ),
    ).toBe(true);
    expect(
      isPlatformContextForPlatform({ machineNames: ["master-0"] }, "aro-hcp"),
    ).toBe(false);
  });

  it("detects cross-platform issue vocabulary", () => {
    expect(
      getPlatformContentViolation(
        { description: "Run oc get machines for this OpenShift issue" },
        "aks",
      ),
    ).toBe("ARO or OpenShift");
    expect(
      getPlatformContentViolation(
        { description: "Use machine-config to repair a master VM" },
        "aro-hcp",
      ),
    ).toBe("classic master VM");
    expect(
      getPlatformContentViolation(
        { description: "Run kubectl get pods on this AKS cluster" },
        "aro-hcp",
      ),
    ).toBe("AKS");
  });

  it("rejects an AKS scenario containing OpenShift guidance", () => {
    const scenario = makeScenario("aks");
    scenario.description = "An OpenShift MachineConfig rollout failed";

    expect(isScenario(scenario)).toBe(false);
  });

  it("accepts platform-appropriate scenarios", () => {
    expect(isScenario(makeScenario("aro-classic"))).toBe(true);
    expect(isScenario(makeScenario("aro-hcp"))).toBe(true);
    expect(isScenario(makeScenario("aks"))).toBe(true);
  });

  it("rejects AKS vocabulary in an HCP scenario", () => {
    const scenario = makeScenario("aro-hcp");
    scenario.description = "An AKS node pool requires kubectl investigation";

    expect(isScenario(scenario)).toBe(false);
  });
});
