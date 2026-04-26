import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

async function httpRequest(
  app: express.Express,
  method: "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { request } = await import("http");
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Bad address"));
        return;
      }

      const payload = body ? JSON.stringify(body) : undefined;
      const headers: Record<string, string> = {};
      if (payload) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = String(Buffer.byteLength(payload));
      }

      const req = request(
        {
          hostname: "127.0.0.1",
          port: addr.port,
          path,
          method,
          headers,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            server.close();
            resolve({
              status: res.statusCode ?? 500,
              body: JSON.parse(data),
            });
          });
        },
      );

      req.on("error", (error) => {
        server.close();
        reject(error);
      });

      if (payload) req.write(payload);
      req.end();
    });
  });
}

describe("gameplay routes", () => {
  let tmpDir: string;
  let origDataDir: string | undefined;
  let origMockMode: string | undefined;

  let gameplayRouter: typeof import("./gameplay").gameplayRouter;
  let getSessionStore: typeof import("../lib/storage").getSessionStore;
  let getMetricsStore: typeof import("../lib/storage").getMetricsStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gameplay-routes-test-"));
    origDataDir = process.env.DATA_DIR;
    origMockMode = process.env.AI_MOCK_MODE;
    process.env.DATA_DIR = tmpDir;
    process.env.AI_MOCK_MODE = "true";
    delete process.env.STORAGE_BACKEND;

    vi.resetModules();

    const storageModule = await import("../lib/storage");
    await storageModule.initStorage();
    getSessionStore = storageModule.getSessionStore;
    getMetricsStore = storageModule.getMetricsStore;

    const gameplayModule = await import("./gameplay");
    gameplayRouter = gameplayModule.gameplayRouter;
  });

  afterEach(async () => {
    if (origDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = origDataDir;
    }

    if (origMockMode === undefined) {
      delete process.env.AI_MOCK_MODE;
    } else {
      process.env.AI_MOCK_MODE = origMockMode;
    }

    await rm(tmpDir, { recursive: true, force: true });
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use("/api/gameplay", gameplayRouter);
    return app;
  }

  it("POST /api/gameplay records sanitized lifecycle telemetry", async () => {
    const token = await getSessionStore().create("hard", "Etcd Quorum Loss");
    const app = createApp();
    const metadata = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [`key-${index}`, `value-${index}`]),
    );

    const response = await httpRequest(app, "POST", "/api/gameplay", {
      sessionToken: token,
      lifecycleState: "completed",
      nickname: `  ${"player-one-with-a-very-long-name".slice(0, 35)}  `,
      commandCount: "6",
      commandsExecuted: [
        ...Array.from({ length: 60 }, (_, index) => `command-${index}`),
        12,
      ],
      chatMessageCount: "8",
      durationMs: "120000",
      scoreTotal: "88",
      grade: "B+",
      scoringEvents: [
        ...Array.from({ length: 60 }, (_, index) => ({ type: "bonus", points: index })),
        "bad-event",
      ],
      metadata,
    });

    expect(response.status).toBe(202);

    const history = await getMetricsStore().getPlayerHistory("player-one-with-a-ve");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      sessionToken: token,
      lifecycleState: "completed",
      difficulty: "hard",
      scenarioTitle: "Etcd Quorum Loss",
      nickname: "player-one-with-a-ve",
      commandCount: 6,
      commandsExecuted: Array.from({ length: 50 }, (_, index) => `command-${index}`),
      chatMessageCount: 8,
      durationMs: 120000,
      scoreTotal: 88,
      grade: "B+",
      completed: true,
    });
    expect(history[0].scoringEvents).toHaveLength(50);
    expect(history[0].metadata).toEqual(
      Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [`key-${index}`, `value-${index}`]),
      ),
    );
  });

  it("POST /api/gameplay rejects invalid lifecycle states", async () => {
    const token = await getSessionStore().create("easy", "The Sleeping Cluster");
    const app = createApp();

    const response = await httpRequest(app, "POST", "/api/gameplay", {
      sessionToken: token,
      lifecycleState: "paused",
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Invalid lifecycle state");
  });

  it("POST /api/gameplay caps oversized scoring event payloads", async () => {
    const token = await getSessionStore().create("medium", "Bad Egress");
    const app = createApp();

    const response = await httpRequest(app, "POST", "/api/gameplay", {
      sessionToken: token,
      lifecycleState: "abandoned",
      nickname: "size-test",
      scoringEvents: Array.from({ length: 10 }, (_, index) => ({
        type: "bonus",
        payload: `${index}-${"x".repeat(500)}`,
      })),
    });

    expect(response.status).toBe(202);

    const history = await getMetricsStore().getPlayerHistory("size-test");
    expect(history).toHaveLength(1);
    expect(JSON.stringify(history[0].scoringEvents ?? []).length).toBeLessThanOrEqual(2000);
  });

  it("POST /api/gameplay rejects invalid session tokens", async () => {
    const app = createApp();

    const response = await httpRequest(app, "POST", "/api/gameplay", {
      sessionToken: "bad-token",
      lifecycleState: "started",
    });

    expect(response.status).toBe(403);
    expect(response.body.error).toContain("Invalid session token");
  });

  it("POST /api/gameplay still accepts a consumed session token", async () => {
    const token = await getSessionStore().create("easy", "The Sleeping Cluster");
    await getSessionStore().validateAndConsume(token);
    const app = createApp();

    const response = await httpRequest(app, "POST", "/api/gameplay", {
      sessionToken: token,
      lifecycleState: "completed",
      nickname: "after-submit",
    });

    expect(response.status).toBe(202);
    const history = await getMetricsStore().getPlayerHistory("after-submit");
    expect(history).toHaveLength(1);
    expect(history[0].sessionToken).toBe(token);
  });
});
