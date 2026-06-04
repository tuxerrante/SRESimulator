import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { ScoringEvent } from "../../../shared/types/scoring";

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
        }
      );
      req.on("error", (e) => {
        server.close();
        reject(e);
      });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

describe("scores routes", () => {
  let tmpDir: string;
  let origDataDir: string | undefined;
  let origMockMode: string | undefined;
  let origPersistentLeaderboardEnabled: string | undefined;

  let scoresRouter: typeof import("./scores").scoresRouter;
  let getSessionStore: typeof import("../lib/storage").getSessionStore;
  let getMetricsStore: typeof import("../lib/storage").getMetricsStore;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "scores-test-"));
    origDataDir = process.env.DATA_DIR;
    origMockMode = process.env.AI_MOCK_MODE;
    origPersistentLeaderboardEnabled = process.env.PERSISTENT_LEADERBOARD_ENABLED;
    process.env.DATA_DIR = tmpDir;
    process.env.AI_MOCK_MODE = "true";
    process.env.PERSISTENT_LEADERBOARD_ENABLED = "true";

    vi.resetModules();

    const storageModule = await import("../lib/storage");
    await storageModule.initStorage();
    getSessionStore = storageModule.getSessionStore;
    getMetricsStore = storageModule.getMetricsStore;

    const scoresModule = await import("./scores");
    scoresRouter = scoresModule.scoresRouter;
  });

  afterAll(async () => {
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
    if (origPersistentLeaderboardEnabled === undefined) {
      delete process.env.PERSISTENT_LEADERBOARD_ENABLED;
    } else {
      process.env.PERSISTENT_LEADERBOARD_ENABLED = origPersistentLeaderboardEnabled;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use("/api/scores", scoresRouter);
    return app;
  }

  async function recordCompletedTelemetry(
    sessionToken: string,
    overrides?: {
      commandCount?: number;
      durationMs?: number;
      scoringEvents?: ScoringEvent[];
      difficulty?: "easy" | "medium" | "hard";
      scenarioTitle?: string;
      lifecycleState?: "started" | "completed" | "abandoned";
    },
  ): Promise<void> {
    const scoringEvents: ScoringEvent[] = overrides?.scoringEvents ?? [
      {
        type: "bonus",
        dimension: "efficiency",
        points: 20,
        reason: "Efficient path",
        timestamp: Date.now(),
      },
      {
        type: "bonus",
        dimension: "safety",
        points: 20,
        reason: "Safe execution",
        timestamp: Date.now(),
      },
      {
        type: "bonus",
        dimension: "documentation",
        points: 20,
        reason: "Good methodology",
        timestamp: Date.now(),
      },
      {
        type: "bonus",
        dimension: "accuracy",
        points: 20,
        reason: "Correct root cause",
        timestamp: Date.now(),
      },
    ];

    await getMetricsStore().recordGameplay({
      sessionToken,
      lifecycleState: overrides?.lifecycleState ?? "completed",
      difficulty: overrides?.difficulty ?? "easy",
      scenarioTitle: overrides?.scenarioTitle ?? "Test Scenario",
      commandCount: overrides?.commandCount ?? 5,
      durationMs: overrides?.durationMs ?? 120_000,
      scoringEvents,
      scoreTotal: 999,
      grade: "A+",
      completed: (overrides?.lifecycleState ?? "completed") === "completed",
    });
  }

  it("GET /api/scores returns entries array and hallOfFame", async () => {
    const app = createApp();
    const res = await httpRequest(app, "GET", "/api/scores");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(Array.isArray(res.body.hallOfFame)).toBe(true);
  });

  it("GET /api/scores rejects invalid difficulty query", async () => {
    const app = createApp();
    const res = await httpRequest(
      app,
      "GET",
      "/api/scores?difficulty=extreme"
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid difficulty");
  });

  it("POST /api/scores rejects missing session token", async () => {
    const app = createApp();
    const res = await httpRequest(app, "POST", "/api/scores", {
      nickname: "testuser",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Session token is required");
  });

  it("POST /api/scores rejects non-object request bodies", async () => {
    const app = createApp();
    const res = await httpRequest(app, "POST", "/api/scores", []);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid request body");
  });

  it("POST /api/scores rejects invalid session token", async () => {
    const app = createApp();
    const res = await httpRequest(app, "POST", "/api/scores", {
      sessionToken: "fake-token",
      nickname: "testuser",
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Invalid or already used session token");
  });

  it("POST /api/scores rejects missing nickname", async () => {
    const token = await getSessionStore().create("easy", "Test");

    const app = createApp();
    const res = await httpRequest(app, "POST", "/api/scores", {
      sessionToken: token,
      nickname: "",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Nickname is required");
  });

  it("POST /api/scores preserves token when completion telemetry is missing", async () => {
    const token = await getSessionStore().create({
      difficulty: "easy",
      scenarioTitle: "Retry Scenario",
      identityKind: "github",
      githubUserId: "retry-gh-1",
      githubLogin: "retry-gh-1",
      anonymousClaimKey: null,
      persistentScoreEligible: true,
    });

    const app = createApp();
    const invalid = await httpRequest(app, "POST", "/api/scores", {
      sessionToken: token,
      nickname: "retryuser",
    });
    expect(invalid.status).toBe(409);

    await recordCompletedTelemetry(token, {
      difficulty: "easy",
      scenarioTitle: "Retry Scenario",
    });

    const retry = await httpRequest(app, "POST", "/api/scores", {
      sessionToken: token,
      nickname: "retryuser",
    });
    expect(retry.status).toBe(201);
  });

  it("POST /api/scores accepts empty scoring events as a zero score", async () => {
    const token = await getSessionStore().create({
      difficulty: "easy",
      scenarioTitle: "No Scoring Scenario",
      identityKind: "github",
      githubUserId: "no-scoring-gh-1",
      githubLogin: "no-scoring-gh-1",
      anonymousClaimKey: null,
      persistentScoreEligible: true,
    });

    await recordCompletedTelemetry(token, {
      difficulty: "easy",
      scenarioTitle: "No Scoring Scenario",
      scoringEvents: [],
    });

    const app = createApp();
    const res = await httpRequest(app, "POST", "/api/scores", {
      sessionToken: token,
      nickname: "noscore",
    });

    expect(res.status).toBe(201);
    expect((res.body.score as Record<string, unknown>).total).toBe(0);
    expect(res.body.grade).toBe("F");
  });

  it("POST /api/scores uses completed telemetry when abandoned telemetry arrives later", async () => {
    const token = await getSessionStore().create({
      difficulty: "easy",
      scenarioTitle: "Lifecycle Ordering",
      identityKind: "github",
      githubUserId: "lifecycle-gh-1",
      githubLogin: "lifecycle-gh-1",
      anonymousClaimKey: null,
      persistentScoreEligible: true,
    });

    await recordCompletedTelemetry(token, {
      difficulty: "easy",
      scenarioTitle: "Lifecycle Ordering",
      scoringEvents: [
        { type: "bonus", dimension: "efficiency", points: 20, reason: "eff", timestamp: Date.now() },
        { type: "bonus", dimension: "safety", points: 20, reason: "safe", timestamp: Date.now() },
        { type: "bonus", dimension: "documentation", points: 20, reason: "docs", timestamp: Date.now() },
        { type: "bonus", dimension: "accuracy", points: 20, reason: "acc", timestamp: Date.now() },
      ],
    });
    await recordCompletedTelemetry(token, {
      difficulty: "easy",
      scenarioTitle: "Lifecycle Ordering",
      lifecycleState: "abandoned",
      scoringEvents: [],
    });

    const app = createApp();
    const res = await httpRequest(app, "POST", "/api/scores", {
      sessionToken: token,
      nickname: "lifecycle",
    });

    expect(res.status).toBe(201);
    expect((res.body.score as Record<string, unknown>).total).toBe(80);
    expect(res.body.grade).toBe("B");
  });

  it("POST /api/scores rejects nickname over 20 chars", async () => {
    const token = await getSessionStore().create("easy", "Test");

    const app = createApp();
    const res = await httpRequest(app, "POST", "/api/scores", {
      sessionToken: token,
      nickname: "a".repeat(21),
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("20 characters");
  });

  it("POST /api/scores rejects profane nickname", async () => {
    const token = await getSessionStore().create("easy", "Test");

    const app = createApp();
    const res = await httpRequest(app, "POST", "/api/scores", {
      sessionToken: token,
      nickname: "fuck",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("inappropriate");
  });

  it("POST /api/scores saves a valid GitHub-backed entry and returns 201", async () => {
    const token = await getSessionStore().create({
      difficulty: "easy",
      scenarioTitle: "Test Scenario",
      identityKind: "github",
      githubUserId: "12345",
      githubLogin: "octocat",
      anonymousClaimKey: null,
      persistentScoreEligible: true,
    });
    await recordCompletedTelemetry(token, {
      difficulty: "easy",
      scenarioTitle: "Test Scenario",
      commandCount: 5,
    });

    const app = createApp();
    const res = await httpRequest(app, "POST", "/api/scores", {
      sessionToken: token,
      nickname: "testuser",
      score: {
        efficiency: 25,
        safety: 25,
        documentation: 25,
        accuracy: 25,
        total: 100,
      },
      grade: "A+",
      commandCount: 0,
    });

    expect(res.status).toBe(201);
    expect(res.body.nickname).toBe("testuser");
    expect(res.body.difficulty).toBe("easy");
    expect(res.body.githubUserId).toBe("12345");
    expect((res.body.score as Record<string, unknown>).total).toBe(80);
    expect(res.body.grade).toBe("B");
    expect(res.body.commandCount).toBe(5);
  });

  it("POST /api/scores keeps anonymous scores ephemeral", async () => {
    const token = await getSessionStore().create({
      difficulty: "easy",
      scenarioTitle: "Anonymous Trial",
      identityKind: "anonymous",
      githubUserId: null,
      githubLogin: null,
      anonymousClaimKey: "claim-1",
      persistentScoreEligible: false,
    });
    await recordCompletedTelemetry(token, {
      difficulty: "easy",
      scenarioTitle: "Anonymous Trial",
      commandCount: 7,
      scoringEvents: [
        { type: "bonus", dimension: "efficiency", points: 18, reason: "eff", timestamp: Date.now() },
        { type: "bonus", dimension: "safety", points: 19, reason: "safe", timestamp: Date.now() },
        { type: "bonus", dimension: "documentation", points: 20, reason: "docs", timestamp: Date.now() },
        { type: "bonus", dimension: "accuracy", points: 21, reason: "acc", timestamp: Date.now() },
      ],
    });

    const app = createApp();
    const res = await httpRequest(app, "POST", "/api/scores", {
      sessionToken: token,
      nickname: "anonplayer",
    });

    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(false);
    expect(res.body.mode).toBe("ephemeral");

    const leaderboardRes = await httpRequest(app, "GET", "/api/scores?difficulty=easy");
    expect(leaderboardRes.status).toBe(200);
    expect(
      (leaderboardRes.body.entries as Array<Record<string, unknown>>).some(
        (entry) => entry.nickname === "anonplayer"
      )
    ).toBe(false);
  });

  it("GET /api/scores excludes automated GitHub-backed runs from the public leaderboard", async () => {
    const token = await getSessionStore().create({
      difficulty: "easy",
      scenarioTitle: "Automated Regression",
      trafficSource: "automated",
      identityKind: "github",
      githubUserId: "auto-gh-1",
      githubLogin: "auto-gh-1",
      anonymousClaimKey: null,
      persistentScoreEligible: true,
    });
    await recordCompletedTelemetry(token, {
      difficulty: "easy",
      scenarioTitle: "Automated Regression",
      commandCount: 5,
    });

    const app = createApp();
    const submit = await httpRequest(app, "POST", "/api/scores", {
      sessionToken: token,
      nickname: "autouser",
    });

    expect(submit.status).toBe(201);

    const leaderboard = await httpRequest(app, "GET", "/api/scores?difficulty=easy");
    expect(leaderboard.status).toBe(200);
    expect(
      (leaderboard.body.entries as Array<Record<string, unknown>>).some(
        (entry) => entry.nickname === "autouser",
      ),
    ).toBe(false);
  });

  it("POST /api/scores rejects telemetry/session mismatch", async () => {
    const token = await getSessionStore().create({
      difficulty: "easy",
      scenarioTitle: "Expected Scenario",
      identityKind: "github",
      githubUserId: "mismatch-gh",
      githubLogin: "mismatch-gh",
      anonymousClaimKey: null,
      persistentScoreEligible: true,
    });
    await recordCompletedTelemetry(token, {
      difficulty: "hard",
      scenarioTitle: "Wrong Scenario",
    });

    const app = createApp();
    const res = await httpRequest(app, "POST", "/api/scores", {
      sessionToken: token,
      nickname: "mismatch",
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("mismatch");
  });
});
