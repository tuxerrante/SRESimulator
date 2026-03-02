import { Router } from "express";

export const healthRouter = Router();

healthRouter.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

healthRouter.get("/readyz", (_req, res) => {
  res.json({ status: "ready" });
});
