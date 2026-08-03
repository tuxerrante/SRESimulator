import {
  PLATFORM_PROFILES,
  isCommandTypeCompatibleWithPlatform,
  type CompatibleCommandType,
  type PlatformId,
  type PlatformProfile,
} from "../../../shared/types/platform";

export interface RuntimePlatformProfile extends PlatformProfile {
  knowledgeFiles: readonly string[];
  allowedCommandTypes: readonly CompatibleCommandType[];
}

export const RUNTIME_PLATFORM_PROFILES: Record<PlatformId, RuntimePlatformProfile> =
  {
    "aro-classic": {
      ...PLATFORM_PROFILES["aro-classic"],
      knowledgeFiles: [
        "Openshift-clusters-alerts-resolutions.md",
        "Community-reported-issues.md",
        "platforms/aro-classic/platform-operations.md",
      ],
      allowedCommandTypes: ["oc", "kql", "geneva"],
    },
    "aro-hcp": {
      ...PLATFORM_PROFILES["aro-hcp"],
      knowledgeFiles: ["platforms/aro-hcp/platform-operations.md"],
      allowedCommandTypes: ["oc", "kql", "geneva"],
    },
    aks: {
      ...PLATFORM_PROFILES.aks,
      knowledgeFiles: ["platforms/aks/platform-operations.md"],
      allowedCommandTypes: ["kubectl", "kql", "geneva"],
    },
  };

export function getRuntimePlatformProfile(
  platform: PlatformId,
): RuntimePlatformProfile {
  return RUNTIME_PLATFORM_PROFILES[platform];
}

export function isCommandTypeAllowedForPlatform(
  platform: PlatformId,
  type: CompatibleCommandType,
): boolean {
  return isCommandTypeCompatibleWithPlatform(platform, type);
}

const FORBIDDEN_COMMAND_RESOURCES: Record<
  PlatformId,
  readonly { label: string; pattern: RegExp }[]
> = {
  "aro-classic": [
    {
      label: "hosted control plane resource",
      pattern: /\b(?:hostedclusters?|hostedcontrolplanes?|nodepools?)\b/i,
    },
  ],
  "aro-hcp": [
    {
      label: "ARO Classic Machine API resource",
      pattern:
        /\b(?:get|describe|delete|patch|edit)\s+(?:machines?|machinesets?|controlplanemachinesets?)(?:\.machine\.openshift\.io)?\b/i,
    },
  ],
  aks: [
    {
      label: "OpenShift resource",
      pattern:
        /\b(?:routes?\.route\.openshift\.io|machineconfigs?|machineconfigpools?|clusterversions?|clusteroperators?|hostedclusters?|hostedcontrolplanes?)\b/i,
    },
  ],
};

export function getCommandScopeViolation(
  platform: PlatformId,
  type: CompatibleCommandType,
  command: string,
): string | null {
  if (type !== getRuntimePlatformProfile(platform).primaryCli) {
    return null;
  }
  return (
    FORBIDDEN_COMMAND_RESOURCES[platform].find(({ pattern }) =>
      pattern.test(command),
    )?.label ?? null
  );
}
