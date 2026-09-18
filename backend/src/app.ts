import express from "express";
import cors from "cors";
import * as Sentry from "@sentry/node";
import { chatRouter } from "./routes/chat";
import { commandRouter } from "./routes/command";
import { scenarioRouter } from "./routes/scenario";
import { scoresRouter } from "./routes/scores";
import { gameplayRouter } from "./routes/gameplay";
import { healthRouter } from "./routes/health";
import { aiRouter } from "./routes/ai";
import { guideRouter } from "./routes/guide";
import {
  applyHttpHardening,
  jsonBodyParserErrorHandler,
  jsonRouteParsers,
} from "./lib/http-hardening";
import { aiRateLimit } from "./lib/rate-limit";
import { aiGlobalBudgetLimit, createAiGlobalBudgetLimit } from "./lib/ai-budget";
import { isCatalogScenarioSource } from "./lib/scenario-catalog";
import { isSentryEnabled } from "./lib/telemetry/sentry";

export function shouldTrustProxyHeaders(): boolean {
  return process.env.TRUST_PROXY_HEADERS === "true";
}

function assertProxyTrustConfiguration(): void {
  if (
    shouldTrustProxyHeaders() &&
    !process.env.ANTI_ABUSE_HMAC_SECRET?.trim()
  ) {
    throw new Error(
      "TRUST_PROXY_HEADERS=true requires ANTI_ABUSE_HMAC_SECRET for signed client IP verification",
    );
  }
}

export function createApp(): express.Express {
  assertProxyTrustConfiguration();
  const app = express();

  // Match the frontend proxy model: forwarded headers are only trusted when explicitly enabled.
  app.set("trust proxy", shouldTrustProxyHeaders());

  applyHttpHardening(app);
  app.use(cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:3000",
  }));

  // The global budget runs *after* the per-identity limiter, for the same
  // reason the daily window is only charged once the minute window allowed the
  // request: a caller the per-identity limiter refuses never reaches the
  // provider, so charging the shared account for it would let one player drain
  // a day's budget on requests that cost nothing. The shared budget is still
  // consulted on every request that gets that far, which is what makes it
  // independent of who sent it.
  app.use("/api/chat", jsonRouteParsers.chat, aiRateLimit, aiGlobalBudgetLimit, chatRouter);
  app.use("/api/command", jsonRouteParsers.command, aiRateLimit, aiGlobalBudgetLimit, commandRouter);
  // Under SCENARIO_SOURCE=catalog this route serves a curated scenario and
  // never calls a model, so it is mounted with a predicate rather than the
  // shared handler.
  app.use(
    "/api/scenario",
    jsonRouteParsers.scenario,
    aiRateLimit,
    createAiGlobalBudgetLimit(() => !isCatalogScenarioSource()),
    scenarioRouter,
  );
  app.use("/api/scores", jsonRouteParsers.scores, scoresRouter);
  app.use("/api/gameplay", jsonRouteParsers.gameplay, gameplayRouter);
  app.use("/api/ai", aiRouter);
  app.use("/api/guide", guideRouter);
  app.use("/", healthRouter);
  app.use(jsonBodyParserErrorHandler);

  if (isSentryEnabled()) {
    Sentry.setupExpressErrorHandler(app);
  }

  return app;
}
