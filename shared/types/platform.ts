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

export interface PlatformDocumentationReference {
  label: string;
  url: string;
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

export const PLATFORM_DOCUMENTATION_REFERENCES: Record<
  PlatformId,
  readonly PlatformDocumentationReference[]
> = {
  "aro-classic": [
    {
      label: "ARO lifecycle",
      url: "https://learn.microsoft.com/en-us/azure/openshift/support-lifecycle",
    },
    {
      label: "ARO support policies",
      url: "https://learn.microsoft.com/en-us/azure/openshift/support-policies-v4",
    },
    {
      label: "OpenShift documentation",
      url: "https://docs.openshift.com/container-platform/4.18/",
    },
    {
      label: "Red Hat Knowledgebase",
      url: "https://access.redhat.com/knowledgebase",
    },
    {
      label: "OpenShift runbooks",
      url: "https://github.com/openshift/runbooks/tree/master/alerts",
    },
  ],
  "aro-hcp": [
    {
      label: "ARO guest-cluster lifecycle",
      url: "https://learn.microsoft.com/en-us/azure/openshift/support-lifecycle",
    },
    {
      label: "ARO HCP architecture",
      url: "https://github.com/Azure/ARO-HCP",
    },
    {
      label: "OpenShift guest-cluster documentation",
      url: "https://docs.openshift.com/container-platform/4.18/",
    },
    {
      label: "Red Hat Knowledgebase",
      url: "https://access.redhat.com/knowledgebase",
    },
    {
      label: "OpenShift guest-cluster runbooks",
      url: "https://github.com/openshift/runbooks/tree/master/alerts",
    },
  ],
  aks: [
    {
      label: "AKS documentation",
      url: "https://learn.microsoft.com/en-us/azure/aks/",
    },
    {
      label: "AKS troubleshooting",
      url: "https://learn.microsoft.com/en-us/troubleshoot/azure/azure-kubernetes/",
    },
    {
      label: "AKS support policies",
      url: "https://learn.microsoft.com/en-us/azure/aks/support-policies",
    },
    {
      label: "Kubernetes documentation",
      url: "https://kubernetes.io/docs/",
    },
    {
      label: "Azure Monitor documentation",
      url: "https://learn.microsoft.com/en-us/azure/azure-monitor/",
    },
  ],
};

export function isCommandTypeCompatibleWithPlatform(
  platform: PlatformId,
  type: CompatibleCommandType,
): boolean {
  return (
    type === "kql" ||
    type === "geneva" ||
    type === PLATFORM_PROFILES[platform].primaryCli
  );
}

export function isDocumentationUrlAllowedForPlatform(
  platform: PlatformId,
  href: string,
): boolean {
  let candidate: URL;
  try {
    candidate = new URL(href);
  } catch {
    return false;
  }

  return PLATFORM_DOCUMENTATION_REFERENCES[platform].some((reference) => {
    const allowed = new URL(reference.url);
    const allowedPath = allowed.pathname.endsWith("/")
      ? allowed.pathname
      : `${allowed.pathname}/`;
    return (
      candidate.origin === allowed.origin &&
      (candidate.pathname === allowed.pathname ||
        candidate.pathname.startsWith(allowedPath))
    );
  });
}
