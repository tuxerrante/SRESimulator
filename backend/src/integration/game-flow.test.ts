import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { Server } from "http";
import type { Express } from "express";
import type { Scenario } from "../../../shared/types/game";
import {
  getBackendUrl,
  isExternalTarget,
  startLocalServer,
} from "./helpers";

let baseUrl: string;
let localServer: Server | null = null;

async function createFullApp(): Promise<Express> {
  process.env.AI_MOCK_MODE = "true";
  const { default: express } = await import("express");
  const { default: cors } = await import("cors");
  const { chatRouter } = await import("../routes/chat");
  const { commandRouter } = await import("../routes/command");
  const { scenarioRouter } = await import("../routes/scenario");
  const { scoresRouter } = await import("../routes/scores");
  const { healthRouter } = await import("../routes/health");
  const { guideRouter } = await import("../routes/guide");

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use("/api/chat", chatRouter);
  app.use("/api/command", commandRouter);
  app.use("/api/scenario", scenarioRouter);
  app.use("/api/scores", scoresRouter);
  app.use("/api/guide", guideRouter);
  app.use("/", healthRouter);
  return app;
}

beforeAll(async () => {
  if (isExternalTarget()) {
    baseUrl = getBackendUrl();
    return;
  }
  const app = await createFullApp();
  const result = await startLocalServer(app);
  baseUrl = result.url;
  localServer = result.server;
});

afterAll(() => {
  if (localServer) {
    localServer.close();
    localServer = null;
  }
});

describe("health endpoints", () => {
  it("GET /healthz returns ok", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("GET /readyz returns ready in mock mode", async () => {
    const res = await fetch(`${baseUrl}/readyz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ready");
  });
});

describe("full game flow: scenario -> chat -> command -> scores", () => {
  let scenario: Scenario;
  let sessionToken: string;

  it("POST /api/scenario creates a scenario and session token", async () => {
    const res = await fetch(`${baseUrl}/api/scenario`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ difficulty: "easy" }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.scenario).toBeDefined();
    expect(body.sessionToken).toBeDefined();
    expect(typeof body.sessionToken).toBe("string");

    scenario = body.scenario;
    sessionToken = body.sessionToken;

    expect(scenario.id).toBeDefined();
    expect(scenario.title).toBeDefined();
    expect(scenario.difficulty).toBe("easy");
    expect(scenario.incidentTicket).toBeDefined();
    expect(scenario.clusterContext).toBeDefined();
    expect(scenario.clusterContext.alerts).toBeInstanceOf(Array);
  });

  it("POST /api/chat responds with SSE stream", async () => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "What do I see in the incident ticket?" },
        ],
        scenario,
        currentPhase: "reading",
      }),
    });
    expect(res.status).toBe(200);

    const rawBody = await res.text();
    const lines = rawBody.split("\n").filter((l) => l.startsWith("data: "));
    expect(lines.length).toBeGreaterThan(0);

    const lastDataLine = lines[lines.length - 1];
    expect(lastDataLine).toBe("data: [DONE]");

    const contentLines = lines.filter((l) => l !== "data: [DONE]");
    for (const line of contentLines) {
      const payload = JSON.parse(line.slice(6));
      expect(
        "text" in payload || "reasoning" in payload || "error" in payload,
      ).toBe(true);
    }
  });

  it("POST /api/chat with follow-up preserves conversation", async () => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "What do I see in the incident ticket?" },
          {
            role: "assistant",
            content: "The ticket shows a cluster issue. [PHASE:reading]",
          },
          {
            role: "user",
            content: "Let me check the Geneva dashboard for cluster history.",
          },
        ],
        scenario,
        currentPhase: "context",
      }),
    });
    expect(res.status).toBe(200);

    const rawBody = await res.text();
    expect(rawBody).toContain("data: [DONE]");
  });

  it("POST /api/command simulates oc command output", async () => {
    const res = await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "oc get nodes",
        type: "oc",
        scenario,
      }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.output).toBeDefined();
    expect(typeof body.output).toBe("string");
    expect(body.output.length).toBeGreaterThan(0);
    expect(body.exitCode).toBe(0);
  });

  it("POST /api/command simulates kql query output", async () => {
    const res = await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command:
          'ClusterAuditLogs | where Verb == "delete" | project TimeGenerated, User, ObjectRef',
        type: "kql",
        scenario,
      }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.output).toBeDefined();
    expect(body.exitCode).toBe(0);
  });

  it("GET /api/scores returns leaderboard", async () => {
    const res = await fetch(`${baseUrl}/api/scores`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.entries).toBeInstanceOf(Array);
    expect(body.hallOfFame).toBeInstanceOf(Array);
  });

  it("POST /api/scores submits score with valid session token", async () => {
    const res = await fetch(`${baseUrl}/api/scores`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionToken,
        nickname: "TestSRE",
        score: {
          efficiency: 20,
          safety: 22,
          documentation: 18,
          accuracy: 15,
          total: 75,
        },
        grade: "B",
        commandCount: 8,
      }),
    });
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.nickname).toBe("TestSRE");
    expect(body.difficulty).toBe("easy");
    expect(body.score.total).toBe(75);
  });

  it("POST /api/scores rejects reuse of consumed session token", async () => {
    const res = await fetch(`${baseUrl}/api/scores`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionToken,
        nickname: "CheatSRE",
        score: {
          efficiency: 25,
          safety: 25,
          documentation: 25,
          accuracy: 25,
          total: 100,
        },
        grade: "A+",
        commandCount: 1,
      }),
    });
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toContain("Invalid or already used");
  });
});

describe("scenario validation", () => {
  it("rejects invalid difficulty", async () => {
    const res = await fetch(`${baseUrl}/api/scenario`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ difficulty: "impossible" }),
    });
    expect(res.status).toBe(400);
  });

  for (const difficulty of ["easy", "medium", "hard"] as const) {
    it(`generates ${difficulty} scenario`, async () => {
      const res = await fetch(`${baseUrl}/api/scenario`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ difficulty }),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.scenario.difficulty).toBe(difficulty);
      expect(body.sessionToken).toBeDefined();
    });
  }
});

describe("command validation", () => {
  it("rejects invalid command type", async () => {
    const res = await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "something",
        type: "invalid",
        scenario: null,
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("guide endpoint", () => {
  it("GET /api/guide returns guide content", async () => {
    const res = await fetch(`${baseUrl}/api/guide`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toBeDefined();
  });
});
