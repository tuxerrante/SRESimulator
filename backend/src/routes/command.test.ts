import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureBackendRouteError: vi.fn(),
  getAiReadiness: vi.fn(),
  shouldDegradeOnQuotaExhausted: vi.fn(),
  generateMockCommandOutput: vi.fn(),
  generateAiText: vi.fn(),
  buildScenarioContext: vi.fn(),
  buildSimNow: vi.fn(),
  buildCommandSystemPrompt: vi.fn(),
  resolveAngleBracketPlaceholders: vi.fn(),
  getSessionStore: vi.fn(),
  sessionGet: vi.fn(),
  chargeAiBudget: vi.fn(),
}));

vi.mock("../lib/ai-budget", () => ({
  chargeAiBudget: mocks.chargeAiBudget,
}));

vi.mock("../lib/ai-config", () => ({
  getAiReadiness: mocks.getAiReadiness,
  shouldDegradeOnQuotaExhausted: mocks.shouldDegradeOnQuotaExhausted,
}));

vi.mock("../lib/mock-ai", () => ({
  generateMockCommandOutput: mocks.generateMockCommandOutput,
}));

vi.mock("../lib/ai-runtime", async () => {
  const actual = await vi.importActual<typeof import("../lib/ai-runtime")>("../lib/ai-runtime");
  return {
    ...actual,
    generateAiText: mocks.generateAiText,
  };
});

vi.mock("../lib/prompts/command", () => ({
  buildScenarioContext: mocks.buildScenarioContext,
  buildSimNow: mocks.buildSimNow,
  buildCommandSystemPrompt: mocks.buildCommandSystemPrompt,
}));

vi.mock("../lib/prompts/scenario-resources", () => ({
  resolveAngleBracketPlaceholders: mocks.resolveAngleBracketPlaceholders,
}));

vi.mock("../lib/telemetry/capture", () => ({
  captureBackendRouteError: mocks.captureBackendRouteError,
}));

vi.mock("../lib/storage", () => ({
  getSessionStore: mocks.getSessionStore,
}));

import { aiRateLimit } from "../lib/rate-limit";
import { AiQuotaExhaustedError, AiThrottledError } from "../lib/ai-runtime";
import { commandRouter } from "./command";

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

