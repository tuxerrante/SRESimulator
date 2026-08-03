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
  generateMockChatResponse: vi.fn(),
  streamAiText: vi.fn(),
  compactHistory: vi.fn(),
  estimateTokens: vi.fn(),
  getSessionStore: vi.fn(),
  sessionGet: vi.fn(),
}));

vi.mock("../lib/knowledge", () => ({
  loadKnowledgeSections: mocks.loadKnowledgeSections,
  queryKnowledgeSections: mocks.queryKnowledgeSections,
}));

vi.mock("../lib/prompts/system", () => ({
  buildSystemPrompt: mocks.buildSystemPrompt,
}));

vi.mock("../lib/ai-config", () => ({
  getAiReadiness: mocks.getAiReadiness,
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

import { AiReasoningRetryEvent } from "../lib/ai-runtime";
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

async function withChatServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
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
    } finally {
      await close(server);
    }
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
});
