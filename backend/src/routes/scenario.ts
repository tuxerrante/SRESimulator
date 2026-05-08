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
import { utcNow } from "../lib/sim-clock";
import { verifyTurnstileToken } from "../lib/turnstile";
import {
  readAnonymousProofFromCookieHeader,
  readViewerFromCookieHeader,
} from "../lib/viewer-auth";
import { buildAnonymousClaimKeys } from "../lib/anonymous-claim";
import { evaluateScenarioAccess } from "../lib/scenario-access";
import { matchesSharedSecret } from "../lib/shared-secret";
import { verifySignedClientIp } from "../../../shared/auth/client-ip";
import type { Difficulty, Scenario } from "../../../shared/types/game";
import type { TrafficSource } from "../../../shared/types/leaderboard";

export const scenarioRouter = Router();
const VALID_DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];
const ANONYMOUS_TRIAL_TTL_MS = 24 * 60 * 60 * 1000;

interface ScenarioRequestBody {
  difficulty: Difficulty;
  turnstileToken?: string;
}

function getTrafficSource(req: Request): TrafficSource {
  const requestedSource = req.get("x-traffic-source")?.trim().toLowerCase();
  if (requestedSource !== "automated") {
    return "player";
  }

  const expectedToken = process.env.AUTOMATED_TRAFFIC_TOKEN;
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
  difficulty: Difficulty,
  scenarioTitle: string,
  trafficSource: TrafficSource,
  source = "scenario",
): Promise<void> {
  try {
    await getMetricsStore().recordGameplay({
      sessionToken,
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

    if (!VALID_DIFFICULTIES.includes(difficulty)) {
      res.status(400).json({
        error: "Invalid difficulty. Must be easy, medium, or hard.",
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
      scenarioTitle: string,
      source = "scenario",
    ): Promise<{
      sessionToken: string;
      identityKind: "github" | "anonymous";
    }> => {
      const trafficSource = getTrafficSource(req);
      const sessionToken = await getSessionStore().create({
        difficulty,
        scenarioTitle,
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
        difficulty,
        scenarioTitle,
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
      const catalogScenario = await getCatalogScenario(difficulty);
      const session = await createSessionForScenario(
        catalogScenario.title,
        "scenario-catalog"
      );
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
      const scenario = generateMockScenario(difficulty);
      const session = await createSessionForScenario(scenario.title);
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
    const knowledgeBase = await loadKnowledgeBase();

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

    const responseText = await generateAiText({
      maxTokens: 1024,
      route: "scenario",
      system: `You are a scenario generator for an ARO (Azure Red Hat OpenShift) SRE training simulator.
Generate a realistic incident scenario. Be concise.
The scenario should be appropriate for the "${difficulty}" difficulty level.

Difficulty guidelines:
- easy: Single-component failures, obvious symptoms (e.g., node down, pods crashlooping, simple resource issues)
- medium: Networking, permissions, configuration drift, multi-component interactions
- hard: Deep obscure bugs, race conditions, distributed system failures, cascading failures

Use currently supported ARO versions (4.16–4.20). For easy scenarios, you may use 4.15 (EOL) to test "upgrade your cluster" awareness.

IMPORTANT — timestamps: The current date/time is ${currentDate}. Generate realistic ISO 8601 timestamps — the incident reportedTime should be within the past 1–7 days, while recentEvents and alert firingTimes should be more recent (minutes to hours ago) to feel like a live incident. Upgrade history timestamps can be older. Do NOT use placeholder or obviously fake dates.

IMPORTANT: Respond with ONLY valid JSON matching this exact structure (no markdown, no code fences):
{
  "id": "scenario_xxx",
  "title": "Short descriptive title",
  "difficulty": "${difficulty}",
  "description": "Brief description of what's wrong (for AI context, not shown to user directly)",
  "incidentTicket": {
    "id": "IcM-XXXXXX",
    "severity": "Sev1|Sev2|Sev3|Sev4",
    "title": "Customer-facing incident title",
    "description": "What the customer or monitoring reported",
    "customerImpact": "Description of impact",
    "reportedTime": "ISO 8601 timestamp within the past 1–7 days",
    "clusterName": "realistic-cluster-name",
    "region": "azure-region"
  },
  "clusterContext": {
    "name": "same-cluster-name",
    "version": "4.x.x",
    "region": "same-azure-region",
    "nodeCount": number,
    "status": "current status",
    "recentEvents": ["array of recent cluster events with ISO timestamps"],
    "alerts": [{"name": "alert name", "severity": "critical|warning|info", "message": "alert message", "firingTime": "ISO timestamp"}],
    "upgradeHistory": [{"from": "4.x.x", "to": "4.x.x", "status": "completed|failed|in_progress", "timestamp": "ISO timestamp"}]
  }
}

Reference incidents and alerts:
${scenarioContext}`,
      messages: [
        {
          role: "user",
          content: `Generate a ${difficulty} difficulty ARO incident scenario.`,
        },
      ],
    });

    let text = responseText;

    // Strip markdown code fences if present
    text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

    const scenario: Scenario = JSON.parse(text);

    const session = await createSessionForScenario(scenario.title);

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
    if (error instanceof ScenarioCatalogError) {
      console.warn("Scenario catalog error", { message: error.message });
      res.status(error.status).json({ error: error.clientMessage });
      return;
    }
    const message =
      error instanceof Error ? error.message : "Scenario generation failed";
    res.status(500).json({ error: message });
  }
});
