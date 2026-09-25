import { chargeAiProviderRetry } from "../ai-budget";
import { getConfiguredModel } from "../ai-config";
import { logTokenError, logTokenUsage } from "../token-logger";
import {
  RETRY_MAX_ATTEMPTS,
  raceWithAbort,
  retryDelayMs,
  sleep,
  throwIfAborted,
  toAbortError,
} from "./abort";
import {
  AiQuotaExhaustedError,
  AiReasoningExhaustedError,
  AiThrottledError,
  type AiTextRequest,
  type OpenAiCompatibleTarget,
} from "./types";

interface ChatResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | Array<{ text?: string }>;
      refusal?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
}

interface StreamChoice {
  finish_reason?: string | null;
  delta?: {
    content?: string | Array<{ text?: string }>;
    refusal?: string | null;
  };
}

interface ChatStreamChunk {
  choices?: StreamChoice[];
  usage?: ChatResponse["usage"];
  /** OpenRouter reports a mid-stream upstream failure in-band, after HTTP 200. */
  error?: { message?: string; code?: number | string };
}

const VALID_REASONING_EFFORTS = new Set(["low", "medium", "high"]);

function validReasoningEffort(raw: string | undefined): "low" | "medium" | "high" {
  const normalized = raw?.trim().toLowerCase();
  if (normalized && VALID_REASONING_EFFORTS.has(normalized)) {
    return normalized as "low" | "medium" | "high";
  }
  return "medium";
}

/**
 * Resolve the reasoning_effort for a request, most specific first:
 * 1. internal retry override (e.g. reasoning-exhausted fallback, warmup)
 * 2. route-specific env `AI_REASONING_EFFORT_<ROUTE>`
 * 3. code default of "low" for the command route — command simulation is a
 *    deterministic output-formatting task, not a reasoning task, so reasoning
 *    models (gpt-5.x/o-series) should return within the command timeout instead
 *    of burning the budget on reasoning and falling back to the degraded mock.
 * 4. global env `AI_REASONING_EFFORT` (defaults to "medium" via validReasoningEffort)
 */
function resolveReasoningEffortSetting(request: AiTextRequest): string | undefined {
  if (request._reasoningEffortOverride) return request._reasoningEffortOverride;
  const route = request.route;
  if (route) {
    const routeEnv = process.env[`AI_REASONING_EFFORT_${route.toUpperCase()}`]?.trim();
    if (routeEnv) return routeEnv;
    if (route === "command") return "low";
  }
  return process.env.AI_REASONING_EFFORT;
}

function isUnsupportedReasoningEffortError(errorText: string): boolean {
  const normalized = errorText.toLowerCase();
  return normalized.includes("reasoning_effort") && (
    normalized.includes("unrecognized request argument") ||
    normalized.includes("unknown parameter") ||
    normalized.includes("unsupported")
  );
}

function extractOpenAiCompatibleTextContent(
  content: string | Array<{ text?: string }> | undefined,
): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

