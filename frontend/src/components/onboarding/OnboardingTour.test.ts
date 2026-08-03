import { describe, expect, it } from "vitest";
import { getOnboardingSteps } from "./OnboardingTour";

describe("getOnboardingSteps", () => {
  it("uses AKS and kubectl language for AKS sessions", () => {
    const text = getOnboardingSteps("aks")
      .map((step) => step.message)
      .join(" ");

    expect(text).toContain("AKS");
    expect(text).toContain("kubectl/KQL");
    expect(text).not.toContain("OpenShift cluster");
    expect(text).not.toContain("oc/KQL");
  });

  it("uses ARO HCP and oc language for HCP sessions", () => {
    const text = getOnboardingSteps("aro-hcp")
      .map((step) => step.message)
      .join(" ");

    expect(text).toContain("ARO HCP");
    expect(text).toContain("oc/KQL");
  });

  it("uses ARO Classic and oc language for Classic sessions", () => {
    const text = getOnboardingSteps("aro-classic")
      .map((step) => step.message)
      .join(" ");

    expect(text).toContain("ARO Classic");
    expect(text).toContain("oc/KQL");
  });
});
