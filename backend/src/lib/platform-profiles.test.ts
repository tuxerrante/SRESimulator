import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLATFORM_ID,
  PLATFORM_PROFILES,
} from "../../../shared/types/platform";
import {
  getCommandScopeViolation,
  getGeneratedCliScopeViolations,
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

  describe("getGeneratedCliScopeViolations", () => {
    it("flags an oc fenced block emitted on AKS", () => {
      const text =
        "Try this:\n```oc\noc describe pod -n openshift-ingress router-default\n```";
      expect(getGeneratedCliScopeViolations("aks", text)).toEqual(["oc"]);
    });

    it("flags a kubectl fenced block emitted on an OpenShift platform", () => {
      const text = "```kubectl\nkubectl get nodes\n```";
      expect(getGeneratedCliScopeViolations("aro-classic", text)).toEqual([
        "kubectl",
      ]);
    });

    it("returns no violations when the platform-correct CLI is used", () => {
      const aks = "```kubectl\nkubectl get pods\n```";
      expect(getGeneratedCliScopeViolations("aks", aks)).toEqual([]);
      const aro = "```oc\noc get pods\n```";
      expect(getGeneratedCliScopeViolations("aro-classic", aro)).toEqual([]);
    });

    it("ignores kql, geneva, and prose mentions of the CLI name", () => {
      const text =
        "You could run oc later, but for now:\n```kql\nClusterLogs | take 10\n```";
      expect(getGeneratedCliScopeViolations("aks", text)).toEqual([]);
    });

    it("deduplicates repeated violations", () => {
      const text = "```oc\noc get nodes\n```\n```oc\noc get pods\n```";
      expect(getGeneratedCliScopeViolations("aks", text)).toEqual(["oc"]);
    });
  });
});
