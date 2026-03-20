import { Router, type Request, type Response } from "express";
import { getAiReadiness } from "../lib/ai-config";
import { getClaudeClient, getClaudeModel } from "../lib/claude";

export const aiRouter = Router();

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
          ? "Mock mode enabled; skipping live Vertex probe."
          : "Configuration is valid. Set ?live=true to run a live model probe.",
    });
    return;
  }

  try {
    const start = Date.now();
    const client = getClaudeClient();
    const response = await client.messages.create({
      model: getClaudeModel(),
      max_tokens: 16,
      system:
        "You are a health probe assistant. Reply with exactly one word: pong.",
      messages: [{ role: "user", content: "ping" }],
    });

    const latencyMs = Date.now() - start;
    const firstBlock = response.content[0];
    const preview =
      firstBlock?.type === "text" ? firstBlock.text.slice(0, 80) : "n/a";

    res.json({
      ok: true,
      mode: "live",
      provider: readiness.provider,
      model: getClaudeModel(),
      latencyMs,
      preview,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown probe error";
    res.status(503).json({
      ok: false,
      mode: "live",
      reason: "Live Vertex probe failed",
      details: [message],
    });
  }
});
