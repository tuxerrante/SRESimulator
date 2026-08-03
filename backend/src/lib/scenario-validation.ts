import type { Scenario } from "../../../shared/types/game";
import type {
  PlatformContext,
  PlatformId,
} from "../../../shared/types/platform";

const VALID_DIFFICULTIES = new Set<Scenario["difficulty"]>([
  "easy",
  "medium",
  "hard",
]);
const VALID_PLATFORMS = new Set<Scenario["platform"]>([
  "aro-classic",
  "aro-hcp",
  "aks",
]);
const VALID_ALERT_SEVERITIES = new Set<Scenario["clusterContext"]["alerts"][number]["severity"]>([
  "critical",
  "warning",
  "info",
]);
const VALID_UPGRADE_STATUSES = new Set<Scenario["clusterContext"]["upgradeHistory"][number]["status"]>([
  "completed",
  "failed",
  "in_progress",
]);
const VALID_TICKET_SEVERITIES = new Set<Scenario["incidentTicket"]["severity"]>([
  "Sev1",
  "Sev2",
  "Sev3",
  "Sev4",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

const PLATFORM_CONTEXT_STRING_ARRAY_KEYS = [
  "machineNames",
  "routeNames",
  "clusterOperatorHints",
  "controlPlaneBoundaryNotes",
  "nodePoolNames",
  "addonContext",
] as const;

const PLATFORM_CONTEXT_STRING_KEYS = [
  "guestClusterName",
  "hostedControlPlaneNamespace",
  "managedResourceGroupHint",
] as const;

const PLATFORM_CONTEXT_KEYS = new Set<string>([
  ...PLATFORM_CONTEXT_STRING_ARRAY_KEYS,
  ...PLATFORM_CONTEXT_STRING_KEYS,
]);

const PLATFORM_CONTEXT_KEYS_BY_PLATFORM: Record<
  PlatformId,
  ReadonlySet<string>
> = {
  "aro-classic": new Set([
    "machineNames",
    "routeNames",
    "clusterOperatorHints",
  ]),
  "aro-hcp": new Set([
    "routeNames",
    "guestClusterName",
    "hostedControlPlaneNamespace",
    "controlPlaneBoundaryNotes",
    "nodePoolNames",
  ]),
  aks: new Set([
    "nodePoolNames",
    "managedResourceGroupHint",
    "addonContext",
  ]),
};

const PLATFORM_FORBIDDEN_CONTENT: Record<
  PlatformId,
  readonly { label: string; pattern: RegExp }[]
> = {
  "aro-classic": [
    { label: "AKS", pattern: /\bAKS\b/i },
    { label: "kubectl command", pattern: /\bkubectl\s+(?:get|describe|logs|apply|delete|patch|exec)\b/i },
    { label: "hosted control plane resource", pattern: /\b(?:HostedCluster|HostedControlPlane|NodePool CRD)\b/i },
  ],
  "aro-hcp": [
    { label: "AKS", pattern: /\bAKS\b/i },
    { label: "kubectl command", pattern: /\bkubectl\s+(?:get|describe|logs|apply|delete|patch|exec)\b/i },
    { label: "classic Machine API", pattern: /\b(?:Machine API|MachineSet|ControlPlaneMachineSet)\b/i },
    { label: "classic master VM", pattern: /\bmaster VM\b/i },
    { label: "classic installer or maintenance flow", pattern: /\b(?:Hive|PUCM|quorum-restore)\b/i },
    { label: "direct master access", pattern: /\bSSH (?:to|into) (?:a )?master\b/i },
  ],
  aks: [
    { label: "ARO or OpenShift", pattern: /\b(?:ARO|OpenShift)\b/i },
    { label: "oc command", pattern: /\boc\s+(?:get|describe|logs|adm|debug|apply|delete|patch|exec)\b/i },
    { label: "OpenShift operator", pattern: /\b(?:MachineConfig|MachineConfigPool|Machine API|MCO|ClusterVersion)\b/i },
    { label: "hosted OpenShift resource", pattern: /\b(?:HostedCluster|HostedControlPlane)\b/i },
    { label: "classic control plane recovery", pattern: /\b(?:master VM|Hive|PUCM|quorum-restore)\b/i },
  ],
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isPlatformContext(value: unknown): value is PlatformContext {
  if (!isRecord(value)) {
    return false;
  }

  if (Object.keys(value).some((key) => !PLATFORM_CONTEXT_KEYS.has(key))) {
    return false;
  }

  for (const key of PLATFORM_CONTEXT_STRING_ARRAY_KEYS) {
    const field = value[key];
    if (field !== undefined && (!isStringArray(field) || !field.every(isNonEmptyString))) {
      return false;
    }
  }

  for (const key of PLATFORM_CONTEXT_STRING_KEYS) {
    const field = value[key];
    if (field !== undefined && !isNonEmptyString(field)) {
      return false;
    }
  }

  return true;
}

export function isPlatformContextForPlatform(
  value: unknown,
  platform: PlatformId,
): value is PlatformContext {
  return (
    isPlatformContext(value) &&
    Object.keys(value).every((key) =>
      PLATFORM_CONTEXT_KEYS_BY_PLATFORM[platform].has(key),
    )
  );
}

function collectStringValues(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return [];
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectStringValues(entry, seen));
  }
  return Object.values(value).flatMap((entry) =>
    collectStringValues(entry, seen),
  );
}

export function getPlatformContentViolation(
  value: unknown,
  platform: PlatformId,
): string | null {
  const content = collectStringValues(value).join("\n");
  return (
    PLATFORM_FORBIDDEN_CONTENT[platform].find(({ pattern }) =>
      pattern.test(content),
    )?.label ?? null
  );
}

export function isScenario(value: unknown): value is Scenario {
  if (!isRecord(value)) {
    return false;
  }

  const incidentTicket = value.incidentTicket;
  const clusterContext = value.clusterContext;
  if (!isRecord(incidentTicket) || !isRecord(clusterContext)) {
    return false;
  }

  if (
    typeof value.id !== "string" ||
    typeof value.platform !== "string" ||
    !VALID_PLATFORMS.has(value.platform as Scenario["platform"]) ||
    typeof value.title !== "string" ||
    typeof value.description !== "string" ||
    typeof value.difficulty !== "string" ||
    !VALID_DIFFICULTIES.has(value.difficulty as Scenario["difficulty"])
  ) {
    return false;
  }

  const platform = value.platform as PlatformId;
  if (
    value.platformContext !== undefined &&
    !isPlatformContextForPlatform(value.platformContext, platform)
  ) {
    return false;
  }
  if (getPlatformContentViolation(value, platform)) {
    return false;
  }

  if (
    typeof incidentTicket.id !== "string" ||
    typeof incidentTicket.title !== "string" ||
    typeof incidentTicket.description !== "string" ||
    typeof incidentTicket.customerImpact !== "string" ||
    typeof incidentTicket.reportedTime !== "string" ||
    typeof incidentTicket.clusterName !== "string" ||
    typeof incidentTicket.region !== "string" ||
    typeof incidentTicket.severity !== "string" ||
    !VALID_TICKET_SEVERITIES.has(
      incidentTicket.severity as Scenario["incidentTicket"]["severity"],
    )
  ) {
    return false;
  }

  if (
    typeof clusterContext.name !== "string" ||
    typeof clusterContext.version !== "string" ||
    typeof clusterContext.region !== "string" ||
    typeof clusterContext.status !== "string" ||
    typeof clusterContext.nodeCount !== "number" ||
    !Number.isFinite(clusterContext.nodeCount) ||
    !isStringArray(clusterContext.recentEvents) ||
    !Array.isArray(clusterContext.alerts) ||
    !Array.isArray(clusterContext.upgradeHistory)
  ) {
    return false;
  }

  const hasValidAlerts = clusterContext.alerts.every((alert) => {
    if (!isRecord(alert)) return false;
    return (
      typeof alert.name === "string" &&
      typeof alert.message === "string" &&
      typeof alert.firingTime === "string" &&
      typeof alert.severity === "string" &&
      VALID_ALERT_SEVERITIES.has(
        alert.severity as Scenario["clusterContext"]["alerts"][number]["severity"],
      )
    );
  });
  if (!hasValidAlerts) {
    return false;
  }

  return clusterContext.upgradeHistory.every((event) => {
    if (!isRecord(event)) return false;
    return (
      typeof event.from === "string" &&
      typeof event.to === "string" &&
      typeof event.timestamp === "string" &&
      typeof event.status === "string" &&
      VALID_UPGRADE_STATUSES.has(
        event.status as Scenario["clusterContext"]["upgradeHistory"][number]["status"],
      )
    );
  });
}
