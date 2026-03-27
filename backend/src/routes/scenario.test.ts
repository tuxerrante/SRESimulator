import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from "vitest";
import express from "express";

function createApp(scenarioRouter: import("express").Router) {
  const app = express();
  app.use(express.json());
  app.use("/api/scenario", scenarioRouter);
  return app;
}

async function postJson(
  app: express.Express,
  path: string,
  body: unknown
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
      const payload = JSON.stringify(body);
      const req = request(
        {
          hostname: "127.0.0.1",
          port: addr.port,
          path,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
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
      req.write(payload);
      req.end();
    });
  });
}

describe("POST /api/scenario", () => {
  const originalEnv: Record<string, string | undefined> = {};
  let scenarioRouter: typeof import("./scenario").scenarioRouter;

  beforeAll(async () => {
    originalEnv.AI_MOCK_MODE = process.env.AI_MOCK_MODE;
    process.env.AI_MOCK_MODE = "true";

    vi.resetModules();

    const storageModule = await import("../lib/storage");
    await storageModule.initStorage();

    const scenarioModule = await import("./scenario");
    scenarioRouter = scenarioModule.scenarioRouter;
  });

  beforeEach(() => {
    process.env.AI_MOCK_MODE = "true";
  });

  afterEach(() => {
    if (originalEnv.AI_MOCK_MODE === undefined) {
      delete process.env.AI_MOCK_MODE;
    } else {
      process.env.AI_MOCK_MODE = originalEnv.AI_MOCK_MODE;
    }
  });

  it("returns a mock scenario and session token in mock mode", async () => {
    const app = createApp(scenarioRouter);
    const res = await postJson(app, "/api/scenario", {
      difficulty: "easy",
    });

    expect(res.status).toBe(200);
    expect(res.body.scenario).toBeDefined();
    expect(res.body.sessionToken).toBeDefined();
    const scenario = res.body.scenario as Record<string, unknown>;
    expect(scenario.difficulty).toBe("easy");
    expect(scenario.id).toBe("scenario_mock_easy");
  });

  it("rejects invalid difficulty", async () => {
    const app = createApp(scenarioRouter);
    const res = await postJson(app, "/api/scenario", {
      difficulty: "extreme",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid difficulty");
  });
});