describe("commandRouter", () => {
  beforeEach(() => {
    const sessionScenario = {
      id: "scenario_test_easy",
      platform: "aro-classic",
      title: "Test Scenario",
      difficulty: "easy",
      description: "Test scenario description",
      incidentTicket: {
        id: "IcM-TEST",
        severity: "Sev3",
        title: "Ticket title",
        description: "Ticket description",
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
        status: "Degraded",
        recentEvents: [],
        alerts: [],
        upgradeHistory: [],
      },
    };
    vi.clearAllMocks();
    mocks.getAiReadiness.mockReturnValue({ ready: true, mockMode: false });
    mocks.shouldDegradeOnQuotaExhausted.mockReturnValue(true);
    mocks.chargeAiBudget.mockResolvedValue("ok");
    mocks.buildScenarioContext.mockReturnValue("scenario context");
    mocks.buildSimNow.mockReturnValue("sim now");
    mocks.buildCommandSystemPrompt.mockReturnValue("system prompt");
    mocks.resolveAngleBracketPlaceholders.mockImplementation((value: unknown) => value);
    mocks.generateMockCommandOutput.mockReturnValue("fallback output");
    mocks.getSessionStore.mockReturnValue({
      get: mocks.sessionGet,
    });
    mocks.sessionGet.mockResolvedValue({
      token: "session-123",
      platform: "aro-classic",
      difficulty: "easy",
      scenarioId: "scenario_test_easy",
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
    vi.restoreAllMocks();
  });

  it("captures degraded fallback errors before returning mock command output", async () => {
    const degradedError = new Error("model did not include text content");
    mocks.generateAiText.mockRejectedValue(degradedError);

    const app = express();
    app.use(express.json());
    app.use("/api/command", commandRouter);
    const server = await new Promise<Server>((resolve) => {
      const listeningServer = app.listen(0, "127.0.0.1", () => resolve(listeningServer));
    });

    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/api/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionToken: "session-123",
          command: "oc get pods",
          type: "oc",
          scenario: null,
          commandHistory: [],
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        output: "fallback output\nError: missing_output",
        exitCode: 1,
        mode: "degraded",
        degradedReason: "missing_output",
      });
      expect(mocks.captureBackendRouteError).toHaveBeenCalledTimes(1);
      expect(mocks.captureBackendRouteError.mock.calls[0]?.[1]).toBe(degradedError);
    } finally {
      await close(server);
    }
  });

  it("reuses the rate-limit session lookup on hot command requests", async () => {
    const sessionToken = "11111111-1111-4111-8111-111111111111";
    mocks.getAiReadiness.mockReturnValue({ ready: true, mockMode: true });
    mocks.generateMockCommandOutput.mockReturnValue("mock output");

    const app = express();
    app.use(express.json());
    app.use("/api/command", aiRateLimit, commandRouter);
    const server = await new Promise<Server>((resolve) => {
      const listeningServer = app.listen(0, "127.0.0.1", () => resolve(listeningServer));
    });

    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/api/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionToken,
          command: "oc get pods",
          type: "oc",
          scenario: null,
          commandHistory: [],
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        output: "mock output",
        exitCode: 0,
        mode: "mock",
      });
      expect(mocks.sessionGet).toHaveBeenCalledTimes(1);
      expect(mocks.sessionGet).toHaveBeenCalledWith(sessionToken);
    } finally {
      await close(server);
    }
  });

  it("rejects invalid stored session scenario payloads", async () => {
    mocks.sessionGet.mockResolvedValueOnce({
      token: "session-123",
      platform: "aro-classic",
      difficulty: "easy",
      scenarioId: "scenario_test_easy",
      scenarioTitle: "Test Scenario",
      scenarioPayload: "{",
      startTime: Date.now(),
      used: false,
      trafficSource: "player",
      identityKind: "anonymous",
      githubUserId: null,
      githubLogin: null,
      anonymousClaimKey: null,
      persistentScoreEligible: false,
    });

    const app = express();
    app.use(express.json());
    app.use("/api/command", commandRouter);
    const server = await new Promise<Server>((resolve) => {
      const listeningServer = app.listen(0, "127.0.0.1", () => resolve(listeningServer));
    });

    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/api/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionToken: "session-123",
          command: "oc get pods",
          type: "oc",
          scenario: null,
          commandHistory: [],
        }),
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "Session scenario context is unavailable",
      });
    } finally {
      await close(server);
    }
  });

  async function postCommand(
    options: { budgetExhausted?: boolean } = {},
  ): Promise<Response> {
    const app = express();
    app.use(express.json());
    if (options.budgetExhausted) {
      // What chargeAiBudget answers the route when the shared daily budget is
      // spent and the mode is degrade: nothing written, decision handed back.
      mocks.chargeAiBudget.mockResolvedValue("exhausted");
    }
    app.use("/api/command", commandRouter);
    const server = await new Promise<Server>((resolve) => {
      const listeningServer = app.listen(0, "127.0.0.1", () => resolve(listeningServer));
    });

    try {
      const { port } = server.address() as AddressInfo;
      return await fetch(`http://127.0.0.1:${port}/api/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionToken: "session-123",
          command: "oc get pods",
          type: "oc",
          scenario: null,
          commandHistory: [],
        }),
      });
    } finally {
      await close(server);
    }
  }

  it("returns simulated output instead of 429 when the AI budget is exhausted", async () => {
    mocks.generateAiText.mockRejectedValue(
      new AiQuotaExhaustedError("daily", "The shared budget is spent."),
    );

    const response = await postCommand();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      output: "fallback output\nError: quota_exhausted",
      exitCode: 1,
      mode: "degraded",
      degradedReason: "quota_exhausted",
    });
  });

  it("keeps the 429 for an ordinary throttle, which retrying can clear", async () => {
    mocks.generateAiText.mockRejectedValue(
      new AiThrottledError("Rate-limited. Please wait a moment and try again."),
    );

    const response = await postCommand();

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: "Rate-limited. Please wait a moment and try again.",
    });
  });

  it("restores the 429 for an exhausted budget when degradation is switched off", async () => {
    mocks.shouldDegradeOnQuotaExhausted.mockReturnValue(false);
    mocks.generateAiText.mockRejectedValue(
      new AiQuotaExhaustedError("credits", "The shared account is out of credit."),
    );

    const response = await postCommand();

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: "The shared account is out of credit.",
    });
  });

  it("answers a spent shared budget without asking the provider first", async () => {
    const response = await postCommand({ budgetExhausted: true });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      output: "fallback output\nError: quota_exhausted",
      exitCode: 1,
      mode: "degraded",
      degradedReason: "quota_exhausted",
    });
    // The point of checking the budget in the route: the request that the
    // shared account cannot afford never leaves the process.
    expect(mocks.generateAiText).not.toHaveBeenCalled();
  });

  it("keeps the 429 for a spent shared budget when degradation is switched off", async () => {
    mocks.shouldDegradeOnQuotaExhausted.mockReturnValue(false);

    const response = await postCommand({ budgetExhausted: true });

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: "The shared AI request budget for today is spent.",
    });
    expect(mocks.generateAiText).not.toHaveBeenCalled();
  });

});
