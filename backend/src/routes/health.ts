import { Router } from "express";
import { getAiReadiness } from "../lib/ai-config";

export const healthRouter = Router();

healthRouter.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

healthRouter.get("/readyz", (_req, res) => {
  const readiness = getAiReadiness();
  if (!readiness.ready) {
    res.status(503).json({
      status: "not-ready",
      component: "ai-runtime",
      reasons: readiness.reasons,
    });
    return;
  }
  res.json({ status: "ready" });
});
