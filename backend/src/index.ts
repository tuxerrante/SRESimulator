import { getAiReadiness } from "./lib/ai-config";
import { initStorage, shutdownStorage, getStorageBackend } from "./lib/storage";
import { createApp } from "./app";

async function main() {
  const aiReadiness = getAiReadiness();

  if (aiReadiness.strictStartup && !aiReadiness.ready) {
    throw new Error(
      `Backend startup blocked: ${aiReadiness.reasons.join("; ")}`
    );
  }

  await initStorage();
  console.log(`[startup] storage backend: ${getStorageBackend()}`);

  const app = createApp();
  const PORT = parseInt(process.env.PORT || "8080", 10);

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Backend listening on port ${PORT}`);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
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

  const onSignal = () => {
    shutdown().catch((err) => {
      console.error("[shutdown] fatal error:", err);
      process.exit(1);
    });
  };

  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
