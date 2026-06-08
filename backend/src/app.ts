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

  app.use(cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:3000",
  }));
  applyHttpHardening(app);

  app.use("/api/chat", jsonRouteParsers.chat, aiRateLimit, chatRouter);
  app.use("/api/command", jsonRouteParsers.command, aiRateLimit, commandRouter);
  app.use("/api/scenario", jsonRouteParsers.scenario, aiRateLimit, scenarioRouter);
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
