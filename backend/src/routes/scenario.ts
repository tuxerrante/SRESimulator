import { Router, type Request, type Response } from "express";
import { loadKnowledgeBase } from "../lib/knowledge";
import { getAnonymousTrialStore, getPlayerStore, getSessionStore } from "../lib/storage";
import { getAiReadiness } from "../lib/ai-config";
import { generateMockScenario } from "../lib/mock-ai";
import { generateAiText, AiThrottledError } from "../lib/ai-runtime";
import { utcNow } from "../lib/sim-clock";
import { verifyTurnstileToken } from "../lib/turnstile";
import { readViewerFromCookieHeader } from "../lib/viewer-auth";
import { buildAnonymousClaimKey } from "../lib/anonymous-claim";
import { evaluateScenarioAccess } from "../lib/scenario-access";
import type { Difficulty, Scenario } from "../../../shared/types/game";

export const scenarioRouter = Router();
const VALID_DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];
const ANONYMOUS_TRIAL_TTL_MS = 24 * 60 * 60 * 1000;

interface ScenarioRequestBody {
  difficulty: Difficulty;
  turnstileToken?: string;
  fingerprintHash?: string;
}

function getClientIp(req: Request): string | undefined {
  return (
    req.ip ??
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ??
    undefined
  );
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

scenarioRouter.post("/", async (req: Request, res: Response) => {
  try {
    const body: ScenarioRequestBody = req.body;
    const { difficulty, turnstileToken, fingerprintHash } = body;

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
    const clientIp = getClientIp(req);
    const antiAbuseSecret = process.env.ANTI_ABUSE_HMAC_SECRET;

    if (!viewer && !antiAbuseSecret) {
      res.status(503).json({ error: "Anonymous anti-abuse policy is not configured" });
      return;
    }

    let anonymousClaimKey: string | null = null;
    if (!viewer && fingerprintHash && antiAbuseSecret) {
      anonymousClaimKey = buildAnonymousClaimKey(
        {
          fingerprintHash,
          ip: clientIp ?? "unknown",
          userAgent: req.get("user-agent") ?? "unknown",
        },
        antiAbuseSecret
      );
    }

    const hasActiveAnonymousClaim = anonymousClaimKey
      ? await getAnonymousTrialStore().hasActiveClaim(anonymousClaimKey)
      : false;
    const hasValidTurnstileToken = viewer
      ? true
      : await verifyTurnstileToken(turnstileToken, clientIp);

    const accessDecision = evaluateScenarioAccess({
      difficulty,
      viewer,
      hasValidTurnstileToken,
      fingerprintHash: fingerprintHash ?? null,
      hasActiveAnonymousClaim,
    });

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

    const readiness = getAiReadiness();
    if (readiness.mockMode) {
      const scenario = generateMockScenario(difficulty);
      if (accessDecision.sessionIdentityKind === "anonymous" && anonymousClaimKey) {
        const now = Date.now();
        await getAnonymousTrialStore().createOrRefreshClaim({
          claimKey: anonymousClaimKey,
          createdAt: now,
          expiresAt: now + ANONYMOUS_TRIAL_TTL_MS,
        });
      }
      const sessionToken = await getSessionStore().create({
        difficulty,
        scenarioTitle: scenario.title,
        identityKind: accessDecision.sessionIdentityKind,
        githubUserId: viewer?.githubUserId ?? null,
        githubLogin: viewer?.githubLogin ?? null,
        anonymousClaimKey,
        persistentScoreEligible: accessDecision.sessionIdentityKind === "github",
      });
      res.json({ scenario, sessionToken, identityKind: accessDecision.sessionIdentityKind });
      return;
    }
    if (!readiness.ready) {
      res.status(503).json({
        error: "AI runtime configuration is invalid",
        details: readiness.reasons,
      });
      return;
    }

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

    if (accessDecision.sessionIdentityKind === "anonymous" && anonymousClaimKey) {
      const now = Date.now();
      await getAnonymousTrialStore().createOrRefreshClaim({
        claimKey: anonymousClaimKey,
        createdAt: now,
        expiresAt: now + ANONYMOUS_TRIAL_TTL_MS,
      });
    }

    const sessionToken = await getSessionStore().create({
      difficulty,
      scenarioTitle: scenario.title,
      identityKind: accessDecision.sessionIdentityKind,
      githubUserId: viewer?.githubUserId ?? null,
      githubLogin: viewer?.githubLogin ?? null,
      anonymousClaimKey,
      persistentScoreEligible: accessDecision.sessionIdentityKind === "github",
    });

    res.json({ scenario, sessionToken, identityKind: accessDecision.sessionIdentityKind });
  } catch (error) {
    if (error instanceof AiThrottledError) {
      res.status(429).json({ error: error.message });
      return;
    }
    const message =
      error instanceof Error ? error.message : "Scenario generation failed";
    res.status(500).json({ error: message });
  }
});
