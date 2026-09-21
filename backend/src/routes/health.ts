import { Router } from "express";
import { getAiReadiness } from "../lib/ai-config";
import { getDbReadiness } from "../lib/storage/db-readiness";

export const healthRouter = Router();

healthRouter.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

healthRouter.get("/readyz", async (_req, res) => {
  const readiness = getAiReadiness();
  if (!readiness.ready) {
    res.status(503).json({
      status: "not-ready",
      component: "ai-runtime",
      reasons: readiness.reasons,
    });
    return;
  }

  // Off unless READYZ_DB_CHECK_INTERVAL_MS is set; see db-readiness.ts for why
  // a database ping on a ten-second probe is the wrong default against Neon.
  const database = await getDbReadiness();
  if (database.state === "failed") {
    res.status(503).json({
      status: "not-ready",
      component: "storage",
      reasons: [database.error],
    });
    return;
  }

  res.json({ status: "ready" });
});
