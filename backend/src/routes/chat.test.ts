import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureBackendRouteError: vi.fn(),
  loadKnowledgeSections: vi.fn(),
  queryKnowledgeSections: vi.fn(),
  buildSystemPrompt: vi.fn(),
  getAiReadiness: vi.fn(),
  shouldDegradeOnQuotaExhausted: vi.fn(),
  generateMockChatResponse: vi.fn(),
  streamAiText: vi.fn(),
  compactHistory: vi.fn(),
  estimateTokens: vi.fn(),
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

vi.mock("../lib/knowledge", () => ({
  loadKnowledgeSections: mocks.loadKnowledgeSections,
  queryKnowledgeSections: mocks.queryKnowledgeSections,
}));

vi.mock("../lib/prompts/system", () => ({
  buildSystemPrompt: mocks.buildSystemPrompt,
}));

vi.mock("../lib/ai-config", () => ({
  getAiReadiness: mocks.getAiReadiness,
  shouldDegradeOnQuotaExhausted: mocks.shouldDegradeOnQuotaExhausted,
}));

vi.mock("../lib/mock-ai", () => ({
  generateMockChatResponse: mocks.generateMockChatResponse,
}));

vi.mock("../lib/ai-runtime", async () => {
  const actual = await vi.importActual<typeof import("../lib/ai-runtime")>("../lib/ai-runtime");
  return {
    ...actual,
    streamAiText: mocks.streamAiText,
  };
});

vi.mock("../lib/context-compactor", () => ({
  compactHistory: mocks.compactHistory,
  estimateTokens: mocks.estimateTokens,
}));

vi.mock("../lib/telemetry/capture", () => ({
  captureBackendRouteError: mocks.captureBackendRouteError,
}));

vi.mock("../lib/storage", () => ({
  getSessionStore: mocks.getSessionStore,
}));

import { AiQuotaExhaustedError, AiReasoningRetryEvent } from "../lib/ai-runtime";
import { aiRateLimit } from "../lib/rate-limit";
import { chatRouter } from "./chat";

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, label: string, ms = 250): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

interface SseReaderState {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  decoder: TextDecoder;
  buffer: string;
}

function createSseReader(response: Response): SseReaderState {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Expected SSE response body");
  }

  return {
    reader,
    decoder: new TextDecoder(),
    buffer: "",
  };
}

async function readNextSseEvent(state: SseReaderState, label: string): Promise<string> {
  return withTimeout((async () => {
    while (true) {
      const boundary = state.buffer.indexOf("\n\n");
      if (boundary !== -1) {
        const event = state.buffer.slice(0, boundary + 2);
        state.buffer = state.buffer.slice(boundary + 2);
        return event;
      }

      const { done, value } = await state.reader.read();
      if (done) {
        throw new Error("SSE stream ended before next event");
      }

      state.buffer += state.decoder.decode(value, { stream: true });
    }
  })(), label);
}

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

