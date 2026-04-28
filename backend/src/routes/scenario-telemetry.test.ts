import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { VIEWER_SESSION_COOKIE } from "../../../shared/auth/constants";
import { createViewerSessionToken } from "../../../shared/auth/session";

async function postJson(
  app: express.Express,
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
  timeoutMs?: number,
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
            ...extraHeaders,
          },
        },
        (res) => {
          if (timeout) {
            clearTimeout(timeout);
          }
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

      const timeout = timeoutMs
        ? setTimeout(() => {
            req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : undefined;

      req.on("error", (error) => {
        if (timeout) {
          clearTimeout(timeout);
        }
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
  const originalAuthSessionSecret = process.env.AUTH_SESSION_SECRET;
  const githubAuthCookie = `${VIEWER_SESSION_COOKIE}=${createViewerSessionToken(
    {
      kind: "github",
      githubUserId: "12345",
      githubLogin: "octocat",
      displayName: "The Octocat",
      avatarUrl: null,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    },
    "test-secret"
  )}`;

  beforeEach(() => {
    process.env.AI_MOCK_MODE = "true";
    process.env.AUTH_SESSION_SECRET = "test-secret";
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

    if (originalAuthSessionSecret === undefined) {
      delete process.env.AUTH_SESSION_SECRET;
    } else {
      process.env.AUTH_SESSION_SECRET = originalAuthSessionSecret;
    }
  });

  it("records a started telemetry event when scenario creation succeeds", async () => {
    const create = vi.fn().mockResolvedValue("session-123");
    const upsertGithubViewer = vi.fn().mockResolvedValue(undefined);
    const recordGameplay = vi.fn().mockResolvedValue(undefined);

    vi.doMock("../lib/storage", async () => {
      const actual = await vi.importActual<typeof import("../lib/storage")>("../lib/storage");
      return {
        ...actual,
        getSessionStore: () => ({ create }),
        getPlayerStore: () => ({ upsertGithubViewer }),
        getMetricsStore: () => ({ recordGameplay }),
      };
    });

    const { scenarioRouter } = await import("./scenario");
    const app = express();
    app.use(express.json());
    app.use("/api/scenario", scenarioRouter);

    const response = await postJson(
      app,
      "/api/scenario",
      { difficulty: "easy" },
      { cookie: githubAuthCookie }
    );

    expect(response.status).toBe(200);
    expect(upsertGithubViewer).toHaveBeenCalled();
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
    const upsertGithubViewer = vi.fn().mockResolvedValue(undefined);
    const recordGameplay = vi.fn().mockRejectedValue(new Error("db unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.doMock("../lib/storage", async () => {
      const actual = await vi.importActual<typeof import("../lib/storage")>("../lib/storage");
      return {
        ...actual,
        getSessionStore: () => ({ create }),
        getPlayerStore: () => ({ upsertGithubViewer }),
        getMetricsStore: () => ({ recordGameplay }),
      };
    });

    const { scenarioRouter } = await import("./scenario");
    const app = express();
    app.use(express.json());
    app.use("/api/scenario", scenarioRouter);

    const response = await postJson(
      app,
      "/api/scenario",
      { difficulty: "medium" },
      { cookie: githubAuthCookie }
    );

    expect(response.status).toBe(200);
    expect(response.body.sessionToken).toBe("session-123");
    expect(upsertGithubViewer).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("session-123");
  });

  it("returns the scenario without waiting for started telemetry to finish", async () => {
    const create = vi.fn().mockResolvedValue("session-123");
    const upsertGithubViewer = vi.fn().mockResolvedValue(undefined);
    const recordGameplay = vi.fn().mockImplementation(() => new Promise<void>(() => {}));

    vi.doMock("../lib/storage", async () => {
      const actual = await vi.importActual<typeof import("../lib/storage")>("../lib/storage");
      return {
        ...actual,
        getSessionStore: () => ({ create }),
        getPlayerStore: () => ({ upsertGithubViewer }),
        getMetricsStore: () => ({ recordGameplay }),
      };
    });

    const { scenarioRouter } = await import("./scenario");
    const app = express();
    app.use(express.json());
    app.use("/api/scenario", scenarioRouter);

    const response = await postJson(
      app,
      "/api/scenario",
      { difficulty: "easy" },
      { cookie: githubAuthCookie },
      200,
    );

    expect(response.status).toBe(200);
    expect(response.body.sessionToken).toBe("session-123");
    expect(recordGameplay).toHaveBeenCalled();
  });
});
