import { describe, expect, it } from "vitest";
import {
  generateMockScenario,
  generateMockChatResponse,
  generateMockCommandOutput,
} from "./mock-ai";

describe("generateMockScenario", () => {
  it("returns a valid scenario for each difficulty", () => {
    for (const difficulty of ["easy", "medium", "hard"] as const) {
      const scenario = generateMockScenario(difficulty);

      expect(scenario.id).toBe(`scenario_mock_${difficulty}`);
      expect(scenario.difficulty).toBe(difficulty);
      expect(scenario.incidentTicket.clusterName).toBe(
        scenario.clusterContext.name
      );
      expect(scenario.clusterContext.alerts.length).toBeGreaterThan(0);
      expect(scenario.clusterContext.recentEvents.length).toBeGreaterThan(0);
    }
  });

  it("uses Sev4 for easy, Sev3 for medium, Sev2 for hard", () => {
    expect(generateMockScenario("easy").incidentTicket.severity).toBe("Sev4");
    expect(generateMockScenario("medium").incidentTicket.severity).toBe("Sev3");
    expect(generateMockScenario("hard").incidentTicket.severity).toBe("Sev2");
  });

  it("scales node count by difficulty", () => {
    expect(generateMockScenario("easy").clusterContext.nodeCount).toBe(6);
    expect(generateMockScenario("medium").clusterContext.nodeCount).toBe(9);
    expect(generateMockScenario("hard").clusterContext.nodeCount).toBe(12);
  });

  it("generates reportedTime within the past 1-7 days", () => {
    const scenario = generateMockScenario("easy");
    const reported = new Date(scenario.incidentTicket.reportedTime).getTime();
    const now = Date.now();
    const oneDayMs = 86_400_000;

    expect(reported).toBeLessThanOrEqual(now - oneDayMs);
    expect(reported).toBeGreaterThanOrEqual(now - 7 * oneDayMs);
  });

  it("uses critical severity alert for hard difficulty", () => {
    expect(generateMockScenario("hard").clusterContext.alerts[0].severity).toBe(
      "critical"
    );
    expect(
      generateMockScenario("easy").clusterContext.alerts[0].severity
    ).toBe("warning");
  });
});

describe("generateMockChatResponse", () => {
  it("includes phase and score markers", () => {
    const response = generateMockChatResponse("context");
    expect(response).toContain("[PHASE:context]");
    expect(response).toContain("[SCORE:efficiency:+1:");
    expect(response).toContain("Mock AI mode is enabled");
  });

  it("falls back to reading when phase is falsy", () => {
    const response = generateMockChatResponse(
      "" as unknown as "reading"
    );
    expect(response).toContain("[PHASE:reading]");
  });
});

describe("generateMockCommandOutput", () => {
  it("returns node-table output for oc get nodes", () => {
    const output = generateMockCommandOutput("oc get nodes", "oc");
    expect(output).toContain("master-0");
    expect(output).toContain("mock command received: oc get nodes");
  });

  it("returns describe-style output for oc describe node", () => {
    const output = generateMockCommandOutput("oc describe node master-1", "oc");
    expect(output).toContain("Name:");
    expect(output).toContain("master-1");
    expect(output).toContain("Conditions:");
    expect(output).toContain("Ready");
    expect(output).not.toContain("mock command received");
  });

  it("returns describe-style output for oc describe pod", () => {
    const output = generateMockCommandOutput("oc describe pod my-pod", "oc");
    expect(output).toContain("Name:");
    expect(output).toContain("my-pod");
    expect(output).toContain("Containers:");
    expect(output).toContain("Events:");
  });

  it("returns generic describe for oc describe <other>", () => {
    const output = generateMockCommandOutput("oc describe service api-svc", "oc");
    expect(output).toContain("Name:");
    expect(output).toContain("api-svc");
  });

  it("returns delete confirmation for oc delete", () => {
    const output = generateMockCommandOutput("oc delete machine aro-worker-0", "oc");
    expect(output).toBe('machine "aro-worker-0" deleted');
  });

  it("handles oc delete with --force flags", () => {
    const output = generateMockCommandOutput(
      "oc delete machine aro-worker-0 --force --grace-period=0",
      "oc"
    );
    expect(output).toBe('machine "aro-worker-0" deleted');
  });

  it("returns log lines for oc logs", () => {
    const output = generateMockCommandOutput("oc logs my-pod -c main", "oc");
    expect(output).toContain("server.go");
    expect(output).toContain("controller.go");
    expect(output.split("\n").length).toBeGreaterThanOrEqual(3);
  });

  it("returns JSON for oc get with -o jsonpath", () => {
    const output = generateMockCommandOutput(
      "oc get node master-0 -o jsonpath='{.status.conditions}'",
      "oc"
    );
    expect(output).toContain("Ready");
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it("returns machine list for oc get machines", () => {
    const output = generateMockCommandOutput("oc get machines -A", "oc");
    expect(output).toContain("PHASE");
    expect(output).toContain("Running");
    expect(output).toContain("aro-mock-master-0");
  });

  it("returns events for oc get events", () => {
    const output = generateMockCommandOutput("oc get events --sort-by='.lastTimestamp'", "oc");
    expect(output).toContain("LAST SEEN");
    expect(output).toContain("Warning");
  });

  it("returns kql-style output for kql type", () => {
    const output = generateMockCommandOutput("ClusterLogs", "kql");
    expect(output).toContain("TimeGenerated");
    expect(output).toContain("mock query received: ClusterLogs");
  });

  it("returns geneva-style output for geneva type", () => {
    const output = generateMockCommandOutput("dashboard", "geneva");
    expect(output).toContain("Dashboard: Mock Geneva View");
    expect(output).toContain("mock command received: dashboard");
  });
});
