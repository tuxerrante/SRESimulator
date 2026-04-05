import type { Scenario } from "../../../../shared/types/game";

const MAX_IDENTIFIERS = 28;

/** User-typed angle-bracket placeholders copied from docs (e.g. `<machine-name-for-worker-1>`). */
const ANGLE_PLACEHOLDER = /<([^>\n]+)>/g;

function scenarioTextBlob(scenario: Scenario): string {
  return [
    scenario.title,
    scenario.description,
    scenario.incidentTicket.title,
    scenario.incidentTicket.description,
    scenario.incidentTicket.customerImpact,
    scenario.clusterContext.status,
    ...scenario.clusterContext.recentEvents,
    ...scenario.clusterContext.alerts.map((a) => `${a.name} ${a.message}`),
  ].join("\n");
}

function looksLikeKubeName(name: string): boolean {
  const t = name.trim();
  if (t.length < 2 || t.length > 240) return false;
  return /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/.test(t);
}

/**
 * Pull node/machine-like identifiers from scenario text so prompts and the command
 * simulator can use concrete names instead of echoing `<placeholder>` tokens.
 */
export function extractResourceIdentifiers(scenario: Scenario): string[] {
  const text = scenarioTextBlob(scenario);
  const found = new Set<string>();

  const patterns: RegExp[] = [
    /\bnode\/([a-zA-Z0-9][a-zA-Z0-9.-]*)\b/g,
    /\bmachine\/([a-zA-Z0-9][a-zA-Z0-9.-]*)\b/gi,
    /\b(?:Node|node)\s+([a-zA-Z0-9][a-zA-Z0-9.-]*)\b/g,
    /\b(?:Machine|machine)\s+([a-zA-Z0-9][a-zA-Z0-9.-]*)\b/g,
    /\b([a-z][a-z0-9]*-(?:master|worker|infra)[a-z0-9-]*)\b/gi,
  ];

  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const name = m[1];
      if (name && looksLikeKubeName(name)) found.add(name);
    }
  }

  const cluster = scenario.clusterContext.name;
  if (cluster && looksLikeKubeName(cluster)) {
    found.add(cluster);
  }

  return [...found].slice(0, MAX_IDENTIFIERS);
}

/** Paragraph appended to command scenario context: newline, short guidance, then comma-separated identifiers; empty when none. */
export function formatResourceHintsForPrompt(scenario: Scenario): string {
  const ids = extractResourceIdentifiers(scenario);
  if (ids.length === 0) return "";
  return `\nNamed resources (from ticket/alerts/events — use these instead of angle-bracket placeholders): ${ids.join(", ")}`;
}

export function getResourceIdentifiersCsv(scenario: Scenario): string | null {
  const ids = extractResourceIdentifiers(scenario);
  return ids.length > 0 ? ids.join(", ") : null;
}

function compareResourceIdentifiers(a: string, b: string): number {
  const aMatch = a.match(/(\d+)(?!.*\d)/);
  const bMatch = b.match(/(\d+)(?!.*\d)/);

  if (aMatch && bMatch) {
    const aNum = parseInt(aMatch[1], 10);
    const bNum = parseInt(bMatch[1], 10);
    if (aNum !== bNum) return aNum - bNum;
  } else if (aMatch) {
    return -1;
  } else if (bMatch) {
    return 1;
  }

  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Worker-like identifiers in deterministic order for positional placeholder resolution. */
function sortedWorkerLike(ids: string[]): string[] {
  return [...ids]
    .filter((id) => /worker/i.test(id))
    .sort(compareResourceIdentifiers);
}

/**
 * Best-effort resolution of `<...>` placeholders in a user command using scenario-derived
 * names so the model receives a concrete command string.
 */
export function resolveAngleBracketPlaceholders(
  command: string,
  scenario: Scenario | null,
): string {
  if (!scenario || !command.includes("<")) return command;

  const ids = extractResourceIdentifiers(scenario);
  const cluster = scenario.clusterContext.name;
  const workers = sortedWorkerLike(ids);
  const masters = ids.filter((id) => /master/i.test(id));

  return command.replace(ANGLE_PLACEHOLDER, (full, inner: string) => {
    const key = inner.trim().toLowerCase();

    const workerNum = key.match(/worker\D*(\d+)/i);
    if (workerNum) {
      const idx = Math.max(0, parseInt(workerNum[1], 10) - 1);
      const picked = workers[idx] ?? workers[0];
      if (picked) return picked;
      if (cluster && looksLikeKubeName(cluster)) {
        return `${cluster}-worker-${workerNum[1]}`;
      }
      return `worker-${workerNum[1]}`;
    }

    if (/(^|[^a-z])machine([^a-z]|$)/i.test(key) && /worker/i.test(key)) {
      return workers[0] ?? (cluster ? `${cluster}-worker-0` : full);
    }

    if (/(machine|machine-name|machines)/i.test(key)) {
      return workers[0] ?? masters[0] ?? cluster ?? full;
    }

    if (/(node|node-name|hostname)/i.test(key)) {
      return workers[0] ?? masters[0] ?? cluster ?? full;
    }

    const bySubstring = ids.find((id) => key.length > 2 && key.includes(id.toLowerCase()));
    if (bySubstring) return bySubstring;

    return full;
  });
}
