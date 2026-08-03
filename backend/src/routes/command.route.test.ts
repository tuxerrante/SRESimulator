import express from "express";
import type { Scenario } from "../../../shared/types/game";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { generateAiTextMock } = vi.hoisted(() => ({
  generateAiTextMock: vi.fn(),
}));
const storageMocks = vi.hoisted(() => ({
  getSessionStore: vi.fn(),
  sessionGet: vi.fn(),
}));

vi.mock("../lib/ai-runtime", async () => {
  const actual = await vi.importActual<typeof import("../lib/ai-runtime")>("../lib/ai-runtime");
  return {
    ...actual,
    generateAiText: generateAiTextMock,
  };
});

vi.mock("../lib/storage", () => ({
  getSessionStore: storageMocks.getSessionStore,
}));

import { commandRouter, resolveCommandHistoryPlaceholders } from "./command";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/command", commandRouter);
  return app;
}

function makeScenario(): Scenario {
  return {
    id: "scenario_test",
    platform: "aro-classic",
    title: "Worker Node NotReady",
    difficulty: "easy",
    description: "A worker node has gone NotReady due to DiskPressure",
    incidentTicket: {
      id: "IcM-900327",
      severity: "Sev3",
      title: "Pods stuck Pending after node went NotReady",
      description: "Customer reports pods stuck Pending",
      customerImpact: "Reduced capacity",
      reportedTime: "2026-03-23T10:52:18Z",
      clusterName: "aro-prod-payments-eus2-01",
      region: "eastus2",
    },
    clusterContext: {
      name: "aro-prod-payments-eus2-01",
      version: "4.18.6",
      region: "eastus2",
      nodeCount: 6,
      status: "Degraded",
      recentEvents: [
        "2026-03-27T12:41:03Z Warning NodeHasDiskPressure node/worker-eastus2-2 has disk pressure",
      ],
      alerts: [],
      upgradeHistory: [],
    },
  };
}

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

describe("resolveCommandHistoryPlaceholders", () => {
  it("resolves placeholders inside command history entries", () => {
    const resolved = resolveCommandHistoryPlaceholders(
      [{ command: "oc debug node/<worker>", output: "ok", type: "oc" }],
      makeScenario(),
    );
    expect(resolved?.[0]?.command).toBe("oc debug node/worker-eastus2-2");
  });
});

