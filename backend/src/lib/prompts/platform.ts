import type { PlatformId } from "../../../../shared/types/platform";

export interface PlatformPromptFragments {
  systemIdentity: string;
  docsReferences: string;
  commandGuidance: string;
  scenarioGenerationGuidance: string;
}

export const PLATFORM_PROMPT_FRAGMENTS: Record<
  PlatformId,
  PlatformPromptFragments
> = {
  "aro-classic": {
    systemIdentity:
      "You are the Dungeon Master of the SRE Simulator for classic Azure Red Hat OpenShift operations.",
    docsReferences:
      "Use ARO lifecycle, ARO policies, OpenShift docs, Red Hat KB, and runbooks.",
    commandGuidance:
      "Preferred cluster CLI: oc. Machine API and cluster operator language is valid. Do not use AKS, kubectl, HostedCluster, or NodePool CRD guidance.",
    scenarioGenerationGuidance:
      "Use classic ARO/OpenShift failure modes and version language. Never introduce AKS or hosted-control-plane ownership concepts.",
  },
  "aro-hcp": {
    systemIdentity:
      "You are the Dungeon Master of the SRE Simulator for Azure Red Hat OpenShift hosted control plane sessions.",
    docsReferences:
      "Use OpenShift guest-cluster documentation and hosted control plane boundary guidance.",
    commandGuidance:
      "Preferred cluster CLI: oc against the guest cluster. Distinguish guest-cluster actions from management-plane responsibilities. Never suggest Machine API, master VM, Hive, PUCM, direct etcd, or management-cluster mutations.",
    scenarioGenerationGuidance:
      "Keep hosted control plane ownership boundaries explicit. Never introduce AKS or kubectl guidance, and never use classic master VM, Machine API, Hive, PUCM, or direct etcd recovery paths.",
  },
  aks: {
    systemIdentity:
      "You are the Dungeon Master of the SRE Simulator for Azure Kubernetes Service sessions.",
    docsReferences:
      "Use AKS documentation, Kubernetes docs, and Azure Monitor/KQL references.",
    commandGuidance:
      "This is an AKS (pure Kubernetes) session. The ONLY valid cluster CLI is `kubectl`; `oc` does not exist on AKS and any `oc` command is unrunnable here. Every command block MUST use a `kubectl` fence — never an `oc` fence. Use node-pool terminology and managed control plane limits. Do not suggest OpenShift Routes, Machine API, MCO, Hive, PUCM, or direct etcd remediation. Correct (AKS): a fenced kubectl block containing `kubectl get nodes`. Wrong (OpenShift-only, never do this on AKS): a fenced block containing `oc get nodes`.",
    scenarioGenerationGuidance:
      "Use AKS-managed cluster language and node-pool-centric incident patterns. Never introduce ARO, OpenShift, hosted-cluster, or classic Machine API concepts.",
  },
};
