import { describe, expect, it } from "vitest";
import type { Scenario } from "../../../../shared/types/game";
import {
  extractResourceIdentifiers,
  getResourceIdentifiersCsv,
  resolveAngleBracketPlaceholders,
} from "./scenario-resources";

function makeScenario(overrides?: Partial<Scenario>): Scenario {
  return {
    id: "scenario_test",
    title: "Worker Node NotReady",
    difficulty: "easy",
    description: "A worker node has gone NotReady due to DiskPressure",
    incidentTicket: {
      id: "IcM-900327",
      severity: "Sev3",
      title: "Pods stuck Pending after node went NotReady",
      description: "Customer reports pods stuck Pending",
      customerImpact: "Reduced capacity",
      reportedTime: "2026-03-23T10:52:18Z",
      clusterName: "aro-prod-payments-eus2-01",
      region: "eastus2",
    },
    clusterContext: {
      name: "aro-prod-payments-eus2-01",
      version: "4.18.6",
      region: "eastus2",
      nodeCount: 6,
      status: "Degraded: 1/3 worker nodes NotReady (DiskPressure); control plane healthy",
      recentEvents: [
        "2026-03-27T12:41:03Z Warning NodeHasDiskPressure node/worker-eastus2-2 has disk pressure",
      ],
      alerts: [
        {
          name: "KubeNodeNotReady",
          severity: "critical",
          message: "Node worker-eastus2-2 is not ready",
          firingTime: "2026-03-27T12:44:30Z",
        },
      ],
      upgradeHistory: [],
    },
    ...overrides,
  };
}

describe("extractResourceIdentifiers", () => {
  it("collects node/… paths from events", () => {
    const ids = extractResourceIdentifiers(makeScenario());
    expect(ids).toContain("worker-eastus2-2");
  });

  it("includes cluster name when valid", () => {
    const ids = extractResourceIdentifiers(makeScenario());
    expect(ids).toContain("aro-prod-payments-eus2-01");
  });
});

describe("getResourceIdentifiersCsv", () => {
  it("includes cluster name even when alerts and events are empty", () => {
    const s = makeScenario({
      clusterContext: {
        ...makeScenario().clusterContext,
        recentEvents: [],
        alerts: [],
        status: "OK",
      },
    });
    expect(getResourceIdentifiersCsv(s)).toContain("aro-prod-payments-eus2-01");
  });
});

describe("resolveAngleBracketPlaceholders", () => {
  it("replaces machine-name-for-worker-N using extracted worker names", () => {
    const cmd =
      "oc describe machine -n openshift-machine-api <machine-name-for-worker-1>";
    const resolved = resolveAngleBracketPlaceholders(cmd, makeScenario());
    expect(resolved).not.toContain("<");
    expect(resolved).toContain("worker-eastus2-2");
  });

  it("maps worker-2 placeholder to the second sorted worker-like identifier", () => {
    const s = makeScenario({
      clusterContext: {
        ...makeScenario().clusterContext,
        recentEvents: [],
        status: "Degraded",
        alerts: [
          {
            name: "A",
            severity: "warning" as const,
            message: "Node worker-bbb is not ready",
            firingTime: "2026-03-27T12:00:00Z",
          },
          {
            name: "B",
            severity: "warning" as const,
            message: "Node worker-aaa is not ready",
            firingTime: "2026-03-27T12:01:00Z",
          },
        ],
      },
    });
    const cmd = "oc describe machine <machine-name-for-worker-2>";
    const resolved = resolveAngleBracketPlaceholders(cmd, s);
    expect(resolved).toContain("worker-bbb");
  });

  it("leaves commands without placeholders unchanged", () => {
    const cmd = "oc get nodes";
    expect(resolveAngleBracketPlaceholders(cmd, makeScenario())).toBe(cmd);
  });

  it("returns original when scenario is null", () => {
    const cmd = "oc describe machine <x>";
    expect(resolveAngleBracketPlaceholders(cmd, null)).toBe(cmd);
  });
});
