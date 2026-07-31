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
  });
});
