import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Scenario } from "../../../../shared/types/game";
import { buildScenarioContext, buildSimNow, buildCommandSystemPrompt } from "./command";

const FIXED_NOW = new Date("2026-03-27T14:00:00.000Z");

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
        "2026-03-27T12:42:15Z Warning Evicted pod/payments-api-7h76b back-off restarting",
      ],
      alerts: [
        {
          name: "KubeNodeNotReady",
          severity: "critical",
          message: "Node worker-eastus2-2 is not ready",
          firingTime: "2026-03-27T12:44:30Z",
        },
        {
          name: "NodeDiskPressure",
          severity: "warning",
          message: "worker-eastus2-2 has DiskPressure condition",
          firingTime: "2026-03-27T12:41:00Z",
        },
      ],
      upgradeHistory: [
        { from: "4.17.14", to: "4.18.6", status: "completed", timestamp: "2026-03-10T08:00:00Z" },
      ],
    },
    ...overrides,
  };
}

describe("buildScenarioContext", () => {
  it("returns fallback text when scenario is null", () => {
    const ctx = buildScenarioContext(null);
    expect(ctx).toBe("No specific scenario context available.");
  });

  it("includes title and difficulty", () => {
    const ctx = buildScenarioContext(makeScenario());
    expect(ctx).toContain("Worker Node NotReady (easy)");
  });

  it("includes cluster name, version, status, and node count", () => {
    const ctx = buildScenarioContext(makeScenario());
    expect(ctx).toContain("aro-prod-payments-eus2-01");
    expect(ctx).toContain("version 4.18.6");
    expect(ctx).toContain("Nodes: 6");
    expect(ctx).toContain("Degraded");
  });

  it("includes ticket reportedTime", () => {
    const ctx = buildScenarioContext(makeScenario());
    expect(ctx).toContain("Ticket reported: 2026-03-23T10:52:18Z");
  });

  it("includes alert names with firing times", () => {
    const ctx = buildScenarioContext(makeScenario());
    expect(ctx).toContain("KubeNodeNotReady (firing since 2026-03-27T12:44:30Z)");
    expect(ctx).toContain("NodeDiskPressure (firing since 2026-03-27T12:41:00Z)");
  });

  it("includes alert messages", () => {
    const ctx = buildScenarioContext(makeScenario());
    expect(ctx).toContain("Node worker-eastus2-2 is not ready");
    expect(ctx).toContain("DiskPressure condition");
  });

  it("joins multiple alerts with semicolons", () => {
    const ctx = buildScenarioContext(makeScenario());
    const alertLine = ctx.split("\n").find((l) => l.startsWith("Alerts:"));
    expect(alertLine).toBeDefined();
    expect(alertLine!.split(";").length).toBe(2);
  });

  it("includes recent events", () => {
    const ctx = buildScenarioContext(makeScenario());
    expect(ctx).toContain("NodeHasDiskPressure");
    expect(ctx).toContain("Evicted");
  });

  it("includes description", () => {
    const ctx = buildScenarioContext(makeScenario());
    expect(ctx).toContain("A worker node has gone NotReady due to DiskPressure");
  });

  it("includes named resources when identifiers can be derived from the scenario", () => {
    const ctx = buildScenarioContext(makeScenario());
    expect(ctx).toContain("Named resources");
    expect(ctx).toContain("worker-eastus2-2");
  });
});

describe("buildSimNow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses current UTC clock, not reportedTime, as the temporal anchor", () => {
    const result = buildSimNow("2026-03-23T10:52:18Z");
    expect(result).toContain("The current UTC time is 2026-03-27T14:00:00.000Z");
  });

  it("includes the original reportedTime for context", () => {
    const result = buildSimNow("2026-03-23T10:52:18Z");
    expect(result).toContain("originally reported at 2026-03-23T10:52:18Z");
  });

  it("references alert timestamps as the temporal anchor", () => {
    const result = buildSimNow("2026-03-23T10:52:18Z");
    expect(result).toContain("Alerts and recent events have their own timestamps");
    expect(result).toContain("temporal anchor");
  });

  it("requires all output timestamps to be in the past relative to UTC now", () => {
    const result = buildSimNow("2026-03-23T10:52:18Z");
    expect(result).toContain("must be in the past relative to 2026-03-27T14:00:00.000Z");
  });

  it("does NOT anchor to reportedTime + 1-2 hours", () => {
    const result = buildSimNow("2026-03-23T10:52:18Z");
    expect(result).not.toContain("approximately 1-2 hours after");
    expect(result).not.toContain("after the reported time");
  });

  it("produces a valid prompt when reportedTime is undefined", () => {
    const result = buildSimNow(undefined);
    expect(result).toContain("The current UTC time is 2026-03-27T14:00:00.000Z");
    expect(result).toContain("consistent, realistic timestamps");
    expect(result).not.toContain("originally reported");
  });
});

describe("buildCommandSystemPrompt", () => {
  it("embeds simNow in the TEMPORAL CONSISTENCY rule", () => {
    const simNow = "The current UTC time is 2026-03-27T14:00:00.000Z.";
    const prompt = buildCommandSystemPrompt("oc", "ctx", simNow);
    expect(prompt).toContain("TEMPORAL CONSISTENCY: The current UTC time is 2026-03-27T14:00:00.000Z.");
  });

  it("embeds scenario context at the end", () => {
    const prompt = buildCommandSystemPrompt("oc", "Title: Test (easy)", "simNow");
    expect(prompt).toContain("Scenario Context:\nTitle: Test (easy)");
  });

  it("instructs the model not to echo angle-bracket placeholders in output", () => {
    const prompt = buildCommandSystemPrompt("oc", "ctx", "now");
    expect(prompt).toContain("PLACEHOLDER RESOLUTION");
  });

  it("labels oc commands as OpenShift CLI", () => {
    const prompt = buildCommandSystemPrompt("oc", "ctx", "now");
    expect(prompt).toContain("OpenShift CLI (oc)");
    expect(prompt).not.toContain("Kusto Query Language");
  });

  it("labels kql commands as Kusto Query Language", () => {
    const prompt = buildCommandSystemPrompt("kql", "ctx", "now");
    expect(prompt).toContain("Kusto Query Language (KQL)");
  });

  it("labels geneva commands as Geneva", () => {
    const prompt = buildCommandSystemPrompt("geneva", "ctx", "now");
    expect(prompt).toContain("Geneva commands");
  });

  it("includes command history when provided", () => {
    const history = [
      { command: "oc get nodes", output: "master-0 Ready", type: "oc" as const },
    ];
    const prompt = buildCommandSystemPrompt("oc", "ctx", "now", history);
    expect(prompt).toContain("Previously Executed Commands");
    expect(prompt).toContain("$ oc get nodes");
    expect(prompt).toContain("master-0 Ready");
  });

  it("omits history section when no history provided", () => {
    const prompt = buildCommandSystemPrompt("oc", "ctx", "now");
    expect(prompt).not.toContain("Previously Executed Commands");
  });

  it("instructs the model not to echo the command or prompt lines", () => {
    const prompt = buildCommandSystemPrompt("oc", "ctx", "now");
    expect(prompt).toContain("Do not echo the command line");
    expect(prompt).toContain('"[oc]"');
  });
});
