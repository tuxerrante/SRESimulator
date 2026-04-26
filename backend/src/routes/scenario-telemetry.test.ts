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

describe("scenario telemetry", () => {
  const originalMockMode = process.env.AI_MOCK_MODE;

  beforeEach(() => {
    process.env.AI_MOCK_MODE = "true";
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../lib/storage");

    if (originalMockMode === undefined) {
      delete process.env.AI_MOCK_MODE;
    } else {
      process.env.AI_MOCK_MODE = originalMockMode;
    }
  });

  it("records a started telemetry event when scenario creation succeeds", async () => {
    const create = vi.fn().mockResolvedValue("session-123");
    const recordGameplay = vi.fn().mockResolvedValue(undefined);

    vi.doMock("../lib/storage", async () => {
      const actual = await vi.importActual<typeof import("../lib/storage")>("../lib/storage");
      return {
        ...actual,
        getSessionStore: () => ({ create }),
        getMetricsStore: () => ({ recordGameplay }),
      };
    });

    const { scenarioRouter } = await import("./scenario");
    const app = express();
    app.use(express.json());
    app.use("/api/scenario", scenarioRouter);

    const response = await postJson(app, "/api/scenario", { difficulty: "easy" });

    expect(response.status).toBe(200);
    expect(recordGameplay).toHaveBeenCalledWith(expect.objectContaining({
      sessionToken: "session-123",
      difficulty: "easy",
      lifecycleState: "started",
      completed: false,
      metadata: { source: "scenario" },
    }));
  });

  it("still returns the scenario when started telemetry recording fails", async () => {
    const create = vi.fn().mockResolvedValue("session-123");
    const recordGameplay = vi.fn().mockRejectedValue(new Error("db unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.doMock("../lib/storage", async () => {
      const actual = await vi.importActual<typeof import("../lib/storage")>("../lib/storage");
      return {
        ...actual,
        getSessionStore: () => ({ create }),
        getMetricsStore: () => ({ recordGameplay }),
      };
    });

    const { scenarioRouter } = await import("./scenario");
    const app = express();
    app.use(express.json());
    app.use("/api/scenario", scenarioRouter);

    const response = await postJson(app, "/api/scenario", { difficulty: "medium" });

    expect(response.status).toBe(200);
    expect(response.body.sessionToken).toBe("session-123");
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("session-123");
  });
});
