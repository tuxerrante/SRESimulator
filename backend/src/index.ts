import express from "express";
import cors from "cors";
import { chatRouter } from "./routes/chat";
import { commandRouter } from "./routes/command";
import { scenarioRouter } from "./routes/scenario";
import { scoresRouter } from "./routes/scores";
import { healthRouter } from "./routes/health";
import { aiRouter } from "./routes/ai";
import { guideRouter } from "./routes/guide";
import { getAiReadiness } from "./lib/ai-config";
import { aiRateLimit } from "./lib/rate-limit";
import { initStorage, shutdownStorage, getStorageBackend } from "./lib/storage";

async function main() {
  const aiReadiness = getAiReadiness();

  if (aiReadiness.strictStartup && !aiReadiness.ready) {
    throw new Error(
      `Backend startup blocked: ${aiReadiness.reasons.join("; ")}`
    );
  }

  await initStorage();
  console.log(`[startup] storage backend: ${getStorageBackend()}`);

  const app = express();
  const PORT = parseInt(process.env.PORT || "8080", 10);

  app.use(cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:3000",
  }));
  app.use(express.json());

  app.use("/api/chat", aiRateLimit, chatRouter);
  app.use("/api/command", aiRateLimit, commandRouter);
  app.use("/api/scenario", aiRateLimit, scenarioRouter);
  app.use("/api/scores", scoresRouter);
  app.use("/api/ai", aiRouter);
  app.use("/api/guide", guideRouter);
  app.use("/", healthRouter);

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Backend listening on port ${PORT}`);
  });

  const shutdown = async () => {
    console.log("[shutdown] closing server...");
    await new Promise<void>((resolve, reject) => {
      server.close((err?: Error) => {
        if (err) {
          console.error("[shutdown] error while closing server:", err);
          return reject(err);
        }
        resolve();
      });
    });
    await shutdownStorage();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
