import { constants } from "fs";
import { access, readdir, readFile } from "fs/promises";
import { join, resolve } from "path";
import type { Difficulty, Scenario } from "../../../shared/types/game";
import { utcOffsetMinutes } from "./sim-clock";

const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];
const CATALOG_SOURCE = "catalog";

type ScenarioCatalog = Record<Difficulty, Scenario[]>;

let cachedCatalogPromise: Promise<ScenarioCatalog> | null = null;

export class ScenarioCatalogError extends Error {
  constructor(
    message: string,
    readonly clientMessage: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ScenarioCatalogError";
  }
}

function invalidCatalog(message: string): ScenarioCatalogError {
  return new ScenarioCatalogError(message, "Scenario catalog is invalid.", 500);
}

function unavailableCatalog(difficulty: Difficulty): ScenarioCatalogError {
  return new ScenarioCatalogError(
    `Scenario catalog is not available for ${difficulty} difficulty.`,
    `Scenario catalog is not available for ${difficulty} difficulty.`,
    503,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertString(value: unknown, label: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidCatalog(
      `Catalog scenario field ${label} must be a non-empty string`,
    );
  }
}

function assertEnum<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw invalidCatalog(
      `Catalog scenario field ${label} must be one of: ${allowed.join(", ")}`,
    );
  }
}

function assertArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw invalidCatalog(`Catalog scenario field ${label} must be an array`);
  }
}

function assertStringArray(value: unknown, label: string): void {
  assertArray(value, label);
  for (const [index, entry] of value.entries()) {
    assertString(entry, `${label}[${index}]`);
  }
}

const INCIDENT_SEVERITIES = ["Sev1", "Sev2", "Sev3", "Sev4"] as const;
const ALERT_SEVERITIES = ["critical", "warning", "info"] as const;
const UPGRADE_STATUSES = ["completed", "failed", "in_progress"] as const;

function assertScenarioTemplate(
  value: unknown,
  difficulty: Difficulty,
  filePath: string,
): Scenario {
  if (!isRecord(value)) {
    throw invalidCatalog(
      `Catalog scenario ${filePath} must contain a JSON object`,
    );
  }

  assertString(value.id, "id");
  assertString(value.title, "title");
  assertString(value.description, "description");
  if (value.difficulty !== difficulty) {
    throw invalidCatalog(
      `Catalog scenario ${filePath} must declare difficulty ${difficulty}`,
    );
  }

  const incidentTicket = value.incidentTicket;
  const clusterContext = value.clusterContext;
  if (!isRecord(incidentTicket) || !isRecord(clusterContext)) {
    throw invalidCatalog(
      `Catalog scenario ${filePath} must include incidentTicket and clusterContext`,
    );
  }

  assertString(incidentTicket.id, "incidentTicket.id");
  assertEnum(incidentTicket.severity, INCIDENT_SEVERITIES, "incidentTicket.severity");
  assertString(incidentTicket.title, "incidentTicket.title");
  assertString(incidentTicket.description, "incidentTicket.description");
  assertString(incidentTicket.customerImpact, "incidentTicket.customerImpact");
  assertString(incidentTicket.reportedTime, "incidentTicket.reportedTime");
  assertString(incidentTicket.clusterName, "incidentTicket.clusterName");
  assertString(incidentTicket.region, "incidentTicket.region");
  assertString(clusterContext.name, "clusterContext.name");
  assertString(clusterContext.version, "clusterContext.version");
  assertString(clusterContext.region, "clusterContext.region");
  if (typeof clusterContext.nodeCount !== "number") {
    throw invalidCatalog(
      `Catalog scenario ${filePath} must include numeric clusterContext.nodeCount`,
    );
  }
  assertString(clusterContext.status, "clusterContext.status");
  assertStringArray(clusterContext.recentEvents, "clusterContext.recentEvents");
  assertArray(clusterContext.alerts, "clusterContext.alerts");
  for (const [index, alert] of clusterContext.alerts.entries()) {
    if (!isRecord(alert)) {
      throw invalidCatalog(
        `Catalog scenario field clusterContext.alerts[${index}] must be an object`,
      );
    }
    assertString(alert.name, `clusterContext.alerts[${index}].name`);
    assertEnum(
      alert.severity,
      ALERT_SEVERITIES,
      `clusterContext.alerts[${index}].severity`,
    );
    assertString(alert.message, `clusterContext.alerts[${index}].message`);
    assertString(alert.firingTime, `clusterContext.alerts[${index}].firingTime`);
  }
  assertArray(clusterContext.upgradeHistory, "clusterContext.upgradeHistory");
  for (const [index, event] of clusterContext.upgradeHistory.entries()) {
    if (!isRecord(event)) {
      throw invalidCatalog(
        `Catalog scenario field clusterContext.upgradeHistory[${index}] must be an object`,
      );
    }
    assertString(event.from, `clusterContext.upgradeHistory[${index}].from`);
    assertString(event.to, `clusterContext.upgradeHistory[${index}].to`);
    assertEnum(
      event.status,
      UPGRADE_STATUSES,
      `clusterContext.upgradeHistory[${index}].status`,
    );
    assertString(
      event.timestamp,
      `clusterContext.upgradeHistory[${index}].timestamp`,
    );
  }

  return value as unknown as Scenario;
}