async function runOpenAiCompatibleRequest(
  target: OpenAiCompatibleTarget,
  request: AiTextRequest,
  maxTokensField: "max_tokens" | "max_completion_tokens",
  includeReasoningEffort: boolean,
  stream: boolean,
): Promise<Response> {
  throwIfAborted(request.signal);
  const reasoningEffort = includeReasoningEffort
    ? validReasoningEffort(resolveReasoningEffortSetting(request))
    : undefined;

  const body: Record<string, unknown> = {
    ...(target.modelField ? { [target.modelField]: target.modelValue } : {}),
    messages: [
      { role: "system", content: request.system },
      ...request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ],
    ...(includeReasoningEffort ? {} : { temperature: 0 }),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    [maxTokensField]: request.maxTokens,
  };

  if (request.cacheKey && target.supportsPromptCacheKey) {
    body.prompt_cache_key = request.cacheKey;
  }

  // Every send goes through here, including each 429 backoff attempt, the
  // max_tokens-spelling fallback, the missing-deployment fallback and the
  // reasoning retry that re-enters from ai-runtime. The route paid for the
  // first one before it called the provider; anything beyond that is a
  // request the shared budget has not seen, so it is charged here rather than
  // at any one of the four sites that can cause it.
  const sent = (request._providerRequestCount ?? 0) + 1;
  request._providerRequestCount = sent;
  if (sent > 1) {
    await chargeAiProviderRetry();
  }

  return fetch(target.url, {
    method: "POST",
    headers: {
      ...target.headers,
      accept: stream ? "text/event-stream" : "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: request.signal,
  });
}

async function executeOpenAiCompatibleRequest(
  target: OpenAiCompatibleTarget,
  request: AiTextRequest,
  stream: boolean,
): Promise<Response> {
  throwIfAborted(request.signal);
  let maxTokensField = target.maxTokensField;
  let includeReasoningEffort = target.supportsReasoningEffort;
  // Each spelling is tried at most once. Without this a provider whose error
  // text names both fields — "max_tokens is not supported, use
  // max_completion_tokens" — would flip between them forever, since neither
  // branch below bounds its own retries.
  const attemptedMaxTokensFields = new Set<string>([maxTokensField]);

  while (true) {
    const response = await runOpenAiCompatibleRequest(
      target, request, maxTokensField, includeReasoningEffort, stream,
    );

    if (response.ok || response.status === 429) {
      return response;
    }

    const details = await response.text();

    if (includeReasoningEffort && isUnsupportedReasoningEffortError(details)) {
      target.onReasoningEffortRejected?.();
      includeReasoningEffort = false;
      continue;
    }

    if (target.allowMaxTokensFieldFallback) {
      const other = maxTokensField === "max_completion_tokens"
        ? "max_tokens"
        : "max_completion_tokens";
      if (details.includes(maxTokensField) && !attemptedMaxTokensFields.has(other)) {
        attemptedMaxTokensFields.add(other);
        maxTokensField = other;
        continue;
      }
    }

    const classified = target.classifyFailure?.(response.status, details);
    if (classified) throw classified;

    if (request.route) logTokenError(request.route, details.slice(0, 200));
    throw new Error(
      `${target.providerLabel} request failed (${response.status}): ${details}`
    );
  }
}

async function requestOpenAiCompatibleResponse(
  initialTarget: OpenAiCompatibleTarget,
  request: AiTextRequest,
  stream = false,
): Promise<{ response: Response; target: OpenAiCompatibleTarget; latencyStartMs: number }> {
  throwIfAborted(request.signal);
  const latencyStartMs = Date.now();
  let target = initialTarget;
  let consumedFallback = false;

  let response: Response | undefined;

  outer: while (true) {
    for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        response = await executeOpenAiCompatibleRequest(target, request, stream);
      } catch (error) {
        if (
          !consumedFallback &&
          target.fallbackTarget &&
          target.isFallbackTrigger?.(error)
        ) {
          const noun = target.modelNoun ?? "model";
          console.warn(
            `[ai-runtime] route-specific ${target.providerLabel} ${noun} not found (${noun}=${target.modelValue}, route=${request.route ?? "none"}); retrying once with ${noun}=${target.fallbackTarget.modelValue}`,
          );
          target = target.fallbackTarget;
          consumedFallback = true;
          continue outer;
        }
        if (request.route && target.isFallbackTrigger?.(error) && error instanceof Error) {
          logTokenError(request.route, error.message);
        }
        throw error;
      }

      if (response.status === 429) {
        // Read the body before deciding: a day-scoped cap is reported as a 429
        // and sleeping through the retry budget would burn the caller's whole
        // request timeout on a limit that resets tomorrow.
        if (target.inspectThrottleBody) {
          const throttleBody = await response.clone().text().catch(() => "");
          const classified = target.classifyFailure?.(429, throttleBody);
          if (classified) {
            if (request.route) logTokenError(request.route, classified.message);
            throw classified;
          }
        }

        if (attempt < RETRY_MAX_ATTEMPTS - 1) {
          const delay = retryDelayMs(attempt, response.headers.get("retry-after"));
          const route = request.route ?? "unknown";
          console.warn(
            `[ai-runtime] 429 throttled on route=${route} attempt=${attempt + 1}/${RETRY_MAX_ATTEMPTS}, retrying in ${Math.round(delay)}ms`,
          );
          await sleep(delay, request.signal);
          continue;
        }
        if (request.route) logTokenError(request.route, "429 throttled after max retries");
        throw new AiThrottledError(
          `${target.providerLabel} is currently rate-limited. Please wait a moment and try again.`,
        );
      }

      break;
    }
    break outer;
  }

  if (!response!.ok) {
    const details = await response!.text();
    if (request.route) logTokenError(request.route, details.slice(0, 200));
    throw new Error(`${target.providerLabel} request failed (${response!.status}): ${details}`);
  }

  return { response: response!, target, latencyStartMs };
}

