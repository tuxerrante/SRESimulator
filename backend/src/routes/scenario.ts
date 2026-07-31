import { Router, type Request, type Response } from "express";
import { loadKnowledgeBase } from "../lib/knowledge";
import {
  getAnonymousTrialStore,
  getMetricsStore,
  getPlayerStore,
  getSessionStore,
} from "../lib/storage";
import { getAiReadiness } from "../lib/ai-config";
import { generateMockScenario } from "../lib/mock-ai";
import { generateAiText, AiThrottledError } from "../lib/ai-runtime";
import {
  getCatalogScenario,
  isCatalogScenarioSource,
  ScenarioCatalogError,
} from "../lib/scenario-catalog";
import { getRuntimePlatformProfile } from "../lib/platform-profiles";
import { buildScenarioGenerationPrompt } from "../lib/prompts/scenario-generator";
import { utcNow } from "../lib/sim-clock";
import { verifyTurnstileToken } from "../lib/turnstile";
import { isPlatformContext } from "../lib/scenario-validation";
import {
  readAnonymousProofFromCookieHeader,
  readViewerFromCookieHeader,
} from "../lib/viewer-auth";
import { buildAnonymousClaimKeys } from "../lib/anonymous-claim";
import { evaluateScenarioAccess } from "../lib/scenario-access";
import { matchesSharedSecret } from "../lib/shared-secret";
import { captureBackendRouteError } from "../lib/telemetry/capture";
import { parsePositiveIntEnv } from "../lib/env";
import { withAbortTimeout } from "../lib/timeout";
import { verifySignedClientIp } from "../../../shared/auth/client-ip";
import type { Difficulty, Scenario } from "../../../shared/types/game";
import {
  DEFAULT_PLATFORM_ID,
  PLATFORM_IDS,
  type PlatformId,
} from "../../../shared/types/platform";
import type { TrafficSource } from "../../../shared/types/leaderboard";

export const scenarioRouter = Router();
const VALID_DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];
const ANONYMOUS_TRIAL_TTL_MS = 24 * 60 * 60 * 1000;

interface ScenarioRequestBody {
  platform?: PlatformId;
  difficulty: Difficulty;
  turnstileToken?: string;
}

const INCIDENT_SEVERITIES = ["Sev1", "Sev2", "Sev3", "Sev4"] as const;
const ALERT_SEVERITIES = ["critical", "warning", "info"] as const;
const UPGRADE_STATUSES = ["completed", "failed", "in_progress"] as const;
const MAX_RECENT_EVENTS = 50;
const MAX_ALERTS = 20;
const MAX_UPGRADE_HISTORY = 20;
const ISO_8601_UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;
const TIMESTAMP_GRACE_MS = 5 * 60 * 1000;
const DEFAULT_SCENARIO_TIMEOUT_MS = 30000;

class InvalidScenarioPayloadError extends Error {
  readonly clientMessage = "Scenario generation returned an invalid payload.";

  constructor(message: string) {
    super(message);
    this.name = "InvalidScenarioPayloadError";
  }
}

class ScenarioGenerationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Scenario generation timed out after ${timeoutMs}ms`);
    this.name = "ScenarioGenerationTimeoutError";
  }
}

function getScenarioTimeoutMs(): number {
  return parsePositiveIntEnv(process.env.AI_SCENARIO_TIMEOUT_MS, DEFAULT_SCENARIO_TIMEOUT_MS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parsePlatform(value: unknown): PlatformId | null {
  if (typeof value !== "string") {
    return null;
  }
  return PLATFORM_IDS.includes(value as PlatformId)
    ? (value as PlatformId)
    : null;
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidScenarioPayloadError(`AI scenario field ${field} must be a non-empty string`);
  }
}

function assertEnum<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): asserts value is T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new InvalidScenarioPayloadError(
      `AI scenario field ${field} must be one of: ${allowed.join(", ")}`,
    );
  }
}

function assertIsoTimestamp(value: unknown, field: string): Date {
  assertNonEmptyString(value, field);
  if (!ISO_8601_UTC_TIMESTAMP_PATTERN.test(value)) {
    throw new InvalidScenarioPayloadError(`AI scenario field ${field} must be an ISO 8601 timestamp`);
  }

  const normalized = value.includes(".")
    ? value.replace(/\.(\d{1,3})Z$/, (_, ms: string) => `.${ms.padEnd(3, "0")}Z`)
    : value.replace(/Z$/, ".000Z");
  const parsed = new Date(normalized);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString() !== normalized
  ) {
    throw new InvalidScenarioPayloadError(`AI scenario field ${field} must be an ISO 8601 timestamp`);
  }

  return parsed;
}

function assertStringArray(
  value: unknown,
  field: string,
  maxItems: number,
): asserts value is string[] {
  if (!Array.isArray(value)) {
    throw new InvalidScenarioPayloadError(`AI scenario field ${field} must be an array`);
  }
  if (value.length > maxItems) {
    throw new InvalidScenarioPayloadError(
      `AI scenario field ${field} must contain at most ${maxItems} items`,
    );
  }
  for (const [index, entry] of value.entries()) {
    assertNonEmptyString(entry, `${field}[${index}]`);
  }
}

function validateScenarioPayload(
  payload: unknown,
  platform: PlatformId,
  difficulty: Difficulty,
): Scenario {
  if (!isRecord(payload)) {
    throw new InvalidScenarioPayloadError("AI scenario payload must be a JSON object");
  }

  assertNonEmptyString(payload.id, "id");
  if (payload.platform !== platform) {
    throw new InvalidScenarioPayloadError(`AI scenario platform must be ${platform}`);
  }
  assertNonEmptyString(payload.title, "title");
  assertNonEmptyString(payload.description, "description");
  if (payload.difficulty !== difficulty) {
    throw new InvalidScenarioPayloadError(`AI scenario difficulty must be ${difficulty}`);
  }

  const incidentTicket = payload.incidentTicket;
  const clusterContext = payload.clusterContext;
  if (!isRecord(incidentTicket) || !isRecord(clusterContext)) {
    throw new InvalidScenarioPayloadError(
      "AI scenario payload must include incidentTicket and clusterContext objects",
    );
  }

  assertNonEmptyString(incidentTicket.id, "incidentTicket.id");
  assertEnum(incidentTicket.severity, INCIDENT_SEVERITIES, "incidentTicket.severity");
  assertNonEmptyString(incidentTicket.title, "incidentTicket.title");
  assertNonEmptyString(incidentTicket.description, "incidentTicket.description");
  assertNonEmptyString(incidentTicket.customerImpact, "incidentTicket.customerImpact");
  const reportedTime = assertIsoTimestamp(incidentTicket.reportedTime, "incidentTicket.reportedTime");
  assertNonEmptyString(incidentTicket.clusterName, "incidentTicket.clusterName");
  assertNonEmptyString(incidentTicket.region, "incidentTicket.region");
  const now = Date.now();
  const reportedAgeMs = now - reportedTime.getTime();
  if (
    reportedAgeMs < ONE_DAY_MS - TIMESTAMP_GRACE_MS ||
    reportedAgeMs > SEVEN_DAYS_MS + TIMESTAMP_GRACE_MS
  ) {
    throw new InvalidScenarioPayloadError(
      "AI scenario field incidentTicket.reportedTime must be within the past 1-7 days",
    );
  }

  assertNonEmptyString(clusterContext.name, "clusterContext.name");
  assertNonEmptyString(clusterContext.version, "clusterContext.version");
  assertNonEmptyString(clusterContext.region, "clusterContext.region");
  if (incidentTicket.clusterName !== clusterContext.name) {
    throw new InvalidScenarioPayloadError(
      "AI scenario fields incidentTicket.clusterName and clusterContext.name must match",
    );
  }
  if (
    incidentTicket.region.trim().toLowerCase() !==
    clusterContext.region.trim().toLowerCase()
  ) {
    throw new InvalidScenarioPayloadError(
      "AI scenario fields incidentTicket.region and clusterContext.region must match",
    );
  }
  if (
    typeof clusterContext.nodeCount !== "number" ||
    !Number.isFinite(clusterContext.nodeCount) ||
    !Number.isInteger(clusterContext.nodeCount) ||
    clusterContext.nodeCount < 1
  ) {
    throw new InvalidScenarioPayloadError(
      "AI scenario field clusterContext.nodeCount must be a positive integer",
    );
  }
  assertNonEmptyString(clusterContext.status, "clusterContext.status");
  assertStringArray(clusterContext.recentEvents, "clusterContext.recentEvents", MAX_RECENT_EVENTS);

  if (!Array.isArray(clusterContext.alerts)) {
    throw new InvalidScenarioPayloadError("AI scenario field clusterContext.alerts must be an array");
  }
  if (clusterContext.alerts.length > MAX_ALERTS) {
    throw new InvalidScenarioPayloadError(
      `AI scenario field clusterContext.alerts must contain at most ${MAX_ALERTS} items`,
    );
  }
  for (const [index, alert] of clusterContext.alerts.entries()) {
    if (!isRecord(alert)) {
      throw new InvalidScenarioPayloadError(
        `AI scenario field clusterContext.alerts[${index}] must be an object`,
      );
    }
    assertNonEmptyString(alert.name, `clusterContext.alerts[${index}].name`);
    assertEnum(alert.severity, ALERT_SEVERITIES, `clusterContext.alerts[${index}].severity`);
    assertNonEmptyString(alert.message, `clusterContext.alerts[${index}].message`);
    const firingTime = assertIsoTimestamp(alert.firingTime, `clusterContext.alerts[${index}].firingTime`);
    const firingAgeMs = now - firingTime.getTime();
    if (
      firingAgeMs < -TIMESTAMP_GRACE_MS ||
      firingAgeMs > SEVEN_DAYS_MS + TIMESTAMP_GRACE_MS
    ) {
      throw new InvalidScenarioPayloadError(
        `AI scenario field clusterContext.alerts[${index}].firingTime must be within the past 7 days (allowing ${TIMESTAMP_GRACE_MS / (60 * 1000)} minutes of clock skew)`,
      );
    }
  }

  if (!Array.isArray(clusterContext.upgradeHistory)) {
    throw new InvalidScenarioPayloadError(
      "AI scenario field clusterContext.upgradeHistory must be an array",
    );
  }
  if (clusterContext.upgradeHistory.length > MAX_UPGRADE_HISTORY) {
    throw new InvalidScenarioPayloadError(
      `AI scenario field clusterContext.upgradeHistory must contain at most ${MAX_UPGRADE_HISTORY} items`,
    );
  }
  for (const [index, upgrade] of clusterContext.upgradeHistory.entries()) {
    if (!isRecord(upgrade)) {
      throw new InvalidScenarioPayloadError(
        `AI scenario field clusterContext.upgradeHistory[${index}] must be an object`,
      );
    }
    assertNonEmptyString(upgrade.from, `clusterContext.upgradeHistory[${index}].from`);
    assertNonEmptyString(upgrade.to, `clusterContext.upgradeHistory[${index}].to`);
    assertEnum(
      upgrade.status,
      UPGRADE_STATUSES,
      `clusterContext.upgradeHistory[${index}].status`,
    );
    const upgradeTimestamp = assertIsoTimestamp(
      upgrade.timestamp,
      `clusterContext.upgradeHistory[${index}].timestamp`,
    );
    if (upgradeTimestamp.getTime() > now) {
      throw new InvalidScenarioPayloadError(
        `AI scenario field clusterContext.upgradeHistory[${index}].timestamp must not be in the future`,
      );
    }
  }

  if (
    payload.platformContext !== undefined &&
    !isPlatformContext(payload.platformContext)
  ) {
    throw new InvalidScenarioPayloadError(
      "AI scenario field platformContext must use only supported platform metadata with non-empty string values",
    );
  }

  return payload as unknown as Scenario;
}

function getTrafficSource(req: Request): TrafficSource {
  const requestedSource = req.get("x-traffic-source")?.trim().toLowerCase();
  if (requestedSource !== "automated") {
    return "player";
  }

  const expectedToken = process.env.AUTOMATED_TRAFFIC_TOKEN?.trim();
  const providedToken = req.get("x-traffic-source-token");
  if (!matchesSharedSecret(providedToken, expectedToken)) {
    return "player";
  }

  return "automated";
}

function getClientIp(req: Request, secret: string | undefined): string | undefined {
  const forwardedIp = req.get("x-sresim-client-ip")?.trim();
  const forwardedSignature = req.get("x-sresim-client-ip-signature")?.trim();

  if (
    secret &&
    forwardedIp &&
    forwardedSignature &&
    verifySignedClientIp(forwardedIp, forwardedSignature, secret)
  ) {
    return forwardedIp;
  }

  return undefined;
}

function getDecisionStatus(
  code: "github_required" | "anonymous_verification_required" | "anonymous_daily_limit_reached"
): number {
  if (code === "anonymous_daily_limit_reached") {
    return 429;
  }
  if (code === "anonymous_verification_required") {
    return 400;
  }
  return 403;
}

async function recordStartedTelemetry(
  sessionToken: string,
  platform: PlatformId,
  difficulty: Difficulty,
  scenarioTitle: string,
  trafficSource: TrafficSource,
  source = "scenario",
): Promise<void> {
  try {
    await getMetricsStore().recordGameplay({
      sessionToken,
      platform,
      trafficSource,
      difficulty,
      scenarioTitle,
      lifecycleState: "started",
      completed: false,
      metadata: { source },
    });
  } catch (error) {
    console.warn("Failed to record scenario gameplay telemetry", {
      sessionTokenPrefix: sessionToken.slice(0, 8),
      platform,
      difficulty,
      scenarioTitle,
      error,
    });
  }
}

scenarioRouter.post("/", async (req: Request, res: Response) => {
  let reservedClaimKeys: string[] = [];
  let claimReservationCommitted = false;
  try {
    const body: ScenarioRequestBody = req.body;
    const { difficulty, turnstileToken } = body;
    const platform =
      body.platform === undefined
        ? DEFAULT_PLATFORM_ID
        : parsePlatform(body.platform);

    if (!VALID_DIFFICULTIES.includes(difficulty)) {
      res.status(400).json({
        error: "Invalid difficulty. Must be easy, medium, or hard.",
      });
      return;
    }
    if (body.platform !== undefined && !platform) {
      res.status(400).json({
        error: `Invalid platform. Must be ${PLATFORM_IDS.join(", ")}.`,
      });
      return;
    }
    if (!platform) {
      res.status(400).json({
        error: `Invalid platform. Must be ${PLATFORM_IDS.join(", ")}.`,
      });
      return;
    }

    const authSecret = process.env.AUTH_SESSION_SECRET;
    const viewer = authSecret
      ? readViewerFromCookieHeader(req.headers.cookie, authSecret)
      : null;
    const antiAbuseSecret = process.env.ANTI_ABUSE_HMAC_SECRET;
    const clientIp = getClientIp(req, antiAbuseSecret);
    const userAgent = req.get("user-agent") ?? "unknown";
    const anonymousProof =
      !viewer && antiAbuseSecret
        ? readAnonymousProofFromCookieHeader(req.headers.cookie, antiAbuseSecret, userAgent)
        : null;
    const anonymousClaimKeys =
      !viewer && anonymousProof && antiAbuseSecret
        ? buildAnonymousClaimKeys(
            {
              fingerprintHash: anonymousProof.fingerprintHash,
              ip: clientIp,
              userAgent,
            },
            antiAbuseSecret
          )
        : [];
    const hasActiveAnonymousClaim =
      anonymousClaimKeys.length > 0
        ? (
            await Promise.all(
              anonymousClaimKeys.map((claimKey) =>
                getAnonymousTrialStore().hasActiveClaim(claimKey)
              )
            )
          ).some(Boolean)
        : false;
    const hasValidTurnstileToken = viewer
      ? true
      : await verifyTurnstileToken(turnstileToken, clientIp);

    const accessDecision = evaluateScenarioAccess({
      difficulty,
      viewer,
      hasValidTurnstileToken,
      hasAnonymousProof: Boolean(anonymousProof),
      hasActiveAnonymousClaim,
    });

    if (!viewer && difficulty === "easy" && !antiAbuseSecret) {
      res.status(503).json({ error: "Anonymous anti-abuse policy is not configured" });
      return;
    }

    if (!accessDecision.allowed) {
      res.status(getDecisionStatus(accessDecision.code)).json({
        error: accessDecision.message,
        code: accessDecision.code,
      });
      return;
    }

    if (viewer) {
      await getPlayerStore().upsertGithubViewer(viewer);
    }

    const reserveAnonymousClaimKeys = async (): Promise<string[]> => {
      if (accessDecision.sessionIdentityKind !== "anonymous") {
        return [];
      }

      const now = Date.now();
      const reserved = await getAnonymousTrialStore().reserveClaimKeys(anonymousClaimKeys, {
        claimKey: anonymousClaimKeys[0] ?? "anonymous",
        createdAt: now,
        expiresAt: now + ANONYMOUS_TRIAL_TTL_MS,
      });
      if (!reserved) {
        res.status(429).json({
          error: "Anonymous Easy mode is limited to one run per day.",
          code: "anonymous_daily_limit_reached",
        });
        throw new Error("anonymous_claim_conflict");
      }

      return anonymousClaimKeys;
    };

    const createSessionForScenario = async (
      scenario: Scenario,
      source = "scenario",
    ): Promise<{
      sessionToken: string;
      identityKind: "github" | "anonymous";
    }> => {
      const trafficSource = getTrafficSource(req);
      const sessionToken = await getSessionStore().create({
        platform,
        difficulty,
        scenarioId: scenario.id,
        scenarioTitle: scenario.title,
        scenarioPayload: JSON.stringify(scenario),
        trafficSource,
        identityKind: accessDecision.sessionIdentityKind,
        githubUserId: viewer?.githubUserId ?? null,
        githubLogin: viewer?.githubLogin ?? null,
        anonymousClaimKey: reservedClaimKeys[0] ?? null,
        persistentScoreEligible: accessDecision.sessionIdentityKind === "github",
      });
      claimReservationCommitted = true;
      void recordStartedTelemetry(
        sessionToken,
        platform,
        difficulty,
        scenario.title,
        trafficSource,
        source,
      );

      return {
        sessionToken,
        identityKind: accessDecision.sessionIdentityKind,
      };
    };

    if (isCatalogScenarioSource()) {
      reservedClaimKeys = await reserveAnonymousClaimKeys();
      const catalogScenario = await getCatalogScenario({ platform, difficulty });
      const session = await createSessionForScenario(catalogScenario, "scenario-catalog");
      res.json({
        scenario: catalogScenario,
        sessionToken: session.sessionToken,
        identityKind: session.identityKind,
      });
      return;
    }

    const readiness = getAiReadiness();
    if (readiness.mockMode) {
      reservedClaimKeys = await reserveAnonymousClaimKeys();
      const scenario = generateMockScenario(difficulty, platform);
      const session = await createSessionForScenario(scenario);
      res.json({ scenario, sessionToken: session.sessionToken, identityKind: session.identityKind });
      return;
    }
    if (!readiness.ready) {
      res.status(503).json({
        error: "AI runtime configuration is invalid",
        details: readiness.reasons,
      });
      return;
    }

    reservedClaimKeys = await reserveAnonymousClaimKeys();
    const knowledgeBase = await loadKnowledgeBase(platform);
    const profile = getRuntimePlatformProfile(platform);

    // Extract only scenario-relevant context from the knowledge base
    const scenarioContext = knowledgeBase
      .split("\n")
      .filter((line) => {
        const l = line.trim().toLowerCase();
        return (
          l.startsWith("#") ||
          l.startsWith("- ") ||
          l.includes("alert") ||
          l.includes("scenario") ||
          l.includes("symptom") ||
          l.includes("error") ||
          l.includes("failure") ||
          l.includes("cluster") ||
          l.includes("node") ||
          l.includes("pod") ||
          l.includes("version") ||
          l === ""
        );
      })
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      // Keep scenario generation fast by limiting prompt context size.
      .slice(0, 6000);

    const currentDate = utcNow();

    const responseText = await withAbortTimeout(
      (signal) =>
        generateAiText({
          maxTokens: 1024,
          route: "scenario",
          _reasoningEffortOverride: "low",
          signal,
          system: buildScenarioGenerationPrompt({
            platform,
            difficulty,
            currentDate,
            scenarioContext,
          }),
          messages: [
            {
              role: "user",
              content: `Generate a ${difficulty} difficulty ${profile.label} incident scenario.`,
            },
          ],
        }),
      getScenarioTimeoutMs(),
      (timeoutMs) => new ScenarioGenerationTimeoutError(timeoutMs),
    );

    let text = responseText;

    // Strip markdown code fences if present
    text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

    let rawScenario: unknown;
    try {
      rawScenario = JSON.parse(text) as unknown;
    } catch {
      throw new InvalidScenarioPayloadError("AI scenario response was not valid JSON");
    }
    const scenario = validateScenarioPayload(rawScenario, platform, difficulty);

    const session = await createSessionForScenario(scenario);

    res.json({ scenario, sessionToken: session.sessionToken, identityKind: session.identityKind });
  } catch (error) {
    if (reservedClaimKeys.length > 0 && !claimReservationCommitted) {
      await getAnonymousTrialStore().releaseClaimKeys(reservedClaimKeys);
    }
    if (error instanceof Error && error.message === "anonymous_claim_conflict") {
      return;
    }
    if (error instanceof AiThrottledError) {
      res.status(429).json({ error: error.message });
      return;
    }
    if (error instanceof ScenarioGenerationTimeoutError) {
      res.status(504).json({ error: "Scenario generation timed out. Please retry." });
      return;
    }
    if (error instanceof InvalidScenarioPayloadError) {
      console.warn("Invalid AI scenario payload", { message: error.message });
      res.status(502).json({ error: error.clientMessage });
      return;
    }
    if (error instanceof ScenarioCatalogError) {
      console.warn("Scenario catalog error", { message: error.message });
      res.status(error.status).json({ error: error.clientMessage });
      return;
    }
    captureBackendRouteError(req, error);
    res.status(500).json({ error: "Scenario generation failed" });
  }
});
