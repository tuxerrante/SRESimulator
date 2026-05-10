import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getGameplayAnalytics: vi.fn(),
}));

vi.mock("../lib/storage", () => ({
  getMetricsStore: () => ({
    getGameplayAnalytics: mocks.getGameplayAnalytics,
    hasLifecycleEvent: vi.fn(),
    recordGameplay: vi.fn(),
  }),
  getSessionStore: () => ({
    get: vi.fn(),
  }),
}));

vi.mock("../lib/telemetry/capture", () => ({
  captureBackendRouteError: vi.fn(),
}));

import { gameplayRouter } from "./gameplay";

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe("gameplay admin authorization", () => {
  const originalToken = process.env.GAMEPLAY_ADMIN_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GAMEPLAY_ADMIN_TOKEN = "super-secret-token";
    mocks.getGameplayAnalytics.mockResolvedValue({
      summary: {
        totalSessions: 0,
        completedSessions: 0,
        abandonedSessions: 0,
        inProgressSessions: 0,
        completionRate: 0,
        abandonmentRate: 0,
      },
      byDifficulty: [],
      byScenario: [],
      recentSessions: [],
    });
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.GAMEPLAY_ADMIN_TOKEN;
    } else {
      process.env.GAMEPLAY_ADMIN_TOKEN = originalToken;
    }
  });

  it("accepts case-insensitive bearer auth scheme", async () => {
    const app = express();
    app.use("/api/gameplay", gameplayRouter);
    const server = await new Promise<Server>((resolve) => {
      const listeningServer = app.listen(0, "127.0.0.1", () => resolve(listeningServer));
    });

    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/api/gameplay/admin`, {
        headers: {
          authorization: "bearer super-secret-token",
        },
      });

      expect(response.status).toBe(200);
      expect(mocks.getGameplayAnalytics).toHaveBeenCalledTimes(1);
    } finally {
      await close(server);
    }
  });
});
