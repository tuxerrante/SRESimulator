import { Router, type Request, type Response } from "express";
import { getAiReadiness } from "../lib/ai-config";
import { generateAiText } from "../lib/ai-runtime";
import { getTokenMetrics } from "../lib/token-logger";
import {
  chargeAiBudget,
  getAiBudgetSnapshot,
  isAiBudgetStoreUnavailable,
} from "../lib/ai-budget";
import { aiBudgetReadRateLimit } from "../lib/rate-limit";

export const aiRouter = Router();

function isProductionRuntime(): boolean {
  return (process.env.NODE_ENV ?? "").trim().toLowerCase() === "production";
}

aiRouter.get("/readiness", (_req: Request, res: Response) => {
  const readiness = getAiReadiness();
  const statusCode = readiness.ready ? 200 : 503;
  res.status(statusCode).json(readiness);
});

aiRouter.get("/probe", async (req: Request, res: Response) => {
  const readiness = getAiReadiness();
  const liveProbe = req.query.live === "true";

  if (!readiness.ready) {
    res.status(503).json({
      ok: false,
      mode: readiness.mockMode ? "mock" : "live",
      reason: "AI runtime configuration is invalid",
      details: readiness.reasons,
    });
    return;
  }

  if (!liveProbe || readiness.mockMode) {
    res.json({
      ok: true,
      mode: readiness.mockMode ? "mock" : "live",
      provider: readiness.provider,
      model: readiness.model,
      message:
        readiness.mockMode
          ? "Mock mode enabled; skipping live AI probe."
          : "Configuration is valid. Set ?live=true to run a live model probe.",
    });
    return;
  }

  if (isProductionRuntime()) {
    const expectedToken = process.env.AI_LIVE_PROBE_TOKEN?.trim() ?? "";
    const receivedToken = req.header("x-ai-probe-token")?.trim() ?? "";
    if (!expectedToken || receivedToken !== expectedToken) {
      res.status(403).json({
        ok: false,
        mode: "live",
        reason: "Live probe is disabled or unauthorized in production",
      });
      return;
    }
  }

  // The live probe is the fourth way into a provider and the only one the
  // budget did not cover: it calls generateAiText directly rather than through
  // a gameplay route, so every probe spent a request against the shared
  // account without moving `global:ai:*`. The banner would then keep telling
  // players the day was intact while it drained, and the limiter would refuse
  // them late -- which is the failure the account-wide cap exists to prevent.
  //
  // Charged here rather than at the top of the handler: the branches above
  // answer from configuration alone (invalid readiness, mock mode, a
  // non-live probe, an unauthorized production caller) and reach no provider,
  // so charging them would spend the players' day on requests that never left
  // the process. Same rule the gameplay routes follow via `willCallProvider`.
  const budget = await chargeAiBudget(res);
  if (budget === "answered") {
    return;
  }
  if (budget === "exhausted") {
    // Refuses instead of degrading. A probe has no simulated answer to fall
    // back on -- "pong" from the mock generator would assert nothing about the
    // provider, which is the single thing this endpoint exists to check -- and
    // a live call with the day spent comes back as the provider's own 429
    // anyway: the same answer, one slot poorer.
    //
    // Which refusal, though, is not the same question. Failing closed on an
    // unreachable window store also returns `exhausted`, and answering that
    // with "the day is spent, come back tomorrow" is a wrong answer to the
    // operator most likely to be reading it: nothing was observed and nothing
    // was spent, and the outage may be over by the time they act on it. The
    // header already carries the cause -- this is the body catching up.
    if (isAiBudgetStoreUnavailable(res)) {
      res.status(503).json({
        ok: false,
        mode: "live",
        reason:
          "The shared AI budget cannot be checked right now; the live probe was not sent",
        code: "ai_budget_unavailable",
      });
      return;
    }
    res.status(429).json({
      ok: false,
      mode: "live",
      reason: "The shared AI budget is spent; the live probe was not sent",
      code: "ai_budget_exhausted",
    });
    return;
  }

  try {
    const start = Date.now();
    const preview = await generateAiText({
      maxTokens: 256,
      system:
        "You are a health probe assistant. Reply with exactly one word: pong.",
      messages: [{ role: "user", content: "ping" }],
      route: "probe",
      _reasoningEffortOverride: "low",
    });

    const latencyMs = Date.now() - start;

    res.json({
      ok: true,
      mode: "live",
      provider: readiness.provider,
      model: readiness.model,
      latencyMs,
      preview: preview.slice(0, 80),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown probe error";
    res.status(503).json({
      ok: false,
      mode: "live",
      reason: "Live AI probe failed",
      details: [message],
    });
  }
});

aiRouter.get("/token-metrics", (_req: Request, res: Response) => {
  if (isProductionRuntime()) {
    const expectedToken = process.env.AI_LIVE_PROBE_TOKEN?.trim() ?? "";
    const receivedToken = _req.header("x-ai-probe-token")?.trim() ?? "";
    if (!expectedToken || receivedToken !== expectedToken) {
      res.status(403).json({ error: "Unauthorized" });
      return;
    }
  }
  res.json(getTokenMetrics());
});

/**
 * Public, unauthenticated and secret-free: the home page banner reads it to
 * explain why answers may be simulated. Rate-limited because /api/ai/* is not,
 * and this one is read by every visitor.
 *
 * Its own limiter, not `aiRateLimit`: behind the Next.js proxy every anonymous
 * visitor resolves to the same identity, so a per-player cap of 15 a minute
 * would hide the banner from the sixteenth visitor -- see
 * `aiBudgetReadRateLimit`.
 */
aiRouter.get("/budget", aiBudgetReadRateLimit, async (_req: Request, res: Response) => {
  res.json(await getAiBudgetSnapshot());
});
