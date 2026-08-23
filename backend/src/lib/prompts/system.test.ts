import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Scenario } from "../../../../shared/types/game";
import { getRuntimePlatformProfile } from "../platform-profiles";
import { buildSystemPrompt } from "./system";

const FIXED_NOW = new Date("2026-03-27T14:00:00.000Z");

function makeScenario(overrides?: Partial<Scenario>): Scenario {
  return {
    id: "scenario_test",
    platform: "aro-classic",
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
      status: "Degraded",
      recentEvents: [
        "2026-03-27T12:41:03Z Warning NodeHasDiskPressure",
      ],
      alerts: [
        {
          name: "KubeNodeNotReady",
          severity: "critical",
          message: "Node worker-eastus2-2 is not ready",
          firingTime: "2026-03-27T12:44:30Z",
        },
      ],
      upgradeHistory: [
        { from: "4.17.14", to: "4.18.6", status: "completed", timestamp: "2026-03-10T08:00:00Z" },
      ],
    },
    ...overrides,
  };
}

describe("buildSystemPrompt", () => {
  const classicProfile = getRuntimePlatformProfile("aro-classic");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("simulation clock", () => {
    it("includes a Simulation Clock section with the current UTC time", () => {
      const prompt = buildSystemPrompt("kb", makeScenario(), "reading", classicProfile);
      expect(prompt).toContain("## Simulation Clock");
      expect(prompt).toContain("Current UTC time: 2026-03-27T14:00:00.000Z");
    });

    it("omits Simulation Clock when no scenario is loaded", () => {
      const prompt = buildSystemPrompt("kb", null, "reading", classicProfile);
      expect(prompt).not.toContain("## Simulation Clock");
    });
  });

  describe("simulator UI awareness", () => {
    it("describes the Dashboard tab", () => {
      const prompt = buildSystemPrompt("kb", makeScenario(), "reading", classicProfile);
      expect(prompt).toContain("## Simulator UI");
      expect(prompt).toContain("**Dashboard**");
      expect(prompt).toContain("cluster name, version, region, node count, status");
    });

    it("tells the AI to never question dashboard access", () => {
      const prompt = buildSystemPrompt("kb", makeScenario(), "reading", classicProfile);
      expect(prompt).toContain("Never ask whether the user has dashboard access");
    });

    it("describes the Terminal tab", () => {
      const prompt = buildSystemPrompt("kb", makeScenario(), "reading", classicProfile);
      expect(prompt).toContain("**Terminal**");
    });

    it("describes the Guide tab", () => {
      const prompt = buildSystemPrompt("kb", makeScenario(), "reading", classicProfile);
      expect(prompt).toContain("**Guide**");
    });
  });

  describe("phase transition style", () => {
    it("instructs natural conversational transitions", () => {
      const prompt = buildSystemPrompt("kb", makeScenario(), "reading", classicProfile);
      expect(prompt).toContain("## Phase Transition Style");
      expect(prompt).toContain("do NOT announce it as a blunt label");
    });

    it("tells the AI that [PHASE:...] markers handle UI state", () => {
      const prompt = buildSystemPrompt("kb", makeScenario(), "reading", classicProfile);
      expect(prompt).toContain("[PHASE:...]");
      expect(prompt).toContain("handles the UI state change");
    });
  });

  describe("scenario context", () => {
    it("includes ticket reportedTime", () => {
      const prompt = buildSystemPrompt("kb", makeScenario(), "reading", classicProfile);
      expect(prompt).toContain("**Reported:** 2026-03-23T10:52:18Z");
    });

    it("includes alert firing times", () => {
      const prompt = buildSystemPrompt("kb", makeScenario(), "reading", classicProfile);
      expect(prompt).toContain("(firing since 2026-03-27T12:44:30Z)");
    });

    it("includes alert severity, name, and message", () => {
      const prompt = buildSystemPrompt("kb", makeScenario(), "reading", classicProfile);
      expect(prompt).toContain("critical: KubeNodeNotReady");
      expect(prompt).toContain("Node worker-eastus2-2 is not ready");
    });

    it("includes all incident ticket fields", () => {
      const prompt = buildSystemPrompt("kb", makeScenario(), "context", classicProfile);
      expect(prompt).toContain("**ID:** IcM-900327");
      expect(prompt).toContain("**Severity:** Sev3");
      expect(prompt).toContain("**Title:** Pods stuck Pending");
      expect(prompt).toContain("**Customer Impact:** Reduced capacity");
      expect(prompt).toContain("**Cluster:** aro-prod-payments-eus2-01");
      expect(prompt).toContain("**Region:** eastus2");
    });

    it("includes cluster context fields", () => {
      const prompt = buildSystemPrompt("kb", makeScenario(), "reading", classicProfile);
      expect(prompt).toContain("**Version:** 4.18.6");
      expect(prompt).toContain("**Nodes:** 6");
      expect(prompt).toContain("**Status:** Degraded");
      expect(prompt).toContain("NodeHasDiskPressure");
    });

    it("includes named resources when identifiers are derived from the scenario", () => {
      const prompt = buildSystemPrompt("kb", makeScenario(), "reading", classicProfile);
      expect(prompt).toContain("**Named resources:**");
      expect(prompt).toContain("worker-eastus2-2");
    });

    it("omits scenario context when scenario is null", () => {
      const prompt = buildSystemPrompt("kb", null, "reading", classicProfile);
      expect(prompt).not.toContain("## Active Scenario");
      expect(prompt).not.toContain("### Incident Ticket");
    });
  });

  describe("investigation methodology", () => {
    it("reflects the current phase", () => {
      const prompt = buildSystemPrompt("kb", makeScenario(), "facts", classicProfile);
      expect(prompt).toContain("**Current Phase: facts**");
    });

    it("references the Dashboard tab in Context Gathering phase description", () => {
      const prompt = buildSystemPrompt("kb", makeScenario(), "reading", classicProfile);
      expect(prompt).toContain("Review the Dashboard tab");
    });

    it("includes all five phases", () => {
      const prompt = buildSystemPrompt("kb", makeScenario(), "reading", classicProfile);
      expect(prompt).toContain("**Reading**");
      expect(prompt).toContain("**Context Gathering**");
      expect(prompt).toContain("**Facts Gathering**");
      expect(prompt).toContain("**Theory Building**");
      expect(prompt).toContain("**Action**");
    });
  });

  describe("knowledge base", () => {
    it("includes the knowledge base content", () => {
      const prompt = buildSystemPrompt(
        "some KB content here",
        makeScenario(),
        "reading",
        classicProfile,
      );
      expect(prompt).toContain("## Knowledge Base Reference");
      expect(prompt).toContain("some KB content here");
    });
  });

  it("switches terminal guidance for aks profiles", () => {
    const aksPrompt = buildSystemPrompt(
      "kb",
      makeScenario({
        platform: "aks",
        clusterContext: {
          ...makeScenario().clusterContext,
          version: "1.31.2",
        },
      }),
      "reading",
      getRuntimePlatformProfile("aks"),
    );

    expect(aksPrompt).toContain("kubectl");
    expect(aksPrompt).toContain("AKS");
    expect(aksPrompt).not.toContain("```oc```");
    expect(aksPrompt).toContain("```geneva```");
    expect(aksPrompt).toContain("Dashboard");
    expect(aksPrompt).not.toContain("Collect evidence with `oc` commands");
    expect(aksPrompt).toContain("AKS support policies");
    expect(aksPrompt).not.toContain("openshift/runbooks");
    expect(aksPrompt).not.toContain("azure/openshift/support-policies-v4");
  });

  describe("final command constraint", () => {
    const aksProfile = getRuntimePlatformProfile("aks");

    it("restates the kubectl-only constraint after the knowledge base for aks", () => {
      const prompt = buildSystemPrompt(
        "KB_SENTINEL_CONTENT",
        makeScenario({ platform: "aks" }),
        "facts",
        aksProfile,
      );

      expect(prompt).toContain("## Final Command Constraint");
      expect(prompt).toContain("The ONLY valid cluster CLI for this session is `kubectl`.");
      expect(prompt).toContain("NEVER emit `oc` fenced blocks");
      // Recency: the constraint must come AFTER the knowledge base so it is the
      // last instruction the model reads before generating.
      expect(prompt.indexOf("## Final Command Constraint")).toBeGreaterThan(
        prompt.indexOf("KB_SENTINEL_CONTENT"),
      );
    });

    it("forbids kubectl for oc-based platforms", () => {
      const prompt = buildSystemPrompt(
        "kb",
        makeScenario({ platform: "aro-classic" }),
        "facts",
        classicProfile,
      );

      expect(prompt).toContain("The ONLY valid cluster CLI for this session is `oc`.");
      expect(prompt).toContain("NEVER emit `kubectl` fenced blocks");
    });
  });

  it("keeps ARO HCP references and placeholders guest-cluster scoped", () => {
    const hcpPrompt = buildSystemPrompt(
      "hcp kb",
      makeScenario({
        platform: "aro-hcp",
        title: "Guest Route 503",
      }),
      "reading",
      getRuntimePlatformProfile("aro-hcp"),
    );

    expect(hcpPrompt).toContain("ARO HCP Support Guidance");
    expect(hcpPrompt).toContain("[ARO HCP architecture](https://github.com/Azure/ARO-HCP)");
    expect(hcpPrompt).toContain("`oc describe node <node-name>`");
    expect(hcpPrompt).not.toContain("`oc describe machine <machine-name>`");
    expect(hcpPrompt).not.toContain("azure/openshift/support-policies-v4");
  });

  it("keeps ARO Classic references and placeholders classic scoped", () => {
    const classicPrompt = buildSystemPrompt(
      "classic kb",
      makeScenario(),
      "reading",
      classicProfile,
    );

    expect(classicPrompt).toContain("ARO Classic Support Guidance");
    expect(classicPrompt).toContain("azure/openshift/support-policies-v4");
    expect(classicPrompt).toContain("`oc describe machine <machine-name>`");
    expect(classicPrompt).not.toContain("github.com/Azure/ARO-HCP");
  });
});
