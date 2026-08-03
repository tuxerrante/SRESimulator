import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { getMetricsStore, getSessionStore } from "../lib/storage";
import { getScenarioRateLimitKey, gameplayTelemetryRateLimit } from "../lib/rate-limit";
import { matchesSharedSecret } from "../lib/shared-secret";
import { captureBackendRouteError } from "../lib/telemetry/capture";
import type { GameplayLifecycleState } from "../../../shared/types/gameplay";
import { PLATFORM_IDS, type PlatformId } from "../../../shared/types/platform";

export const gameplayRouter = Router();

const GAMEPLAY_ADMIN_TOKEN_HEADER = "x-gameplay-admin-token";
const GAMEPLAY_ADMIN_VARY_HEADERS = "Authorization, X-Gameplay-Admin-Token";
const GAMEPLAY_ADMIN_AUTH_KEY = "auth";
const GAMEPLAY_ADMIN_ANON_KEY = "anon";
const MAX_COMMANDS = 50;
const MAX_COMMAND_LENGTH = 200;
const MAX_SCORING_EVENTS = 50;
const MAX_SCORING_EVENTS_JSON_LENGTH = 2000;
const MAX_METADATA_KEYS = 20;
const MAX_METADATA_JSON_LENGTH = 2000;
const DANGEROUS_METADATA_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const VALID_LIFECYCLE_STATES: GameplayLifecycleState[] = [
  "started",
  "completed",
  "abandoned",
];

interface GameplayEventBody {
  sessionToken?: string;
  platform?: PlatformId;
  lifecycleState?: GameplayLifecycleState;
  nickname?: unknown;
  commandCount?: unknown;
  commandsExecuted?: unknown;
  scoringEvents?: unknown;
  chatMessageCount?: unknown;
  durationMs?: unknown;
  scoreTotal?: unknown;
  grade?: unknown;
  metadata?: unknown;
}

function parsePlatformQuery(value: unknown): PlatformId | null {
  if (typeof value !== "string") {
    return null;
  }
  return PLATFORM_IDS.includes(value as PlatformId)
    ? (value as PlatformId)
    : null;
}

function sanitizeString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function sanitizeNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.round(parsed));
}

function sanitizeCommands(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_COMMANDS)
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .map((item) => item.slice(0, MAX_COMMAND_LENGTH))
    .filter(Boolean);
}

function sanitizeScoringEvents(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  const events = value
    .slice(0, MAX_SCORING_EVENTS)
    .filter((item) => typeof item === "object" && item !== null);

  const sanitized: unknown[] = [];
  let totalLength = 2;

  for (const event of events) {
    const serialized = JSON.stringify(event);
    if (!serialized) continue;
    const nextLength = totalLength + serialized.length + (sanitized.length > 0 ? 1 : 0);
    if (nextLength > MAX_SCORING_EVENTS_JSON_LENGTH) break;
    sanitized.push(event);
    totalLength = nextLength;
  }

  return sanitized;
}

function sanitizeMetadata(value: unknown): Record<string, unknown> {
  const createMetadataObject = (): Record<string, unknown> =>
    Object.create(null) as Record<string, unknown>;

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createMetadataObject();
  }

  const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_METADATA_KEYS);
  const sanitized = createMetadataObject();

  for (const [key, entryValue] of entries) {
    if (DANGEROUS_METADATA_KEYS.has(key)) continue;
    sanitized[key] = entryValue;
  }

  if (JSON.stringify(sanitized).length > MAX_METADATA_JSON_LENGTH) {
    const truncated = createMetadataObject();
    truncated.truncated = true;
    return truncated;
  }

  return sanitized;
}

function hasGameplayAdminAccess(req: Request): boolean {
  const expectedToken = process.env.GAMEPLAY_ADMIN_TOKEN?.trim();
  if (!expectedToken) {
    return false;
  }

  const authorization = req.get("authorization")?.trim();
  if (authorization) {
    const [scheme, token, ...rest] = authorization.split(/\s+/);
    if (scheme?.toLowerCase() === "bearer" && token && rest.length === 0) {
      return matchesSharedSecret(token, expectedToken);
    }
  }

  return matchesSharedSecret(req.get(GAMEPLAY_ADMIN_TOKEN_HEADER), expectedToken);
}

