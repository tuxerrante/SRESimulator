export type PlatformId = "aro-classic" | "aro-hcp" | "aks";

export type PrimaryClusterCli = "oc" | "kubectl";
export type ExecutableCommandType = PrimaryClusterCli | "kql";
export type CompatibleCommandType = ExecutableCommandType | "geneva";

export interface PlatformContext {
  machineNames?: string[];
  routeNames?: string[];
  clusterOperatorHints?: string[];
  guestClusterName?: string;
  hostedControlPlaneNamespace?: string;
  controlPlaneBoundaryNotes?: string[];
  nodePoolNames?: string[];
  managedResourceGroupHint?: string;
  addonContext?: string[];
}

export interface PlatformProfile {
  id: PlatformId;
  label: string;
  description: string;
  primaryCli: PrimaryClusterCli;
  secondarySurfaces: readonly ["kql", "dashboard"];
}

export const DEFAULT_PLATFORM_ID: PlatformId = "aro-classic";

export const PLATFORM_IDS = [
  "aro-classic",
  "aro-hcp",
  "aks",
] as const satisfies readonly PlatformId[];

export const PLATFORM_PROFILES: Record<PlatformId, PlatformProfile> = {
  "aro-classic": {
    id: "aro-classic",
    label: "ARO Classic",
    description: "Classic Azure Red Hat OpenShift cluster operations.",
    primaryCli: "oc",
    secondarySurfaces: ["kql", "dashboard"],
  },
  "aro-hcp": {
    id: "aro-hcp",
    label: "ARO HCP",
    description:
      "Hosted control plane investigations with guest-cluster boundaries.",
    primaryCli: "oc",
    secondarySurfaces: ["kql", "dashboard"],
  },
  aks: {
    id: "aks",
    label: "AKS",
    description:
      "Azure Kubernetes Service investigations with node-pool terminology.",
    primaryCli: "kubectl",
    secondarySurfaces: ["kql", "dashboard"],
  },
};
