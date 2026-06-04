import { Router, type Request, type Response } from "express";
import { loadKnowledgeSections, queryKnowledgeSections } from "../lib/knowledge";
import { buildSystemPrompt } from "../lib/prompts/system";
import { getAiReadiness } from "../lib/ai-config";
import { generateMockChatResponse } from "../lib/mock-ai";
import { streamAiText, AiThrottledError, AiReasoningRetryEvent } from "../lib/ai-runtime";
import { compactHistory, estimateTokens } from "../lib/context-compactor";
import { captureBackendRouteError } from "../lib/telemetry/capture";
import { getSessionStore } from "../lib/storage";
import { parsePositiveIntEnv } from "../lib/env";
import { validateSessionScenario } from "../lib/session-scenario";
import { isScenario } from "../lib/scenario-validation";
import type { Scenario } from "../../../shared/types/game";
import type { InvestigationPhase } from "../../../shared/types/chat";

const MAX_CHAT_TOKENS_RAW = Number.parseInt(
  process.env.AI_MAX_CHAT_TOKENS ?? "16384",
  10,
);
const MAX_CHAT_TOKENS =
  Number.isFinite(MAX_CHAT_TOKENS_RAW) && MAX_CHAT_TOKENS_RAW > 0
    ? MAX_CHAT_TOKENS_RAW
    : 16384;
const DEFAULT_CHAT_TIMEOUT_MS = 30000;

export const chatRouter = Router();
const VALID_PHASES: InvestigationPhase[] = [
  "reading",
  "context",
  "facts",
  "theory",
  "action",
];

interface ChatRequestBody {
  sessionToken: string;
  messages: { role: "user" | "assistant"; content: string }[];
  scenario: Scenario | null;
  currentPhase: InvestigationPhase;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getChatTimeoutMs(): number {
  return parsePositiveIntEnv(process.env.AI_CHAT_TIMEOUT_MS, DEFAULT_CHAT_TIMEOUT_MS);
}

class ChatStreamTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Chat streaming timed out after ${timeoutMs}ms`);
    this.name = "ChatStreamTimeoutError";
  }
}

function isTimedOutChatError(
  error: unknown,
  signal: AbortSignal,
  timedOut: boolean,
): boolean {
  return timedOut ||
    error instanceof ChatStreamTimeoutError ||
    (error instanceof Error &&
      error.name === "AbortError" &&
      signal.reason instanceof ChatStreamTimeoutError);
}

chatRouter.post("/", async (req: Request, res: Response) => {
  try {
    if (!isRecord(req.body)) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    const body = req.body as unknown as ChatRequestBody;
    const { messages, currentPhase } = body;
    const rawScenario = body.scenario;
    if (rawScenario != null && !isScenario(rawScenario)) {
      res.status(400).json({ error: "Invalid scenario payload" });
      return;
    }
    if (typeof body.sessionToken !== "string" || body.sessionToken.trim() === "") {
      res.status(400).json({ error: "Session token is required" });
      return;
    }
    if (
      !Array.isArray(messages) ||
      messages.some(
        (message) =>
          !isRecord(message) ||
          (message.role !== "user" && message.role !== "assistant") ||
          typeof message.content !== "string",
      )
    ) {
      res.status(400).json({ error: "Invalid chat messages payload" });
      return;
    }
    if (!VALID_PHASES.includes(currentPhase)) {
      res.status(400).json({ error: "Invalid investigation phase" });
      return;
    }

    const session = await getSessionStore().get(body.sessionToken);
    if (!session || session.used) {
      res.status(403).json({ error: "Invalid or expired session token" });
      return;
    }
    const scenarioResult = validateSessionScenario(session, rawScenario);
    if (!scenarioResult.ok) {
      res.status(409).json({ error: scenarioResult.error });
      return;
    }
    const scenario = scenarioResult.scenario;

    const readiness = getAiReadiness();
    if (readiness.mockMode) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();
      const mockText = generateMockChatResponse(currentPhase);
      res.write(`data: ${JSON.stringify({ text: mockText })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    if (!readiness.ready) {
      res.status(503).json({
        error: "AI runtime configuration is invalid",
        details: readiness.reasons,
      });
      return;
    }

    const sections = await loadKnowledgeSections();
    const queryTerms = [
      scenario?.title,
      scenario?.description,
      ...(scenario?.clusterContext.alerts.map((a) => a.name) ?? []),
      messages[messages.length - 1]?.content,
    ].filter(Boolean) as string[];
    const knowledgeBase = queryKnowledgeSections(sections, queryTerms, 8000);
    const systemPrompt = buildSystemPrompt(knowledgeBase, scenario, currentPhase);
    const systemPromptTokens = estimateTokens(systemPrompt);

    const rawMessages = messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    const compaction = compactHistory(rawMessages, systemPromptTokens);

    if (compaction.compacted) {
      console.log(
        `[context-compactor] chat: compacted ${compaction.compactedCount}/${compaction.originalCount} messages, ` +
        `tokens ${compaction.estimatedTokensBefore} -> ${compaction.estimatedTokensAfter}`
      );
    }

    const streamController = new AbortController();
    const streamTimeoutMs = getChatTimeoutMs();
    let timedOut = false;
    const streamTimeout = setTimeout(() => {
      timedOut = true;
      streamController.abort(new ChatStreamTimeoutError(streamTimeoutMs));
    }, streamTimeoutMs);
    const onClientClose = () => {
      streamController.abort(new Error("Chat client disconnected"));
    };
    req.on("close", onClientClose);

    const stream = streamAiText({
      maxTokens: MAX_CHAT_TOKENS,
      system: systemPrompt,
      messages: compaction.messages,
      route: "chat",
      cacheKey: scenario?.title ?? "no-scenario",
      signal: streamController.signal,
      compactionMeta: {
        compacted: compaction.compacted,
        compactedMessageCount: compaction.compactedCount,
      },
    });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    try {
      for await (const chunk of stream) {
        if (chunk instanceof AiReasoningRetryEvent) {
          res.write(`data: ${JSON.stringify({ reasoning: true })}\n\n`);
          continue;
        }
        const data = JSON.stringify({ text: chunk });
        res.write(`data: ${data}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (error) {
      captureBackendRouteError(req, error, "Chat stream failed");
      if (res.writableEnded || res.destroyed) {
        return;
      }
      const errorMessage = isTimedOutChatError(error, streamController.signal, timedOut)
        ? "Chat stream timed out. Please retry."
        : "Chat stream failed";
      res.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
      res.end();
    } finally {
      clearTimeout(streamTimeout);
      req.off("close", onClientClose);
    }
  } catch (error) {
    if (error instanceof ChatStreamTimeoutError || (error instanceof Error && error.name === "AbortError")) {
      res.status(504).json({ error: "Chat stream timed out. Please retry." });
      return;
    }
    if (error instanceof AiThrottledError) {
      res.status(429).json({ error: error.message });
      return;
    }
    captureBackendRouteError(req, error);
    res.status(500).json({ error: "Chat request failed" });
  }
});
