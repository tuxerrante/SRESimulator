import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";

async function postJson(
  app: express.Express,
  path: string,
  body: unknown,
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
        },
      );

      req.on("error", (error) => {
        server.close();
        reject(error);
      });

      req.write(payload);
      req.end();
    });
  });
}

describe("gameplay route errors", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../lib/storage");
  });

  it("returns a generic 500 error when telemetry storage fails", async () => {
    const get = vi.fn().mockResolvedValue({
      token: "session-123",
      difficulty: "easy",
      scenarioTitle: "The Sleeping Cluster",
      startTime: Date.now(),
      used: false,
    });
    const recordGameplay = vi.fn().mockRejectedValue(new Error("driver blew up"));

    vi.doMock("../lib/storage", async () => {
      const actual = await vi.importActual<typeof import("../lib/storage")>("../lib/storage");
      return {
        ...actual,
        getSessionStore: () => ({ get }),
        getMetricsStore: () => ({ recordGameplay }),
      };
    });

    const { gameplayRouter } = await import("./gameplay");
    const app = express();
    app.use(express.json());
    app.use("/api/gameplay", gameplayRouter);

    const response = await postJson(app, "/api/gameplay", {
      sessionToken: "session-123",
      lifecycleState: "completed",
    });

    expect(response.status).toBe(500);
    expect(response.body.error).toBe("Failed to record gameplay event");
    expect(JSON.stringify(response.body)).not.toContain("driver blew up");
  });
});
