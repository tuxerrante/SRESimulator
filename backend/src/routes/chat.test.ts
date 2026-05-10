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

import { chatRouter } from "./chat";

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

describe("chatRouter", () => {
  beforeEach(() => {
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
      difficulty: "easy",
      scenarioTitle: "Test Scenario",
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

    const app = express();
    app.use(express.json());
    app.use("/api/chat", chatRouter);
    const server = await new Promise<Server>((resolve) => {
      const listeningServer = app.listen(0, "127.0.0.1", () => resolve(listeningServer));
    });

    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionToken: "session-123",
          messages: [{ role: "user", content: "hello" }],
          scenario: null,
          currentPhase: "reading",
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toContain('data: {"error":"Chat stream failed"}');
      expect(mocks.captureBackendRouteError).toHaveBeenCalledTimes(1);
      expect(mocks.captureBackendRouteError.mock.calls[0]?.[1]).toBe(streamError);
      expect(mocks.captureBackendRouteError.mock.calls[0]?.[2]).toBe("Chat stream failed");
    } finally {
      await close(server);
    }
  });
});
