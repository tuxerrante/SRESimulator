import type { Scenario } from "../../../shared/types/game";

const VALID_DIFFICULTIES = new Set<Scenario["difficulty"]>([
  "easy",
  "medium",
  "hard",
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
    typeof value.title !== "string" ||
    typeof value.description !== "string" ||
    typeof value.difficulty !== "string" ||
    !VALID_DIFFICULTIES.has(value.difficulty as Scenario["difficulty"])
  ) {
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