async function* parseOpenAiCompatibleStream(
  response: Response,
  providerLabel: string,
  signal?: AbortSignal,
): AsyncGenerator<ChatStreamChunk, void, void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error(`${providerLabel} stream did not include a readable body`);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => {
    void reader.cancel(toAbortError(signal?.reason));
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const flushBuffer = (
    rawBuffer: string,
  ): { events: ChatStreamChunk[]; remainder: string; done: boolean } => {
    const events: ChatStreamChunk[] = [];
    let remainder = rawBuffer;
    while (true) {
      const boundary = remainder.search(/\r?\n\r?\n/);
      if (boundary === -1) break;
      const rawEvent = remainder.slice(0, boundary);
      const separatorLength = remainder.startsWith("\r\n\r\n", boundary) ? 4 : 2;
      remainder = remainder.slice(boundary + separatorLength);

      const data = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();

      if (!data) continue;
      if (data === "[DONE]") {
        return { events, remainder, done: true };
      }

      let parsed: ChatStreamChunk;
      try {
        parsed = JSON.parse(data) as ChatStreamChunk;
      } catch {
        throw new Error(`${providerLabel} SSE stream: malformed JSON chunk received`);
      }
      events.push(parsed);
    }
    return { events, remainder, done: false };
  };

  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await raceWithAbort(reader.read(), signal);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const flushed = flushBuffer(buffer);
      for (const event of flushed.events) {
        yield event;
      }
      buffer = flushed.remainder;
      if (flushed.done) {
        return;
      }
    }

    buffer += decoder.decode();
    const trailing = flushBuffer(buffer);
    for (const event of trailing.events) {
      yield event;
    }
    if (trailing.done) {
      return;
    }
    throw new Error(`${providerLabel} stream ended before the completion marker`);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

export async function callOpenAiCompatible(
  initialTarget: OpenAiCompatibleTarget,
  request: AiTextRequest,
): Promise<string> {
  const { response, target, latencyStartMs } =
    await requestOpenAiCompatibleResponse(initialTarget, request);
  const payload = (await response.json()) as ChatResponse;

  const latencyMs = Date.now() - latencyStartMs;
  const promptTokens = payload.usage?.prompt_tokens ?? 0;
  const completionTokens = payload.usage?.completion_tokens ?? 0;
  const reasoningTokens = payload.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  const cachedTokens = payload.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const totalTokens = payload.usage?.total_tokens ?? (promptTokens + completionTokens);

  if (request.route) {
    logTokenUsage({
      route: request.route,
      model: getConfiguredModel(),
      deployment: target.modelValue,
      promptTokens,
      completionTokens,
      reasoningTokens,
      cachedTokens,
      totalTokens,
      latencyMs,
      timestamp: Date.now(),
      compacted: request.compactionMeta?.compacted ?? false,
      compactedMessageCount: request.compactionMeta?.compactedMessageCount ?? 0,
    });
  }

  const firstChoice = payload.choices?.[0];
  const messageContent = firstChoice?.message?.content;
  const text = extractOpenAiCompatibleTextContent(messageContent).trim();

  const refusal = firstChoice?.message?.refusal?.trim() ?? "";
  if (!text && refusal) {
    return refusal;
  }

  if (!text) {
    const finishedByLength = firstChoice?.finish_reason === "length";

    if (finishedByLength && completionTokens > 0 && reasoningTokens > 0) {
      const msg = `${target.providerLabel} consumed completion tokens for reasoning without output text`;
      if (request.route) logTokenError(request.route, msg);
      throw new AiReasoningExhaustedError(target.providerLabel);
    }

    const msg = `${target.providerLabel} response did not include text content`;
    if (request.route) logTokenError(request.route, msg);
    throw new Error(msg);
  }
  return text;
}

