import { describe, expect, it } from "vitest";
import { buildScenarioGenerationPrompt } from "./scenario-generator";

describe("buildScenarioGenerationPrompt", () => {
  it("includes the requested platform and primary CLI guidance", () => {
    const prompt = buildScenarioGenerationPrompt({
      platform: "aks",
      difficulty: "easy",
      currentDate: "2026-07-31T10:00:00.000Z",
      scenarioContext: "AKS incident references",
    });

    expect(prompt).toContain('"platform": "aks"');
    expect(prompt).toContain("Primary CLI: kubectl");
    expect(prompt).toContain("AKS-managed cluster language");
    expect(prompt).toContain("AKS incident references");
    expect(prompt).toContain('"managedResourceGroupHint"');
    expect(prompt).not.toContain('"guestClusterName"');
    expect(prompt).not.toContain('"machineNames"');
  });

  it("renders only HCP platform context fields for HCP scenarios", () => {
    const prompt = buildScenarioGenerationPrompt({
      platform: "aro-hcp",
      difficulty: "medium",
      currentDate: "2026-08-03T10:00:00.000Z",
      scenarioContext: "HCP incident references",
    });

    expect(prompt).toContain('"guestClusterName"');
    expect(prompt).toContain('"hostedControlPlaneNamespace"');
    expect(prompt).toContain('"nodePoolNames"');
    expect(prompt).not.toContain('"machineNames"');
    expect(prompt).not.toContain('"managedResourceGroupHint"');
  });

  it("renders only Classic platform context fields for Classic scenarios", () => {
    const prompt = buildScenarioGenerationPrompt({
      platform: "aro-classic",
      difficulty: "hard",
      currentDate: "2026-08-03T10:00:00.000Z",
      scenarioContext: "Classic incident references",
    });

    expect(prompt).toContain('"machineNames"');
    expect(prompt).toContain('"clusterOperatorHints"');
    expect(prompt).not.toContain('"guestClusterName"');
    expect(prompt).not.toContain('"nodePoolNames"');
  });
});