describe("POST /api/command", () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    originalEnv.AI_MOCK_MODE = process.env.AI_MOCK_MODE;
    originalEnv.AI_PROVIDER = process.env.AI_PROVIDER;
    originalEnv.AI_MODEL = process.env.AI_MODEL;
    originalEnv.AI_AZURE_OPENAI_ENDPOINT = process.env.AI_AZURE_OPENAI_ENDPOINT;
    originalEnv.AI_AZURE_OPENAI_API_KEY = process.env.AI_AZURE_OPENAI_API_KEY;
    originalEnv.AI_AZURE_OPENAI_DEPLOYMENT = process.env.AI_AZURE_OPENAI_DEPLOYMENT;
    originalEnv.AI_MAX_COMMAND_TOKENS = process.env.AI_MAX_COMMAND_TOKENS;
    originalEnv.AI_COMMAND_TIMEOUT_MS = process.env.AI_COMMAND_TIMEOUT_MS;
    process.env.AI_MOCK_MODE = "true";
    generateAiTextMock.mockReset();
    storageMocks.getSessionStore.mockReturnValue({
      get: storageMocks.sessionGet,
    });
    const storedScenario = makeScenario();
    storageMocks.sessionGet.mockResolvedValue({
      token: "session-123",
      platform: "aro-classic",
      difficulty: "easy",
      scenarioId: storedScenario.id,
      scenarioTitle: "Worker Node NotReady",
      scenarioPayload: JSON.stringify(storedScenario),
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
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  function enableLiveAiRuntime(): void {
    process.env.AI_MOCK_MODE = "false";
    process.env.AI_PROVIDER = "azure-openai";
    process.env.AI_MODEL = "gpt-5.2";
    process.env.AI_AZURE_OPENAI_ENDPOINT = "https://example.openai.azure.com";
    process.env.AI_AZURE_OPENAI_API_KEY = "test-key";
    process.env.AI_AZURE_OPENAI_DEPLOYMENT = "gpt-5.2";
  }

  it("returns mock oc output in mock mode", async () => {
    const app = createApp();
    const res = await postJson(app, "/api/command", {
      sessionToken: "session-123",
      command: "oc get nodes",
      type: "oc",
      scenario: null,
    });

    expect(res.status).toBe(200);
    expect(res.body.exitCode).toBe(0);
    expect(res.body.output).toContain("master-0");
    expect(res.body.output).toContain("mock command received: oc get nodes");
  });

  it("returns mock kql output in mock mode", async () => {
    const app = createApp();
    const res = await postJson(app, "/api/command", {
      sessionToken: "session-123",
      command: "ClusterLogs | take 10",
      type: "kql",
      scenario: null,
    });

    expect(res.status).toBe(200);
    expect(res.body.output).toContain("TimeGenerated");
  });

  it("returns mock geneva output in mock mode", async () => {
    const app = createApp();
    const res = await postJson(app, "/api/command", {
      sessionToken: "session-123",
      command: "show dashboard",
      type: "geneva",
      scenario: null,
    });

    expect(res.status).toBe(200);
    expect(res.body.output).toContain("Dashboard: Mock Geneva View");
  });

  it("rejects invalid command type", async () => {
    const app = createApp();
    const res = await postJson(app, "/api/command", {
      sessionToken: "session-123",
      command: "test",
      type: "invalid",
      scenario: null,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid command type");
    expect(res.body.error).toContain("kubectl");
  });

  it("rejects requests missing session tokens", async () => {
    const app = createApp();
    const res = await postJson(app, "/api/command", {
      command: "oc get nodes",
      type: "oc",
      scenario: null,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Session token is required");
  });

  it("rejects malformed scenario payloads", async () => {
    const app = createApp();
    const res = await postJson(app, "/api/command", {
      sessionToken: "session-123",
      command: "oc get nodes",
      type: "oc",
      scenario: { title: "incomplete" },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid scenario payload");
  });

  it("accepts commandHistory field without error", async () => {
    const app = createApp();
    const res = await postJson(app, "/api/command", {
      sessionToken: "session-123",
      command: "oc get nodes",
      type: "oc",
      scenario: null,
      commandHistory: [
        { command: "oc get pods", output: "NAME  READY  STATUS\npod-1  1/1  Running", type: "oc" },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.exitCode).toBe(0);
  });

  it("returns describe output for oc describe node in mock mode", async () => {
    const app = createApp();
    const res = await postJson(app, "/api/command", {
      sessionToken: "session-123",
      command: "oc describe node master-0",
      type: "oc",
      scenario: null,
    });

    expect(res.status).toBe(200);
    expect(res.body.output).toContain("Name:");
    expect(res.body.output).toContain("Conditions:");
    expect(res.body.output).toContain("master-0");
  });

  it("returns delete confirmation for oc delete in mock mode", async () => {
    const app = createApp();
    const res = await postJson(app, "/api/command", {
      sessionToken: "session-123",
      command: "oc delete machine aro-worker-0",
      type: "oc",
      scenario: null,
    });

    expect(res.status).toBe(200);
    expect(res.body.output).toBe('machine "aro-worker-0" deleted');
  });

  it("handles commandHistory with null/malformed entries without crashing", async () => {
    const app = createApp();
    const res = await postJson(app, "/api/command", {
      sessionToken: "session-123",
      command: "oc get nodes",
      type: "oc",
      scenario: null,
      commandHistory: [
        null,
        { command: 123, output: null, type: "oc" },
        { command: "oc get pods", output: "Running", type: "oc" },
        "not-an-object",
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.exitCode).toBe(0);
  });

  it("handles commandHistory that is not an array", async () => {
    const app = createApp();
    const res = await postJson(app, "/api/command", {
      sessionToken: "session-123",
      command: "oc get nodes",
      type: "oc",
      scenario: null,
      commandHistory: "invalid",
    });

    expect(res.status).toBe(200);
    expect(res.body.exitCode).toBe(0);
  });

  it("uses the configured max command token budget for live command simulation", async () => {
    enableLiveAiRuntime();
    process.env.AI_MAX_COMMAND_TOKENS = "8192";
    generateAiTextMock.mockResolvedValue("NAME   STATUS\nworker-0 Ready");

    const app = createApp();
    const res = await postJson(app, "/api/command", {
      sessionToken: "session-123",
      command: "oc get nodes",
      type: "oc",
      scenario: makeScenario(),
    });

    expect(res.status).toBe(200);
    expect(res.body.exitCode).toBe(0);
    expect(generateAiTextMock).toHaveBeenCalledTimes(1);
    expect(generateAiTextMock.mock.calls[0]?.[0]?.maxTokens).toBe(8192);
  });

  it("preserves recent command mutations in late-game history overflow", async () => {
    enableLiveAiRuntime();
    const longOutput = "x".repeat(780);
    const commandHistory = Array.from({ length: 24 }, (_, index) => ({
      command: `oc get machines -n openshift-machine-api batch-${index}`,
      output: `machine-${index} ${longOutput}`,
      type: "oc" as const,
    }));
    commandHistory[23] = {
      command: "oc delete machine worker-eastus2-2",
      output: 'machine.machine.openshift.io "worker-eastus2-2" deleted',
      type: "oc",
    };

    generateAiTextMock.mockImplementation(async (request) => {
      const prompt = String(request.system ?? "");
      return prompt.includes("$ oc delete machine worker-eastus2-2")
        ? "NAME                   STATUS\nworker-eastus2-1        Running"
        : "NAME                   STATUS\nworker-eastus2-1        Running\nworker-eastus2-2        Running";
    });

    const app = createApp();
    const res = await postJson(app, "/api/command", {
      sessionToken: "session-123",
      command: "oc get machines -n openshift-machine-api",
      type: "oc",
      scenario: makeScenario(),
      commandHistory,
    });

    expect(res.status).toBe(200);
    expect(res.body.exitCode).toBe(0);
    expect(String(res.body.output)).toContain("worker-eastus2-1");
    expect(String(res.body.output)).not.toContain("worker-eastus2-2");
  });

  it("falls back to mock output when live command generation exceeds the timeout budget", async () => {
    enableLiveAiRuntime();
    process.env.AI_COMMAND_TIMEOUT_MS = "50";
    let aborted = false;
    generateAiTextMock.mockImplementation(
      (request: { signal?: AbortSignal }) =>
        new Promise(() => {
          request?.signal?.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    );

    const app = createApp();
    const res = await postJson(app, "/api/command", {
      sessionToken: "session-123",
      command: "oc describe node master-0",
      type: "oc",
      scenario: null,
    });

    expect(res.status).toBe(200);
    expect(res.body.exitCode).toBe(1);
    expect(res.body.mode).toBe("degraded");
    expect(res.body.degradedReason).toBe("timeout");
    expect(res.body.output).toContain("Name:");
    expect(res.body.output).not.toContain("delayed synthetic response");
    expect(aborted).toBe(true);
  });

  it("returns a client-safe generic message when live command generation fails", async () => {
    enableLiveAiRuntime();
    generateAiTextMock.mockRejectedValue(
      new Error("Azure OpenAI request failed (429): leaked upstream diagnostics")
    );

    const app = createApp();
    const res = await postJson(app, "/api/command", {
      sessionToken: "session-123",
      command: "oc get nodes",
      type: "oc",
      scenario: makeScenario(),
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Command simulation failed");
  });
});
