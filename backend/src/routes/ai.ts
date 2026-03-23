import { Router, type Request, type Response } from "express";
import { getAiReadiness } from "../lib/ai-config";
import { generateAiText } from "../lib/ai-runtime";
import { getTokenMetrics } from "../lib/token-logger";

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

  try {
    const start = Date.now();
    const preview = await generateAiText({
      maxTokens: 16,
      system:
        "You are a health probe assistant. Reply with exactly one word: pong.",
      messages: [{ role: "user", content: "ping" }],
      route: "probe",
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