function applyAdminResponseHardening(res: Response): void {
  res.set("Cache-Control", "no-store, private");
  res.set("Vary", GAMEPLAY_ADMIN_VARY_HEADERS);
}

function hasPreparedGameplayAdminAccess(res: Response): boolean {
  const value = res.locals.gameplayAdminAuthorized;
  return value === true;
}

function prepareGameplayAdminRequest(req: Request, res: Response, next: () => void): void {
  applyAdminResponseHardening(res);
  res.locals.gameplayAdminAuthorized = hasGameplayAdminAccess(req);
  next();
}

const gameplayAdminRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: () => {
    const parsed = Number.parseInt(process.env.GAMEPLAY_ADMIN_RATE_LIMIT_MAX ?? "15", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 15;
  },
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: "Too many gameplay admin requests. Please retry in a moment.",
  },
  keyGenerator: async (req, res) => {
    const bucket = hasPreparedGameplayAdminAccess(res)
      ? GAMEPLAY_ADMIN_AUTH_KEY
      : GAMEPLAY_ADMIN_ANON_KEY;
    return `${bucket}:${getScenarioRateLimitKey(req)}`;
  },
});

gameplayRouter.post("/", gameplayTelemetryRateLimit, async (req: Request, res: Response) => {
  try {
    const body: GameplayEventBody = req.body;

    if (!body.sessionToken || typeof body.sessionToken !== "string") {
      res.status(400).json({ error: "Session token is required" });
      return;
    }

    if (
      !body.lifecycleState ||
      !VALID_LIFECYCLE_STATES.includes(body.lifecycleState)
    ) {
      res.status(400).json({
        error: "Invalid lifecycle state. Must be started, completed, or abandoned.",
      });
      return;
    }

    const session = await getSessionStore().get(body.sessionToken);
    if (!session) {
      res.status(403).json({ error: "Invalid session token" });
      return;
    }
    if (body.platform !== undefined && body.platform !== session.platform) {
      res.status(409).json({ error: "Session telemetry mismatch" });
      return;
    }

    if (await getMetricsStore().hasLifecycleEvent(body.sessionToken, body.lifecycleState)) {
      res.status(202).json({ ok: true, deduped: true });
      return;
    }

    await getMetricsStore().recordGameplay({
      sessionToken: body.sessionToken,
      platform: session.platform,
      trafficSource: session.trafficSource,
      nickname: sanitizeString(body.nickname, 20),
      difficulty: session.difficulty,
      scenarioTitle: session.scenarioTitle,
      lifecycleState: body.lifecycleState,
      commandCount: sanitizeNumber(body.commandCount),
      commandsExecuted: sanitizeCommands(body.commandsExecuted),
      scoringEvents: sanitizeScoringEvents(body.scoringEvents),
      chatMessageCount: sanitizeNumber(body.chatMessageCount),
      durationMs: sanitizeNumber(body.durationMs),
      scoreTotal: sanitizeNumber(body.scoreTotal),
      grade: sanitizeString(body.grade, 5),
      completed: body.lifecycleState === "completed",
      metadata: sanitizeMetadata(body.metadata),
    });

    res.status(202).json({ ok: true });
  } catch (error) {
    captureBackendRouteError(req, error);
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.error("Failed to record gameplay event", { errorName });
    res.status(500).json({ error: "Failed to record gameplay event" });
  }
});

gameplayRouter.get(
  "/admin",
  prepareGameplayAdminRequest,
  gameplayAdminRateLimit,
  async (req: Request, res: Response) => {
  try {
    if (!hasPreparedGameplayAdminAccess(res)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const platformQuery = req.query.platform;
    const platform =
      platformQuery === undefined ? undefined : parsePlatformQuery(platformQuery);
    if (platformQuery !== undefined && platform === null) {
      res.status(400).json({
        error: `Invalid platform. Must be ${PLATFORM_IDS.join(", ")}.`,
      });
      return;
    }

    const analytics = await getMetricsStore().getGameplayAnalytics(
      platform ? { platform } : undefined,
    );
    res.json(analytics);
  } catch (error) {
    captureBackendRouteError(req, error);
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.error("Failed to read gameplay analytics", { errorName });
    res.status(500).json({ error: "Failed to read gameplay analytics" });
  }
},
);
