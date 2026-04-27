import { Router, type Request, type Response } from "express";
import { getMetricsStore, getSessionStore } from "../lib/storage";
import { gameplayTelemetryRateLimit } from "../lib/rate-limit";
import type { GameplayLifecycleState } from "../../../shared/types/gameplay";

export const gameplayRouter = Router();
gameplayRouter.use(gameplayTelemetryRateLimit);

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
    .filter((item) => typeof item === "object" && item !== null)
    .slice(0, MAX_SCORING_EVENTS);

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

gameplayRouter.post("/", async (req: Request, res: Response) => {
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

    if (await getMetricsStore().hasLifecycleEvent(body.sessionToken, body.lifecycleState)) {
      res.status(202).json({ ok: true, deduped: true });
      return;
    }

    await getMetricsStore().recordGameplay({
      sessionToken: body.sessionToken,
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
    console.error("Failed to record gameplay event", { error });
    res.status(500).json({ error: "Failed to record gameplay event" });
  }
});