function replaceTimePlaceholders(value: string): string {
  return value.replace(
    /\{\{(minutesAgo|daysAgo):(\d+)\}\}/g,
    (_match, unit: string, rawAmount: string) => {
      const amount = Number.parseInt(rawAmount, 10);
      const minutes = unit === "daysAgo" ? amount * 24 * 60 : amount;
      return utcOffsetMinutes(-minutes);
    },
  );
}

function hydrateScenarioTemplate<T>(value: T): T {
  if (typeof value === "string") {
    return replaceTimePlaceholders(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => hydrateScenarioTemplate(entry)) as T;
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        hydrateScenarioTemplate(entry),
      ]),
    ) as T;
  }

  return value;
}

function getCatalogRootCandidates(): string[] {
  const envDir = process.env.SCENARIO_CATALOG_DIR?.trim();
  const candidates = [
    envDir,
    resolve(process.cwd(), "../scenarios"),
    resolve(process.cwd(), "scenarios"),
    resolve(__dirname, "../../../scenarios"),
    resolve(__dirname, "../../../../scenarios"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return [...new Set(candidates)];
}

async function resolveCatalogRoot(): Promise<string | null> {
  for (const candidate of getCatalogRootCandidates()) {
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  return null;
}

async function loadCatalogDirectory(
  rootDir: string,
  difficulty: Difficulty,
): Promise<Scenario[]> {
  const difficultyDir = join(rootDir, difficulty);
  let fileNames: string[];
  try {
    fileNames = await readdir(difficultyDir);
  } catch {
    return [];
  }

  const scenarioFiles = fileNames
    .filter((name) => name.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right));

  const scenarios = await Promise.all(
    scenarioFiles.map(async (fileName) => {
      const filePath = join(difficultyDir, fileName);
      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch (error) {
        throw invalidCatalog(
          `Catalog scenario ${filePath} could not be read: ${
            error instanceof Error ? error.message : "read failure"
          }`,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch (error) {
        throw invalidCatalog(
          `Catalog scenario ${filePath} contains invalid JSON: ${
            error instanceof Error ? error.message : "parse failure"
          }`,
        );
      }
      return assertScenarioTemplate(parsed, difficulty, filePath);
    }),
  );

  return scenarios;
}

async function loadCatalog(): Promise<ScenarioCatalog> {
  const rootDir = await resolveCatalogRoot();
  if (!rootDir) {
    return { easy: [], medium: [], hard: [] };
  }

  const entries = await Promise.all(
    DIFFICULTIES.map(async (difficulty) => [
      difficulty,
      await loadCatalogDirectory(rootDir, difficulty),
    ] as const),
  );

  return Object.fromEntries(entries) as ScenarioCatalog;
}

export function isCatalogScenarioSource(): boolean {
  return (
    process.env.SCENARIO_SOURCE?.trim().toLowerCase() === CATALOG_SOURCE
  );
}

export async function getCatalogScenario(
  difficulty: Difficulty,
): Promise<Scenario> {
  if (!cachedCatalogPromise) {
    cachedCatalogPromise = loadCatalog().catch((error) => {
      cachedCatalogPromise = null;
      throw error;
    });
  }

  const catalog = await cachedCatalogPromise;
  const template = catalog[difficulty][0];
  if (!template) {
    throw unavailableCatalog(difficulty);
  }

  return hydrateScenarioTemplate(template);
}
