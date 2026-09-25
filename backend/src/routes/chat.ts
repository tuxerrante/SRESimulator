import { Router, type Request, type Response } from "express";
import { loadKnowledgeSections, queryKnowledgeSections } from "../lib/knowledge";
import { getRuntimePlatformProfile } from "../lib/platform-profiles";
import { buildSystemPrompt } from "../lib/prompts/system";
import { getAiReadiness, shouldDegradeOnQuotaExhausted } from "../lib/ai-config";
import {
  chargeAiBudget,
  markAiBudgetDegraded,
  rejectWithAiDailyBudgetExhausted,
} from "../lib/ai-budget";
import { generateMockChatResponse } from "../lib/mock-ai";
import {
  streamAiText,
  AiQuotaExhaustedError,
  AiThrottledError,
  AiReasoningRetryEvent,
} from "../lib/ai-runtime";
import { compactHistory, estimateTokens } from "../lib/context-compactor";
import { captureBackendRouteError } from "../lib/telemetry/capture";
import { parsePositiveIntEnv } from "../lib/env";
import { getRequestSession } from "../lib/rate-limit";
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

    const session = await getRequestSession(req, body.sessionToken);
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
    const profile = getRuntimePlatformProfile(session.platform);

    const readiness = getAiReadiness();
    if (readiness.mockMode) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();
      const mockText = generateMockChatResponse(
        currentPhase,
        session.platform,
      );
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

    // Charged here, after every branch above that answers without a
    // provider: a malformed payload, an expired session, a scenario
    // mismatch, mock mode and an unready runtime have all returned already,
    // so none of them can spend a slot the provider never saw. Before any
    // prompt is built, because a spent budget can only come back 429 and a
    // 429 here would read as an outage for the rest of the day.
    const budget = await chargeAiBudget(res);
    if (budget === "answered") {
      // Already refused with the structured budget body -- code, scope,
      // resetAt -- which is strictly more than this route could say alone.
      return;
    }
    if (budget === "exhausted" && !shouldDegradeOnQuotaExhausted()) {
      // Degradation switched off: answer the way a provider throttle is
      // answered, but without spending a request proving what is already known.
      //
      // The same body the middleware-side refusal writes, rather than a bare
      // `{ error }`: a client that cannot tell this from the per-identity 429
      // retries in a minute, all day, against a cap that only clears at
      // midnight UTC.
      rejectWithAiDailyBudgetExhausted(res);
      return;
    }
    if (budget === "exhausted") {
      // The same frames the mid-stream quota path emits, so the client cannot
      // tell which side of the call ran out.
      console.warn("[chat] AI budget exhausted (daily); returning simulated response");
      // Before flushHeaders: an SSE client reads these once, and this is the
      // only place it can learn the stream below is simulated without waiting
      // for the marker frame.
      markAiBudgetDegraded(res);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();
      const mockText = generateMockChatResponse(currentPhase, session.platform);
      res.write(`data: ${JSON.stringify({ text: mockText })}\n\n`);
      res.write(
        `data: ${JSON.stringify({ degraded: true, degradedReason: "quota_exhausted" })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    const sections = await loadKnowledgeSections(session.platform);
    const queryTerms = [
      scenario?.title,
      scenario?.description,
      ...(scenario?.clusterContext.alerts.map((a) => a.name) ?? []),
      messages[messages.length - 1]?.content,
    ].filter(Boolean) as string[];
    const knowledgeBase = queryKnowledgeSections(sections, queryTerms, 8000);
    const systemPrompt = buildSystemPrompt(
      knowledgeBase,
      scenario,
      currentPhase,
      profile,
    );
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

    // Every platform streams chunk-by-chunk. The AKS kubectl-only constraint is
    // enforced by the platform-scoped, CLI-neutral knowledge base and the AKS
    // CLI reminder in the system prompt; a slipped `oc` block is still labelled
    // "not valid for AKS" and made non-runnable by the frontend, and the
    // `/command` route rejects a mismatched CLI with HTTP 409.
    let streamedText = false;
    try {
      for await (const chunk of stream) {
        if (chunk instanceof AiReasoningRetryEvent) {
          res.write(`data: ${JSON.stringify({ reasoning: true })}\n\n`);
          continue;
        }
        streamedText = true;
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
      // The 200 and the SSE headers are already on the wire by this point, so a
      // 429 is no longer available: a spent budget has to be answered in
      // frames. Nothing is substituted if the model already said something —
      // the player keeps the partial answer and only learns why it stopped.
      if (
        error instanceof AiQuotaExhaustedError &&
        shouldDegradeOnQuotaExhausted()
      ) {
        console.warn(
          `[chat] AI budget exhausted (${error.scope}); returning simulated response`,
        );
        if (!streamedText) {
          const mockText = generateMockChatResponse(currentPhase, session.platform);
          res.write(`data: ${JSON.stringify({ text: mockText })}\n\n`);
        }
        res.write(
          `data: ${JSON.stringify({ degraded: true, degradedReason: "quota_exhausted" })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
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
      // Reachable only before the stream is handed its first chunk; once
      // streaming starts the quota path above answers in frames instead.
      res.status(429).json({ error: error.message });
      return;
    }
    captureBackendRouteError(req, error);
    res.status(500).json({ error: "Chat request failed" });
  }
});
