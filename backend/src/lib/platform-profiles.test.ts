import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLATFORM_ID,
  PLATFORM_PROFILES,
} from "../../../shared/types/platform";
import {
  getCommandScopeViolation,
  isCommandTypeAllowedForPlatform,
} from "./platform-profiles";

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
    expect(isCommandTypeAllowedForPlatform("aro-hcp", "oc")).toBe(true);
    expect(isCommandTypeAllowedForPlatform("aro-hcp", "kubectl")).toBe(false);
    expect(isCommandTypeAllowedForPlatform("aks", "kubectl")).toBe(true);
    expect(isCommandTypeAllowedForPlatform("aks", "kql")).toBe(true);
  });

  it("rejects platform-exclusive resources on the wrong OpenShift path", () => {
    expect(
      getCommandScopeViolation("aro-hcp", "oc", "oc get machines -A"),
    ).toBe("ARO Classic Machine API resource");
    expect(
      getCommandScopeViolation(
        "aro-hcp",
        "oc",
        "oc debug node/worker-0 -- cat /etc/machine-id",
      ),
    ).toBeNull();
    expect(
      getCommandScopeViolation(
        "aro-hcp",
        "oc",
        "oc logs deployment/machine-approver",
      ),
    ).toBeNull();
    expect(
      getCommandScopeViolation("aro-hcp", "oc", "oc get machineconfigs"),
    ).toBeNull();
    expect(
      getCommandScopeViolation(
        "aro-classic",
        "oc",
        "oc get hostedclusters -A",
      ),
    ).toBe("hosted control plane resource");
    expect(
      getCommandScopeViolation("aks", "kubectl", "kubectl get clusterversion"),
    ).toBe("OpenShift resource");
    expect(
      getCommandScopeViolation("aro-hcp", "oc", "oc get pods -A"),
    ).toBeNull();
  });
});
