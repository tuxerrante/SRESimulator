import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import { healthRouter } from "./health";

function createApp() {
  const app = express();
  app.use("/", healthRouter);
  return app;
}

async function httpGet(
  app: express.Express,
  path: string
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
      const req = request(
        {
          hostname: "127.0.0.1",
          port: addr.port,
          path,
          method: "GET",
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
      req.end();
    });
  });
}

const ENV_KEYS = [
  "AI_MOCK_MODE",
  "CLOUD_ML_REGION",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "READYZ_DB_CHECK_INTERVAL_MS",
] as const;

describe("health routes", () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  it("GET /healthz returns ok", async () => {
    const app = createApp();
    const res = await httpGet(app, "/healthz");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("GET /readyz returns 503 when AI is not configured", async () => {
    delete process.env.AI_MOCK_MODE;
    delete process.env.CLOUD_ML_REGION;
    delete process.env.ANTHROPIC_VERTEX_PROJECT_ID;

    const app = createApp();
    const res = await httpGet(app, "/readyz");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("not-ready");
  });

  it("GET /readyz returns ready when mock mode is on", async () => {
    process.env.AI_MOCK_MODE = "true";

    const app = createApp();

    const res = await httpGet(app, "/readyz");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
  });
  it("GET /readyz stays AI-only by default and never touches the database", async () => {
    process.env.AI_MOCK_MODE = "true";
    delete process.env.READYZ_DB_CHECK_INTERVAL_MS;

    const ping = vi.fn();
    vi.resetModules();
    vi.doMock("../lib/storage/index", () => ({ pingDatabase: ping }));
    const { healthRouter: router } = await import("./health");

    const app = express();
    app.use("/", router);
    const res = await httpGet(app, "/readyz");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready" });
    expect(ping).not.toHaveBeenCalled();
    vi.doUnmock("../lib/storage/index");
  });

  it("GET /readyz reports 503 on storage when the enabled DB check fails", async () => {
    process.env.AI_MOCK_MODE = "true";
    process.env.READYZ_DB_CHECK_INTERVAL_MS = "30000";

    vi.resetModules();
    vi.doMock("../lib/storage/index", () => ({
      pingDatabase: vi.fn().mockRejectedValue(new Error("pool is draining")),
    }));
    const { healthRouter: router } = await import("./health");

    const app = express();
    app.use("/", router);
    const res = await httpGet(app, "/readyz");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("not-ready");
    expect(res.body.component).toBe("storage");
    expect(res.body.reasons).toEqual(["pool is draining"]);
    vi.doUnmock("../lib/storage/index");
  });
});
