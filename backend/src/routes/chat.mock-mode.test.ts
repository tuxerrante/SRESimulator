import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionStore: vi.fn(),
  sessionGet: vi.fn(),
}));

vi.mock("../lib/storage", () => ({
  getSessionStore: mocks.getSessionStore,
}));

import { chatRouter } from "./chat";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/chat", chatRouter);
  return app;
}

async function postSSE(
  app: express.Express,
  path: string,
  body: unknown,
): Promise<{ status: number; rawBody: string }> {
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
              rawBody: data,
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

describe("POST /api/chat mock mode", () => {
  const originalAiMockMode = process.env.AI_MOCK_MODE;

  beforeEach(() => {
    process.env.AI_MOCK_MODE = "true";
    const sessionScenario = {
      id: "scenario_mock_easy",
      title: "Test Scenario",
      difficulty: "easy",
      description: "Mock scenario",
      incidentTicket: {
        id: "IcM-MOCK",
        severity: "Sev3",
        title: "Mock ticket",
        description: "Mock description",
        customerImpact: "Low",
        reportedTime: "2026-05-01T10:00:00.000Z",
        clusterName: "cluster-test",
        region: "eastus",
      },
      clusterContext: {
        name: "cluster-test",
        version: "4.19.0",
        region: "eastus",
        nodeCount: 3,
        status: "Healthy",
        recentEvents: [],
        alerts: [],
        upgradeHistory: [],
      },
    };
    mocks.getSessionStore.mockReturnValue({
      get: mocks.sessionGet,
    });
    mocks.sessionGet.mockResolvedValue({
      token: "session-123",
      difficulty: "easy",
      scenarioId: "scenario_mock_easy",
      scenarioTitle: "Test Scenario",
      scenarioPayload: JSON.stringify(sessionScenario),
      startTime: Date.now(),
      used: false,
      trafficSource: "player",
      identityKind: "anonymous",
      githubUserId: null,
      githubLogin: null,
      anonymousClaimKey: null,
      persistentScoreEligible: false,
    });
  });

  afterEach(() => {
    if (originalAiMockMode === undefined) {
      delete process.env.AI_MOCK_MODE;
    } else {
      process.env.AI_MOCK_MODE = originalAiMockMode;
    }
  });

  it("returns SSE stream with mock chat response", async () => {
    const app = createApp();
    const res = await postSSE(app, "/api/chat", {
      sessionToken: "session-123",
      messages: [{ role: "user", content: "hello" }],
      scenario: null,
      currentPhase: "reading",
    });

    expect(res.status).toBe(200);
    expect(res.rawBody).toContain("data: ");
    expect(res.rawBody).toContain("[DONE]");

    const lines = res.rawBody
      .split("\n")
      .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"));
    expect(lines.length).toBeGreaterThan(0);

    const parsed = JSON.parse(lines[0].slice(6));
    expect(parsed.text).toContain("Mock AI mode is enabled");
    expect(parsed.text).toContain("[PHASE:reading]");
  });

  it("reflects the current phase in the response", async () => {
    const app = createApp();
    const res = await postSSE(app, "/api/chat", {
      sessionToken: "session-123",
      messages: [{ role: "user", content: "checking context" }],
      scenario: null,
      currentPhase: "context",
    });

    expect(res.rawBody).toContain("[PHASE:context]");
  });

  it("rejects malformed scenario payloads", async () => {
    const app = createApp();
    const res = await postSSE(app, "/api/chat", {
      sessionToken: "session-123",
      messages: [{ role: "user", content: "hello" }],
      scenario: { title: "incomplete" },
      currentPhase: "reading",
    });

    expect(res.status).toBe(400);
    expect(res.rawBody).toContain("Invalid scenario payload");
  });
});
