import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLATFORM_ID,
  PLATFORM_PROFILES,
} from "../../../shared/types/platform";
import { isCommandTypeAllowedForPlatform } from "./platform-profiles";

describe("platform profiles", () => {
  it("maps each gameplay platform to the expected primary CLI", () => {
    expect(DEFAULT_PLATFORM_ID).toBe("aro-classic");
    expect(PLATFORM_PROFILES["aro-classic"].primaryCli).toBe("oc");
    expect(PLATFORM_PROFILES["aro-hcp"].primaryCli).toBe("oc");
    expect(PLATFORM_PROFILES["aks"].primaryCli).toBe("kubectl");
  });

  it("rejects mismatched cluster CLIs while allowing kql everywhere", () => {
    expect(isCommandTypeAllowedForPlatform("aro-classic", "oc")).toBe(true);
    expect(isCommandTypeAllowedForPlatform("aro-classic", "kubectl")).toBe(
      false,
    );
    expect(isCommandTypeAllowedForPlatform("aks", "kubectl")).toBe(true);
    expect(isCommandTypeAllowedForPlatform("aks", "kql")).toBe(true);
  });
});
