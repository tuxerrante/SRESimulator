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
  extraHeaders: Record<string, string> = {},
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
      Object.assign(headers, extraHeaders);

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

describe("gameplay routes", () => {
  let tmpDir: string;
  let origDataDir: string | undefined;
  let origMockMode: string | undefined;
  let origGameplayRateLimitMax: string | undefined;
  let origGameplayAdminToken: string | undefined;

  let gameplayRouter: typeof import("./gameplay").gameplayRouter;
  let getSessionStore: typeof import("../lib/storage").getSessionStore;
  let getMetricsStore: typeof import("../lib/storage").getMetricsStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gameplay-routes-test-"));
    origDataDir = process.env.DATA_DIR;
    origMockMode = process.env.AI_MOCK_MODE;
    origGameplayRateLimitMax = process.env.GAMEPLAY_TELEMETRY_RATE_LIMIT_MAX;
    origGameplayAdminToken = process.env.GAMEPLAY_ADMIN_TOKEN;
    process.env.DATA_DIR = tmpDir;
    process.env.AI_MOCK_MODE = "true";
    delete process.env.GAMEPLAY_TELEMETRY_RATE_LIMIT_MAX;
    delete process.env.GAMEPLAY_ADMIN_TOKEN;
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

    if (origGameplayRateLimitMax === undefined) {
      delete process.env.GAMEPLAY_TELEMETRY_RATE_LIMIT_MAX;
    } else {
      process.env.GAMEPLAY_TELEMETRY_RATE_LIMIT_MAX = origGameplayRateLimitMax;
    }

    if (origGameplayAdminToken === undefined) {
      delete process.env.GAMEPLAY_ADMIN_TOKEN;
    } else {
      process.env.GAMEPLAY_ADMIN_TOKEN = origGameplayAdminToken;
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

  it("POST /api/gameplay records the session traffic source", async () => {
    const token = await getSessionStore().create({
      difficulty: "easy",
      scenarioTitle: "The Sleeping Cluster",
      trafficSource: "automated",
      identityKind: "github",
      githubUserId: "traffic-gh",
      githubLogin: "traffic-gh",
      anonymousClaimKey: null,
      persistentScoreEligible: true,
    });
    const app = createApp();

    const response = await httpRequest(app, "POST", "/api/gameplay", {
      sessionToken: token,
      lifecycleState: "completed",
      nickname: "traffic-player",
    });

    expect(response.status).toBe(202);

    const history = await getMetricsStore().getPlayerHistory("traffic-player");
    expect(history).toHaveLength(1);
    expect(history[0]?.trafficSource).toBe("automated");
  });

  it("GET /api/gameplay/admin rejects requests without the admin bearer token", async () => {
    process.env.GAMEPLAY_ADMIN_TOKEN = "gameplay-admin-secret";
    const app = createApp();

    const response = await httpRequest(app, "GET", "/api/gameplay/admin");

    expect(response.status).toBe(401);
    expect(response.body.error).toContain("Unauthorized");
  });

  it("GET /api/gameplay/admin summarizes the latest player-only session state without exposing session tokens", async () => {
    process.env.GAMEPLAY_ADMIN_TOKEN = "gameplay-admin-secret";
    const playerToken = await getSessionStore().create({
      difficulty: "hard",
      scenarioTitle: "Etcd Quorum Loss",
      trafficSource: "player",
      identityKind: "github",
      githubUserId: "analytics-player",
      githubLogin: "analytics-player",
      anonymousClaimKey: null,
      persistentScoreEligible: true,
    });
    const automatedToken = await getSessionStore().create({
      difficulty: "easy",
      scenarioTitle: "Synthetic Smoke",
      trafficSource: "automated",
      identityKind: "github",
      githubUserId: "analytics-bot",
      githubLogin: "analytics-bot",
      anonymousClaimKey: null,
      persistentScoreEligible: true,
    });
    const app = createApp();

    expect((await httpRequest(app, "POST", "/api/gameplay", {
      sessionToken: playerToken,
      lifecycleState: "started",
      metadata: { source: "scenario" },
    })).status).toBe(202);

    expect((await httpRequest(app, "POST", "/api/gameplay", {
      sessionToken: playerToken,
      lifecycleState: "completed",
      nickname: "player-admin",
      commandCount: 6,
      chatMessageCount: 8,
      durationMs: 120000,
      scoreTotal: 82,
      grade: "B",
    })).status).toBe(202);

    expect((await httpRequest(app, "POST", "/api/gameplay", {
      sessionToken: automatedToken,
      lifecycleState: "completed",
      nickname: "automation",
      commandCount: 1,
      chatMessageCount: 1,
      durationMs: 1000,
      scoreTotal: 100,
      grade: "A",
    })).status).toBe(202);

    const admin = await httpRequest(app, "GET", "/api/gameplay/admin", undefined, {
      authorization: "Bearer gameplay-admin-secret",
    });

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
        lifecycleState: "completed",
        difficulty: "hard",
        scenarioTitle: "Etcd Quorum Loss",
        nickname: "player-admin",
        commandCount: 6,
        scoreTotal: 82,
        grade: "B",
      }),
    ]);
    const recentSessions = admin.body.recentSessions;
    expect(Array.isArray(recentSessions)).toBe(true);
    if (!Array.isArray(recentSessions)) {
      throw new Error("Expected recentSessions to be an array");
    }

    const recentSession = recentSessions[0];
    expect(isRecord(recentSession)).toBe(true);
    if (!isRecord(recentSession)) {
      throw new Error("Expected the first recent session entry to be an object");
    }

    expect(Object.prototype.hasOwnProperty.call(recentSession, "sessionToken")).toBe(false);
  });

  it("GET /api/gameplay/admin is not rate limited by gameplay POST traffic", async () => {
    process.env.GAMEPLAY_ADMIN_TOKEN = "gameplay-admin-secret";
    process.env.GAMEPLAY_TELEMETRY_RATE_LIMIT_MAX = "1";
    const token = await getSessionStore().create("easy", "The Sleeping Cluster");
    const app = createApp();

    expect((await httpRequest(app, "POST", "/api/gameplay", {
      sessionToken: token,
      lifecycleState: "started",
    })).status).toBe(202);

    const admin = await httpRequest(app, "GET", "/api/gameplay/admin", undefined, {
      authorization: "Bearer gameplay-admin-secret",
    });

    expect(admin.status).toBe(200);
    expect(admin.body.summary).toMatchObject({
      totalSessions: 1,
      completedSessions: 0,
      abandonedSessions: 0,
      inProgressSessions: 1,
    });
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

  it("POST /api/gameplay only inspects the first scoring event slots", async () => {
    const token = await getSessionStore().create("medium", "Bad Egress");
    const app = createApp();

    const response = await httpRequest(app, "POST", "/api/gameplay", {
      sessionToken: token,
      lifecycleState: "abandoned",
      nickname: "slot-cap",
      scoringEvents: [
        ...Array.from({ length: 49 }, (_, index) => ({ type: "bonus", points: index })),
        "skip-me",
        { type: "bonus", points: 999 },
      ],
    });

    expect(response.status).toBe(202);

    const history = await getMetricsStore().getPlayerHistory("slot-cap");
    expect(history).toHaveLength(1);
    expect(history[0].scoringEvents).toHaveLength(49);
    expect(history[0].scoringEvents).not.toContainEqual({ type: "bonus", points: 999 });
  });

  it("POST /api/gameplay ignores dangerous metadata prototype keys", async () => {
    const token = await getSessionStore().create("easy", "The Sleeping Cluster");
    const app = createApp();

    const response = await httpRequest(app, "POST", "/api/gameplay", {
      sessionToken: token,
      lifecycleState: "started",
      nickname: "proto-safe",
      metadata: {
        safeKey: "kept",
        __proto__: { polluted: true },
        constructor: "drop-me",
        prototype: "drop-me-too",
      },
    });

    expect(response.status).toBe(202);

    const history = await getMetricsStore().getPlayerHistory("proto-safe");
    expect(history).toHaveLength(1);
    expect(history[0].metadata).toEqual({ safeKey: "kept" });
    expect(Object.prototype.hasOwnProperty.call(history[0].metadata ?? {}, "constructor")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(history[0].metadata ?? {}, "prototype")).toBe(false);
  });

  it("POST /api/gameplay ignores duplicate lifecycle submissions for the same session", async () => {
    const token = await getSessionStore().create("easy", "The Sleeping Cluster");
    const app = createApp();

    const first = await httpRequest(app, "POST", "/api/gameplay", {
      sessionToken: token,
      lifecycleState: "completed",
      nickname: "dedupe-player",
    });
    const duplicate = await httpRequest(app, "POST", "/api/gameplay", {
      sessionToken: token,
      lifecycleState: "completed",
      nickname: "dedupe-player",
    });

    expect(first.status).toBe(202);
    expect(duplicate.status).toBe(202);
    expect(duplicate.body.deduped).toBe(true);

    const history = await getMetricsStore().getPlayerHistory("dedupe-player");
    expect(history).toHaveLength(1);
    expect(history[0].lifecycleState).toBe("completed");
  });

  it("POST /api/gameplay applies the gameplay telemetry rate limit", async () => {
    process.env.GAMEPLAY_TELEMETRY_RATE_LIMIT_MAX = "2";
    const token = await getSessionStore().create("easy", "The Sleeping Cluster");
    const app = createApp();

    expect((await httpRequest(app, "POST", "/api/gameplay", {
      sessionToken: token,
      lifecycleState: "started",
    })).status).toBe(202);

    expect((await httpRequest(app, "POST", "/api/gameplay", {
      sessionToken: token,
      lifecycleState: "abandoned",
    })).status).toBe(202);

    const limited = await httpRequest(app, "POST", "/api/gameplay", {
      sessionToken: token,
      lifecycleState: "completed",
    });

    expect(limited.status).toBe(429);
    expect(limited.body.error).toContain("Too many gameplay telemetry events");
  });

  it("POST /api/gameplay rate limit ignores spoofed x-forwarded-for headers", async () => {
    process.env.GAMEPLAY_TELEMETRY_RATE_LIMIT_MAX = "1";
    const token = await getSessionStore().create("easy", "The Sleeping Cluster");
    const app = createApp();

    expect((await httpRequest(app, "POST", "/api/gameplay", {
      sessionToken: token,
      lifecycleState: "started",
    }, {
      "x-forwarded-for": "1.1.1.1",
    })).status).toBe(202);

    const limited = await httpRequest(app, "POST", "/api/gameplay", {
      sessionToken: token,
      lifecycleState: "abandoned",
    }, {
      "x-forwarded-for": "203.0.113.25",
    });

    expect(limited.status).toBe(429);
    expect(limited.body.error).toContain("Too many gameplay telemetry events");
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