export async function* streamOpenAiCompatible(
  initialTarget: OpenAiCompatibleTarget,
  request: AiTextRequest,
): AsyncGenerator<string, void, void> {
  const { response, target, latencyStartMs } =
    await requestOpenAiCompatibleResponse(initialTarget, request, true);
  let finishReason: string | null | undefined;
  let usage: ChatResponse["usage"];
  let sawText = false;
  let refusal = "";
  let midStreamError: ChatStreamChunk["error"] | undefined;

  for await (const chunk of parseOpenAiCompatibleStream(response, target.providerLabel, request.signal)) {
    if (chunk.usage) {
      usage = chunk.usage;
    }
    if (chunk.error) {
      midStreamError = chunk.error;
    }

    const firstChoice = chunk.choices?.[0];
    if (!firstChoice) continue;

    finishReason = firstChoice.finish_reason ?? finishReason;
    const textChunk = extractOpenAiCompatibleTextContent(firstChoice.delta?.content);
    if (textChunk) {
      sawText = true;
      yield textChunk;
    }

    if (typeof firstChoice.delta?.refusal === "string") {
      refusal += firstChoice.delta.refusal;
    }
  }

  const latencyMs = Date.now() - latencyStartMs;
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const totalTokens = usage?.total_tokens ?? (promptTokens + completionTokens);

  if (request.route) {
    logTokenUsage({
      route: request.route,
      model: getConfiguredModel(),
      deployment: target.modelValue,
      promptTokens,
      completionTokens,
      reasoningTokens,
      cachedTokens,
      totalTokens,
      latencyMs,
      timestamp: Date.now(),
      compacted: request.compactionMeta?.compacted ?? false,
      compactedMessageCount: request.compactionMeta?.compactedMessageCount ?? 0,
    });
  }

  // An in-band error arrives after HTTP 200, so there is no status code left to
  // classify. If nothing was streamed the caller has nothing to show and must
  // see the real error; if text was already streamed, the player keeps the
  // partial answer and the truncation is only worth a log.
  if (midStreamError || finishReason === "error") {
    const detail = midStreamError?.message ?? "upstream reported finish_reason=error";
    const classified = target.classifyFailure?.(
      typeof midStreamError?.code === "number" ? midStreamError.code : 0,
      JSON.stringify({ error: midStreamError ?? { message: detail } }),
    );
    if (!sawText) {
      if (request.route) logTokenError(request.route, detail);
      throw classified ?? new Error(`${target.providerLabel} stream failed: ${detail}`);
    }
    // A spent quota is the one mid-stream failure the caller can act on, so it
    // is thrown even though text was yielded: the chat route's catch is what
    // writes the `quota_exhausted` marker frame, and swallowing the error here
    // ends a capped stream with a bare `[DONE]` that is indistinguishable from
    // a complete answer. Nothing is lost by throwing -- the route tracks
    // whether it streamed text and appends only the marker when it did.
    // Non-quota truncation keeps the original quiet return; Azure classifies
    // only DeploymentNotFound, so its behaviour here is unchanged.
    if (classified instanceof AiQuotaExhaustedError) {
      if (request.route) logTokenError(request.route, detail);
      throw classified;
    }
    console.warn(
      `[ai-runtime] ${target.providerLabel} stream ended early on route=${request.route ?? "none"}: ${detail}`,
    );
    return;
  }

  if (sawText) return;

  const refusalText = refusal.trim();
  if (refusalText) {
    yield refusalText;
    return;
  }

  if (finishReason === "length" && (!usage || (completionTokens > 0 && reasoningTokens > 0))) {
    const msg = `${target.providerLabel} consumed completion tokens for reasoning without output text`;
    if (request.route) logTokenError(request.route, msg);
    throw new AiReasoningExhaustedError(target.providerLabel);
  }

  const msg = `${target.providerLabel} response did not include text content`;
  if (request.route) logTokenError(request.route, msg);
  throw new Error(msg);
}
