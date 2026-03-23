import { describe, expect, it, beforeEach, afterEach } from "vitest";
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

describe("health routes", () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    originalEnv.AI_MOCK_MODE = process.env.AI_MOCK_MODE;
  });

  afterEach(() => {
    if (originalEnv.AI_MOCK_MODE === undefined) {
      delete process.env.AI_MOCK_MODE;
    } else {
      process.env.AI_MOCK_MODE = originalEnv.AI_MOCK_MODE;
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
});