async function withChatServer(
  run: (baseUrl: string) => Promise<void>,
  options: { budgetExhausted?: boolean } = {},
): Promise<void> {
  const app = express();
  app.use(express.json());
  if (options.budgetExhausted) {
    // A faithful stand-in for the real pair: chargeAiBudget records the cause
    // it observed, markAiBudgetDegraded upgrades it to the outcome the route
    // chose and refuses to overwrite anything else.
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
  app.use("/api/chat", chatRouter);

  const server = await new Promise<Server>((resolve) => {
    const listeningServer = app.listen(0, "127.0.0.1", () => resolve(listeningServer));
  });

  try {
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}/api/chat`);
  } finally {
    await close(server);
  }
}

function defaultChatBody() {
  return {
    sessionToken: "session-123",
    messages: [{ role: "user", content: "hello" }],
    scenario: null,
    currentPhase: "reading",
  };
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

describe("chatRouter", () => {
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
    mocks.loadKnowledgeSections.mockResolvedValue([]);
    mocks.queryKnowledgeSections.mockReturnValue("");
    mocks.buildSystemPrompt.mockReturnValue("system prompt");
    mocks.estimateTokens.mockReturnValue(0);
    mocks.compactHistory.mockReturnValue({
      messages: [],
      compacted: false,
      compactedCount: 0,
      originalCount: 1,
      estimatedTokensBefore: 0,
      estimatedTokensAfter: 0,
    });
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

  it("streams separate Azure text chunks to SSE clients before the AI stream finishes", async () => {
    const allowSecondChunk = createDeferred<void>();
    let streamCompleted = false;

    mocks.streamAiText.mockImplementation(async function* () {
      yield "Hello";
      await allowSecondChunk.promise;
      yield " world";
      streamCompleted = true;
    });

    await withChatServer(async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(defaultChatBody()),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");

      const sse = createSseReader(response);
      const firstEvent = await readNextSseEvent(sse, "first SSE chunk");

      expect(firstEvent).toBe(`data: ${JSON.stringify({ text: "Hello" })}\n\n`);
      expect(streamCompleted).toBe(false);

      allowSecondChunk.resolve();

      const secondEvent = await readNextSseEvent(sse, "second SSE chunk");
      const doneEvent = await readNextSseEvent(sse, "DONE SSE chunk");

      expect(secondEvent).toBe(`data: ${JSON.stringify({ text: " world" })}\n\n`);
      expect(doneEvent).toBe("data: [DONE]\n\n");
    });
  });

  it("preserves reasoning retry signaling between Azure SSE text chunks", async () => {
    mocks.streamAiText.mockImplementation(async function* () {
      yield "Thinking";
      yield new AiReasoningRetryEvent();
      yield "Recovered";
      yield " output";
    });

    await withChatServer(async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(defaultChatBody()),
      });

      expect(response.status).toBe(200);

      const sse = createSseReader(response);
      const firstEvent = await readNextSseEvent(sse, "first SSE event");
      const retryEvent = await readNextSseEvent(sse, "reasoning SSE event");
      const thirdEvent = await readNextSseEvent(sse, "third SSE event");
      const fourthEvent = await readNextSseEvent(sse, "fourth SSE event");
      const doneEvent = await readNextSseEvent(sse, "DONE SSE event");

      expect(firstEvent).toBe(`data: ${JSON.stringify({ text: "Thinking" })}\n\n`);
      expect(retryEvent).toBe(`data: ${JSON.stringify({ reasoning: true })}\n\n`);
      expect(thirdEvent).toBe(`data: ${JSON.stringify({ text: "Recovered" })}\n\n`);
      expect(fourthEvent).toBe(`data: ${JSON.stringify({ text: " output" })}\n\n`);
      expect(doneEvent).toBe("data: [DONE]\n\n");
    });
  });

  it("reuses the rate-limit session lookup on hot chat requests", async () => {
    const sessionToken = "11111111-1111-4111-8111-111111111111";
    mocks.getAiReadiness.mockReturnValue({ ready: true, mockMode: true });
    mocks.generateMockChatResponse.mockReturnValue("mock chat response");

    const app = express();
    app.use(express.json());
    app.use("/api/chat", aiRateLimit, chatRouter);

    const server = await new Promise<Server>((resolve) => {
      const listeningServer = app.listen(0, "127.0.0.1", () => resolve(listeningServer));
    });

    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...defaultChatBody(),
          sessionToken,
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toContain("mock chat response");
      expect(mocks.sessionGet).toHaveBeenCalledTimes(1);
      expect(mocks.sessionGet).toHaveBeenCalledWith(sessionToken);
      // Mock mode answers above the charge point, so no provider is reached
      // and no slot of the shared budget is spent.
      expect(mocks.chargeAiBudget).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("charges nothing when the AI runtime is unready and the route answers 503", async () => {
    mocks.getAiReadiness.mockReturnValue({
      ready: false,
      mockMode: false,
      reasons: ["AI_AZURE_OPENAI_API_KEY is not set"],
    });

    await withChatServer(async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(defaultChatBody()),
      });

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "AI runtime configuration is invalid",
        details: ["AI_AZURE_OPENAI_API_KEY is not set"],
      });
    });

    // The readiness refusal is the one exemption an app-level store assertion
    // cannot reach -- a well-formed body gets past payload validation, so only
    // the route's own ordering keeps this request off the shared budget.
    expect(mocks.chargeAiBudget).not.toHaveBeenCalled();
    expect(mocks.streamAiText).not.toHaveBeenCalled();
  });

  it("captures stream failures after SSE headers are sent", async () => {
    const streamError = new Error("stream exploded");

    const failingStream: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            throw streamError;
          },
        };
      },
    };

    mocks.streamAiText.mockReturnValue(failingStream);

    await withChatServer(async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(defaultChatBody()),
      });

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toContain('data: {"error":"Chat stream failed"}');
      expect(mocks.captureBackendRouteError).toHaveBeenCalledTimes(1);
      expect(mocks.captureBackendRouteError.mock.calls[0]?.[1]).toBe(streamError);
      expect(mocks.captureBackendRouteError.mock.calls[0]?.[2]).toBe("Chat stream failed");
    });
  });

  it("streams responses chunk-by-chunk unchanged, leaving oc blocks intact", async () => {
    // Every platform streams verbatim now — there is no AKS-only buffering or
    // CLI rewrite. AKS kubectl-only correctness is enforced by the prompt,
    // scoped KB, the frontend, and the `/command` route, not by mutating chunks.
    mocks.streamAiText.mockImplementation(async function* () {
      yield "```oc\n";
      yield "oc get nodes\n```";
    });

    await withChatServer(async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(defaultChatBody()),
      });

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain(`data: ${JSON.stringify({ text: "```oc\n" })}\n\n`);
      expect(body).toContain(`data: ${JSON.stringify({ text: "oc get nodes\n```" })}\n\n`);
      expect(body).not.toContain("kubectl");
    });
  });

  it("streams AKS chunks incrementally without whole-response buffering", async () => {
    // Regression guard for the removed AKS-only buffering: an AKS session must
    // flush the first SSE text event BEFORE the AI stream finishes. If a future
    // change reintroduced AKS buffering, the first event would only arrive after
    // the whole response completed and this assertion would fail.
    const aksScenario = {
      id: "scenario_aks_easy",
      platform: "aks",
      title: "AKS Test Scenario",
      difficulty: "easy",
      description: "AKS scenario description",
      incidentTicket: {
        id: "IcM-AKS",
        severity: "Sev3",
        title: "AKS ticket title",
        description: "AKS ticket description",
        customerImpact: "Low",
        reportedTime: "2026-05-01T10:00:00.000Z",
        clusterName: "aks-cluster-test",
        region: "eastus",
      },
      clusterContext: {
        name: "aks-cluster-test",
        version: "1.31.2",
        region: "eastus",
        nodeCount: 3,
        status: "Degraded",
        recentEvents: [],
        alerts: [],
        upgradeHistory: [],
      },
    };
    mocks.sessionGet.mockResolvedValueOnce({
      token: "session-123",
      platform: "aks",
      difficulty: "easy",
      scenarioId: "scenario_aks_easy",
      scenarioTitle: "AKS Test Scenario",
      scenarioPayload: JSON.stringify(aksScenario),
      startTime: Date.now(),
      used: false,
      trafficSource: "player",
      identityKind: "anonymous",
      githubUserId: null,
      githubLogin: null,
      anonymousClaimKey: null,
      persistentScoreEligible: false,
    });

    const allowSecondChunk = createDeferred<void>();
    let streamCompleted = false;
    mocks.streamAiText.mockImplementation(async function* () {
      yield "First";
      await allowSecondChunk.promise;
      yield " second";
      streamCompleted = true;
    });

    await withChatServer(async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(defaultChatBody()),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");

      const sse = createSseReader(response);
      const firstEvent = await readNextSseEvent(sse, "first AKS SSE chunk");

      // The first chunk is delivered before the generator yields the second.
      expect(firstEvent).toBe(`data: ${JSON.stringify({ text: "First" })}\n\n`);
      expect(streamCompleted).toBe(false);

      allowSecondChunk.resolve();

      const secondEvent = await readNextSseEvent(sse, "second AKS SSE chunk");
      const doneEvent = await readNextSseEvent(sse, "DONE AKS SSE chunk");

      expect(secondEvent).toBe(`data: ${JSON.stringify({ text: " second" })}\n\n`);
      expect(doneEvent).toBe("data: [DONE]\n\n");
    });
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

    await withChatServer(async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(defaultChatBody()),
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "Session scenario context is unavailable",
      });
    });
  });

  it("answers an exhausted budget in SSE frames, because the 200 is already sent", async () => {
    mocks.generateMockChatResponse.mockReturnValue("simulated mentor reply");
    // Yields nothing on purpose: this is the case where the budget is spent
    // before the model produced a single chunk.
    // eslint-disable-next-line require-yield
    mocks.streamAiText.mockImplementation(async function* () {
      throw new AiQuotaExhaustedError("daily", "The shared budget is spent.");
    });

    await withChatServer(async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(defaultChatBody()),
      });

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('data: {"text":"simulated mentor reply"}');
      expect(body).toContain('data: {"degraded":true,"degradedReason":"quota_exhausted"}');
      expect(body).toContain("data: [DONE]");
      expect(body).not.toContain('"error"');
    });
  });

  it("keeps a partial answer and does not substitute a simulated one over it", async () => {
    mocks.generateMockChatResponse.mockReturnValue("simulated mentor reply");
    mocks.streamAiText.mockImplementation(async function* () {
      yield "the first half of a real answer";
      throw new AiQuotaExhaustedError("daily", "The shared budget is spent.");
    });

    await withChatServer(async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(defaultChatBody()),
      });

      const body = await response.text();
      expect(body).toContain('data: {"text":"the first half of a real answer"}');
      expect(body).not.toContain("simulated mentor reply");
      expect(body).toContain('data: {"degraded":true,"degradedReason":"quota_exhausted"}');
    });
  });

  it("reports the stream failure normally when degradation is switched off", async () => {
    mocks.shouldDegradeOnQuotaExhausted.mockReturnValue(false);
    // eslint-disable-next-line require-yield
    mocks.streamAiText.mockImplementation(async function* () {
      throw new AiQuotaExhaustedError("credits", "The shared account is out of credit.");
    });

    await withChatServer(async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(defaultChatBody()),
      });

      await expect(response.text()).resolves.toContain('data: {"error":"Chat stream failed"}');
    });
  });
  it("answers a spent shared budget in frames without opening a stream", async () => {
    mocks.generateMockChatResponse.mockReturnValue("simulated mentor reply");

    await withChatServer(async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(defaultChatBody()),
      });

      expect(response.status).toBe(200);
      const body = await response.text();
      // Byte-for-byte the frames the mid-stream quota path emits, so the
      // client cannot tell which side of the call ran out.
      expect(body).toContain('data: {"text":"simulated mentor reply"}');
      expect(body).toContain('data: {"degraded":true,"degradedReason":"quota_exhausted"}');
      expect(body).toContain("data: [DONE]");
    }, { budgetExhausted: true });

    expect(mocks.streamAiText).not.toHaveBeenCalled();
  });

  it("tells a streaming client its answer is simulated, not that it was refused", async () => {
    mocks.generateMockChatResponse.mockReturnValue("simulated mentor reply");

    await withChatServer(async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(defaultChatBody()),
      });

      // Read off the wire rather than off the mock: the header has to be set
      // before flushHeaders, and an SSE client gets exactly one look at it.
      // `daily-exhausted` here would tell the client the budget turned it
      // away, when it is about to receive a complete simulated answer.
      expect(response.headers.get("x-sresim-ai-budget")).toBe("degraded");
      await response.text();
    }, { budgetExhausted: true });
  });

  it("answers a spent shared budget with 429 when degradation is switched off", async () => {
    mocks.shouldDegradeOnQuotaExhausted.mockReturnValue(false);

    await withChatServer(async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(defaultChatBody()),
      });

      // A 429 is still available here only because nothing has been written
      // yet; once the stream starts the quota path has to answer in frames.
      // Nothing was simulated on this path, so the header stays on the cause.
      await expectDailyBudgetRefusal(response);
    }, { budgetExhausted: true });

    expect(mocks.streamAiText).not.toHaveBeenCalled();
  });
});
