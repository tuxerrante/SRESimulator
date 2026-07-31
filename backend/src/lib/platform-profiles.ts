import {
  PLATFORM_PROFILES,
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
      knowledgeFiles: ["platforms/aro-classic/platform-operations.md"],
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
  return getRuntimePlatformProfile(platform).allowedCommandTypes.includes(type);
}
