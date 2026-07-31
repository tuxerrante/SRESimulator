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
      "Preferred cluster CLI: oc. Machine API and cluster operator language is valid.",
    scenarioGenerationGuidance:
      "Use classic ARO/OpenShift failure modes and version language.",
  },
  "aro-hcp": {
    systemIdentity:
      "You are the Dungeon Master of the SRE Simulator for Azure Red Hat OpenShift hosted control plane sessions.",
    docsReferences:
      "Use OpenShift guest-cluster documentation and hosted control plane boundary guidance.",
    commandGuidance:
      "Preferred cluster CLI: oc. Distinguish guest-cluster actions from management-plane responsibilities.",
    scenarioGenerationGuidance:
      "Keep hosted control plane ownership boundaries explicit.",
  },
  aks: {
    systemIdentity:
      "You are the Dungeon Master of the SRE Simulator for Azure Kubernetes Service sessions.",
    docsReferences:
      "Use AKS documentation, Kubernetes docs, and Azure Monitor/KQL references.",
    commandGuidance:
      "Preferred cluster CLI: kubectl. Use node-pool terminology and managed control plane limits.",
    scenarioGenerationGuidance:
      "Use AKS-managed cluster language and node-pool-centric incident patterns.",
  },
};
