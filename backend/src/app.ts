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
import { aiRateLimit } from "./lib/rate-limit";
import { buildSentryRequestContext } from "./lib/telemetry/request-context";
import { isSentryEnabled } from "./lib/telemetry/sentry";

export function shouldTrustProxyHeaders(): boolean {
  return process.env.TRUST_PROXY_HEADERS === "true";
}

export function createApp(): express.Express {
  const app = express();

  // Match the frontend proxy model: forwarded headers are only trusted when explicitly enabled.
  app.set("trust proxy", shouldTrustProxyHeaders());

  if (isSentryEnabled()) {
    app.use((req, _res, next) => {
      const context = buildSentryRequestContext(req);
      Sentry.setTags(context.tags);
      Sentry.setExtras(context.extra);
      next();
    });
  }

  app.use(cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:3000",
  }));
  app.use(express.json());

  app.use("/api/chat", aiRateLimit, chatRouter);
  app.use("/api/command", aiRateLimit, commandRouter);
  app.use("/api/scenario", aiRateLimit, scenarioRouter);
  app.use("/api/scores", scoresRouter);
  app.use("/api/gameplay", gameplayRouter);
  app.use("/api/ai", aiRouter);
  app.use("/api/guide", guideRouter);
  app.use("/", healthRouter);

  if (isSentryEnabled()) {
    Sentry.setupExpressErrorHandler(app);
  }

  return app;
}
