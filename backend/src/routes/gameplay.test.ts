import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

async function httpRequest(
  app: express.Express,
  method: "GET" | "POST",
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
  let origStorageBackend: string | undefined;

  let gameplayRouter: typeof import("./gameplay").gameplayRouter;
  let getSessionStore: typeof import("../lib/storage").getSessionStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gameplay-routes-test-"));
    origDataDir = process.env.DATA_DIR;
    origMockMode = process.env.AI_MOCK_MODE;
    origStorageBackend = process.env.STORAGE_BACKEND;
    process.env.DATA_DIR = tmpDir;
    process.env.AI_MOCK_MODE = "true";
    delete process.env.STORAGE_BACKEND;

    vi.resetModules();

    const storageModule = await import("../lib/storage");
    await storageModule.initStorage();
    getSessionStore = storageModule.getSessionStore;

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

    if (origStorageBackend === undefined) {
      delete process.env.STORAGE_BACKEND;
    } else {
      process.env.STORAGE_BACKEND = origStorageBackend;
    }

    await rm(tmpDir, { recursive: true, force: true });
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use("/api/gameplay", gameplayRouter);
    return app;
  }

  it("POST /api/gameplay records lifecycle events and GET /api/gameplay/admin summarizes the latest state", async () => {
    const token = await getSessionStore().create("hard", "Etcd Quorum Loss");
    const app = createApp();

    const started = await httpRequest(app, "POST", "/api/gameplay", {
      sessionToken: token,
      lifecycleState: "started",
      metadata: { source: "scenario" },
    });
    expect(started.status).toBe(202);

    const completed = await httpRequest(app, "POST", "/api/gameplay", {
      sessionToken: token,
      lifecycleState: "completed",
      nickname: "player1",
      commandCount: 6,
      commandsExecuted: ["oc get nodes", "oc get pods -A"],
      chatMessageCount: 8,
      durationMs: 120000,
      scoreTotal: 82,
      grade: "B",
      metadata: {
        checkedDashboard: true,
        phaseHistory: ["reading", "context", "facts", "action"],
      },
    });
    expect(completed.status).toBe(202);

    const admin = await httpRequest(app, "GET", "/api/gameplay/admin");
    expect(admin.status).toBe(200);
    expect(admin.body.summary).toMatchObject({
      totalSessions: 1,
      completedSessions: 1,
      abandonedSessions: 0,
      inProgressSessions: 0,
    });
    expect(admin.body.byDifficulty).toEqual([
      expect.objectContaining({
        difficulty: "hard",
        totalSessions: 1,
        completedSessions: 1,
      }),
    ]);
    expect(admin.body.recentSessions).toEqual([
      expect.objectContaining({
        sessionToken: token,
        lifecycleState: "completed",
        difficulty: "hard",
        scenarioTitle: "Etcd Quorum Loss",
        nickname: "player1",
        commandCount: 6,
        scoreTotal: 82,
        grade: "B",
      }),
    ]);
  });

  it("GET /api/gameplay/admin uses the latest lifecycle event per session", async () => {
    const token = await getSessionStore().create("medium", "Bad Egress");
    const app = createApp();

    await httpRequest(app, "POST", "/api/gameplay", {
      sessionToken: token,
      lifecycleState: "started",
    });
    await httpRequest(app, "POST", "/api/gameplay", {
      sessionToken: token,
      lifecycleState: "abandoned",
      commandCount: 2,
      chatMessageCount: 3,
      durationMs: 45000,
    });

    const admin = await httpRequest(app, "GET", "/api/gameplay/admin");
    expect(admin.status).toBe(200);
    expect(admin.body.summary).toMatchObject({
      totalSessions: 1,
      completedSessions: 0,
      abandonedSessions: 1,
      inProgressSessions: 0,
    });
    expect(admin.body.recentSessions).toEqual([
      expect.objectContaining({
        sessionToken: token,
        lifecycleState: "abandoned",
        difficulty: "medium",
      }),
    ]);
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
});
