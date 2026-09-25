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
  markAiBudgetDegraded: vi.fn(),
}));

// The two stubs are the seams this suite drives; everything else stays real.
// `rejectWithAiDailyBudgetExhausted` in particular writes the refusal body the
// tests below read off the wire -- stubbing it would assert the route calls
// something, which is a weaker claim than the client getting a usable answer.
vi.mock("../lib/ai-budget", async () => {
  const actual = await vi.importActual<typeof import("../lib/ai-budget")>(
    "../lib/ai-budget",
  );
  return {
    ...actual,
    chargeAiBudget: mocks.chargeAiBudget,
    markAiBudgetDegraded: mocks.markAiBudgetDegraded,
  };
});

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

/**
 * The client-facing half of a refusal, asserted whole rather than field by
 * field.
 *
 * A bare `{ error }` 429 here is indistinguishable from the per-identity
 * limiter's 429, whose advice is "retry in a moment" -- against a cap that
 * only clears at midnight UTC. The fields below are what let a client tell
 * the two apart and wait the right amount of time, and the header is what
 * lets the frontend react without parsing a body.
 */
/**
 * The other refusal, which must not read as the first one.
 *
 * A store outage spent nothing and observed nothing, so telling the client to
 * come back tomorrow would outlast a blip by most of a day. 503 plus a
 * one-minute `Retry-After` is the middleware's own answer to the same cause,
 * and the route has to match it.
 */
async function expectBudgetUnavailableRefusal(response: Response): Promise<void> {
  expect(response.status).toBe(503);
  expect(response.headers.get("x-sresim-ai-budget")).toBe("store-unavailable");

  const body = (await response.json()) as Record<string, unknown>;
  expect(body).toMatchObject({
    error: "The shared AI budget cannot be checked right now. Please retry shortly.",
    code: "ai_budget_unavailable",
    retryAfterSeconds: 60,
    degraded: false,
  });
  expect(body).not.toHaveProperty("resetAt");
  expect(response.headers.get("retry-after")).toBe("60");
}

async function expectDailyBudgetRefusal(response: Response): Promise<void> {
  expect(response.status).toBe(429);
  expect(response.headers.get("x-sresim-ai-budget")).toBe("daily-exhausted");

  const body = (await response.json()) as Record<string, unknown>;
  expect(body).toMatchObject({
    error: "The shared AI budget for today is spent. Please try again tomorrow.",
    code: "ai_budget_exhausted",
    scope: "daily",
    degraded: false,
  });

  const retryAfterSeconds = body.retryAfterSeconds;
  expect(typeof retryAfterSeconds).toBe("number");
  expect(retryAfterSeconds as number).toBeGreaterThan(0);
  expect(retryAfterSeconds as number).toBeLessThanOrEqual(86_400);
  expect(response.headers.get("retry-after")).toBe(String(retryAfterSeconds));

  // The daily scope is the UTC calendar day, so the reset is midnight UTC --
  // derived, because a route refusing the request may hold no window state.
  const resetAt = body.resetAt as string;
  expect(resetAt).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  expect(Date.parse(resetAt)).toBeGreaterThan(Date.now());
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
    options: { budgetExhausted?: boolean; budgetStoreUnavailable?: boolean } = {},
  ): Promise<Response> {
    const app = express();
    app.use(express.json());
    if (options.budgetStoreUnavailable) {
      // The other way `chargeAiBudget` answers `exhausted`: the window store
      // could not be read, so under `degrade` mode the request is meant to get
      // a simulated answer rather than a provider call. The header is the only
      // thing that tells this apart from a real cap.
      mocks.chargeAiBudget.mockImplementation(async (res: express.Response) => {
        res.setHeader("x-sresim-ai-budget", "store-unavailable");
        return "exhausted";
      });
    }
    if (options.budgetExhausted) {
      // A faithful stand-in for the real pair: chargeAiBudget records the
      // cause it observed, markAiBudgetDegraded upgrades it to the outcome the
      // route chose and refuses to overwrite anything else.
      mocks.chargeAiBudget.mockImplementation(async (res: express.Response) => {
        res.setHeader("x-sresim-ai-budget", "daily-exhausted");
        return "exhausted";
      });
      mocks.markAiBudgetDegraded.mockImplementation((res: express.Response) => {
        if (res.getHeader("x-sresim-ai-budget") !== "daily-exhausted") {
          return;
        }
        res.setHeader("x-sresim-ai-budget", "degraded");
      });
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

  it("labels the simulated answer as degraded rather than as a refusal", async () => {
    const response = await postCommand({ budgetExhausted: true });

    // Read off the wire, not off the mock. `chargeAiBudget` can only report
    // the cause it observed; whether the client got a refusal or a complete
    // simulated answer is the route's decision, and this is the only thing
    // that tells the two apart on a 200.
    expect(response.headers.get("x-sresim-ai-budget")).toBe("degraded");
    await response.json();
  });

  it("leaves the header on the cause when a spent budget is answered with 429", async () => {
    mocks.shouldDegradeOnQuotaExhausted.mockReturnValue(false);

    const response = await postCommand({ budgetExhausted: true });

    expect(response.status).toBe(429);
    expect(response.headers.get("x-sresim-ai-budget")).toBe("daily-exhausted");
    await response.json();
  });

  it("keeps the 429 for a spent shared budget when degradation is switched off", async () => {
    mocks.shouldDegradeOnQuotaExhausted.mockReturnValue(false);

    const response = await postCommand({ budgetExhausted: true });

    await expectDailyBudgetRefusal(response);
    expect(mocks.generateAiText).not.toHaveBeenCalled();
  });

  it("answers an unreadable budget store with 503, not 'come back tomorrow'", async () => {
    mocks.shouldDegradeOnQuotaExhausted.mockReturnValue(false);

    const response = await postCommand({ budgetStoreUnavailable: true });

    // Same `exhausted` verdict as the case above and a different refusal:
    // nothing was observed and nothing spent, so the client is asked back in a
    // minute rather than at midnight UTC.
    await expectBudgetUnavailableRefusal(response);
    expect(mocks.generateAiText).not.toHaveBeenCalled();
  });

});
