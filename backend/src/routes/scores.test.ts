import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

async function httpRequest(
  app: express.Express,
  method: "GET" | "POST",
  path: string,
  body?: unknown
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

  let scoresRouter: typeof import("./scores").scoresRouter;
  let getSessionStore: typeof import("../lib/storage").getSessionStore;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "scores-test-"));
    origDataDir = process.env.DATA_DIR;
    origMockMode = process.env.AI_MOCK_MODE;
    process.env.DATA_DIR = tmpDir;
    process.env.AI_MOCK_MODE = "true";

    vi.resetModules();

    const storageModule = await import("../lib/storage");
    await storageModule.initStorage();
    getSessionStore = storageModule.getSessionStore;

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
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use("/api/scores", scoresRouter);
    return app;
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
      score: { total: 80 },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Session token is required");
  });

  it("POST /api/scores rejects invalid session token", async () => {
    const app = createApp();
    const res = await httpRequest(app, "POST", "/api/scores", {
      sessionToken: "fake-token",
      nickname: "testuser",
      score: { total: 80 },
      grade: "A",
      commandCount: 5,
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
      score: { total: 80 },
      grade: "A",
      commandCount: 5,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Nickname is required");
  });

  it("POST /api/scores rejects nickname over 20 chars", async () => {
    const token = await getSessionStore().create("easy", "Test");

    const app = createApp();
    const res = await httpRequest(app, "POST", "/api/scores", {
      sessionToken: token,
      nickname: "a".repeat(21),
      score: { total: 80 },
      grade: "A",
      commandCount: 5,
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
      score: { total: 80 },
      grade: "A",
      commandCount: 5,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("inappropriate");
  });

  it("POST /api/scores saves a valid entry and returns 201", async () => {
    const token = await getSessionStore().create("easy", "Test Scenario");

    const app = createApp();
    const res = await httpRequest(app, "POST", "/api/scores", {
      sessionToken: token,
      nickname: "testuser",
      score: {
        efficiency: 20,
        safety: 20,
        documentation: 20,
        accuracy: 20,
        total: 80,
      },
      grade: "A",
      commandCount: 5,
    });

    expect(res.status).toBe(201);
    expect(res.body.nickname).toBe("testuser");
    expect(res.body.difficulty).toBe("easy");
  });
});
