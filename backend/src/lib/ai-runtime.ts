import AnthropicVertex from "@anthropic-ai/vertex-sdk";
import {
  assertAiReadyForRuntime,
  getAiReadiness,
  getAzureOpenAiApiVersion,
  getConfiguredModel,
} from "./ai-config";
import type { AiRoute } from "./token-logger";
import { logTokenUsage, logTokenError } from "./token-logger";

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 8000;

export class AiThrottledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiThrottledError";
  }
}

function retryDelayMs(attempt: number, retryAfterHeader?: string | null): number {
  if (retryAfterHeader) {
    const seconds = parseFloat(retryAfterHeader);
    if (!isNaN(seconds) && seconds > 0) return Math.min(seconds * 1000, RETRY_MAX_DELAY_MS);
  }
  const exponential = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * RETRY_BASE_DELAY_MS;
  return Math.min(exponential + jitter, RETRY_MAX_DELAY_MS);
}

function toAbortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" ? reason : "The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw toAbortError(signal.reason);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  if (signal.aborted) {
    return Promise.reject(toAbortError(signal.reason));
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(toAbortError(signal.reason));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function raceWithAbort<T>(operation: PromiseLike<T> | T, signal?: AbortSignal): Promise<T> {
  const operationPromise = Promise.resolve(operation);
  if (!signal) {
    return operationPromise;
  }
  if (signal.aborted) {
    return Promise.reject(toAbortError(signal.reason));
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(toAbortError(signal.reason));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    operationPromise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export interface AiTextMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiCompactionMeta {
  compacted: boolean;
  compactedMessageCount: number;
}

interface AiTextRequest {
  system: string;
  messages: AiTextMessage[];
  maxTokens: number;
  route?: AiRoute;
  compactionMeta?: AiCompactionMeta;
  cacheKey?: string;
  signal?: AbortSignal;
  /** @internal Override reasoning_effort on retry. */
  _reasoningEffortOverride?: string;
}

export class AiReasoningExhaustedError extends Error {
  constructor() {
    super("Azure OpenAI consumed completion tokens for reasoning without output text");
    this.name = "AiReasoningExhaustedError";
  }
}

export class AiReasoningRetryEvent {
  readonly type = "reasoning-retry" as const;
}

let vertexClient: AnthropicVertex | null = null;

function getVertexClient(): AnthropicVertex {
  if (!vertexClient) {
    vertexClient = new AnthropicVertex({
      region: process.env.CLOUD_ML_REGION!,
      projectId: process.env.ANTHROPIC_VERTEX_PROJECT_ID!,
    });
  }
  return vertexClient;
}

/**
 * Resolve the Azure OpenAI deployment for a given route.
 * Falls back to the global AI_AZURE_OPENAI_DEPLOYMENT if no
 * route-specific override is configured. Throws with clear
 * diagnostics when neither is set.
 */
function getDeploymentForRoute(route?: AiRoute): string {
  let routeEnvKey: string | undefined;

  if (route) {
    routeEnvKey = `AI_AZURE_OPENAI_DEPLOYMENT_${route.toUpperCase()}`;
    const routeDeployment = process.env[routeEnvKey]?.trim();
    if (routeDeployment && routeDeployment.length > 0) return routeDeployment;
  }

  const globalDeployment = process.env.AI_AZURE_OPENAI_DEPLOYMENT?.trim();
  if (globalDeployment && globalDeployment.length > 0) return globalDeployment;

  const missingKeys = routeEnvKey
    ? [routeEnvKey, "AI_AZURE_OPENAI_DEPLOYMENT"]
    : ["AI_AZURE_OPENAI_DEPLOYMENT"];
  throw new Error(
    `Azure OpenAI deployment not configured. Set: ${missingKeys.join(" or ")}`
  );
}

/** Route-only override from `AI_AZURE_OPENAI_DEPLOYMENT_<ROUTE>` when set. */
function getRouteSpecificAzureDeployment(route?: AiRoute): string | null {
  if (!route) return null;
  const routeEnvKey = `AI_AZURE_OPENAI_DEPLOYMENT_${route.toUpperCase()}`;
  const routeDeployment = process.env[routeEnvKey]?.trim();
  return routeDeployment && routeDeployment.length > 0 ? routeDeployment : null;
}

function isAzureDeploymentNotFoundResponse(status: number, details: string): boolean {
  if (status !== 404) return false;
  if (/deploymentnotfound/i.test(details)) return true;
  try {
    const parsed = JSON.parse(details) as { error?: { code?: string } };
    return parsed?.error?.code === "DeploymentNotFound";
  } catch {
    return false;
  }
}

class AzureDeploymentNotFoundError extends Error {
  override readonly name = "AzureDeploymentNotFoundError";
  constructor(message: string) {
    super(message);
  }
}

async function generateVertexText(request: AiTextRequest): Promise<string> {
  throwIfAborted(request.signal);
  const client = getVertexClient();
  const model = getConfiguredModel();
  const start = Date.now();

  const response = await raceWithAbort(
    client.messages.create({
      model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: request.messages,
    }),
    request.signal,
  );

  const textParts: string[] = [];
  for (const part of response.content) {
    if (part.type === "text" && "text" in part && typeof part.text === "string") {
      textParts.push(part.text);
    }
  }
  const text = textParts.join("");

  if (request.route) {
    logTokenUsage({
      route: request.route,
      model,
      promptTokens: response.usage?.input_tokens ?? 0,
      completionTokens: response.usage?.output_tokens ?? 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      totalTokens: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
      latencyMs: Date.now() - start,
      timestamp: Date.now(),
      compacted: request.compactionMeta?.compacted ?? false,
      compactedMessageCount: request.compactionMeta?.compactedMessageCount ?? 0,
    });
  }

  return text.trim();
}

async function* streamVertexText(
  request: AiTextRequest
): AsyncGenerator<string, void, void> {
  throwIfAborted(request.signal);
  const client = getVertexClient();
  const model = getConfiguredModel();
  const start = Date.now();

  const stream = await raceWithAbort(
    client.messages.stream({
      model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: request.messages,
    }),
    request.signal,
  );
  const streamWithAbort = stream as unknown as {
    abort?: () => void;
    controller?: { abort?: () => void };
  };
  const onAbort = () => {
    streamWithAbort.abort?.();
    streamWithAbort.controller?.abort?.();
  };
  request.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    for await (const event of stream) {
      throwIfAborted(request.signal);
      if (
        event.type === "content_block_delta" &&
        event.delta?.type === "text_delta" &&
        typeof event.delta.text === "string"
      ) {
        yield event.delta.text;
      }
    }

    const finalMessage = await raceWithAbort(stream.finalMessage(), request.signal);
    if (request.route) {
      logTokenUsage({
        route: request.route,
        model,
        promptTokens: finalMessage.usage?.input_tokens ?? 0,
        completionTokens: finalMessage.usage?.output_tokens ?? 0,
        reasoningTokens: 0,
        cachedTokens: 0,
        totalTokens: (finalMessage.usage?.input_tokens ?? 0) + (finalMessage.usage?.output_tokens ?? 0),
        latencyMs: Date.now() - start,
        timestamp: Date.now(),
        compacted: request.compactionMeta?.compacted ?? false,
        compactedMessageCount: request.compactionMeta?.compactedMessageCount ?? 0,
      });
    }
  } finally {
    request.signal?.removeEventListener("abort", onAbort);
  }
}

interface AzureChatResponse {
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

interface AzureStreamChoice {
  finish_reason?: string | null;
  delta?: {
    content?: string | Array<{ text?: string }>;
    refusal?: string | null;
  };
}

interface AzureChatStreamChunk {
  choices?: AzureStreamChoice[];
  usage?: AzureChatResponse["usage"];
}

const VALID_REASONING_EFFORTS = new Set(["low", "medium", "high"]);
const deploymentReasoningEffortSupport = new Map<string, boolean>();

function validReasoningEffort(raw: string | undefined): "low" | "medium" | "high" {
  const normalized = raw?.trim().toLowerCase();
  if (normalized && VALID_REASONING_EFFORTS.has(normalized)) {
    return normalized as "low" | "medium" | "high";
  }
  return "medium";
}

function isReasoningModelName(value: string): boolean {
  return /^o\d/.test(value) || /^gpt-5/.test(value);
}

function shouldSendReasoningEffort(deployment: string): boolean {
  const deploymentKey = deployment.trim().toLowerCase();
  const cached = deploymentReasoningEffortSupport.get(deploymentKey);
  if (cached !== undefined) return cached;

  const configuredModel = getConfiguredModel().trim().toLowerCase();
  const deploymentLooksNonReasoningModel =
    deploymentKey.includes("gpt-4o") ||
    deploymentKey.includes("gpt-4.1") ||
    deploymentKey.includes("gpt-4.5") ||
    deploymentKey.includes("gpt-35") ||
    deploymentKey.includes("gpt-3.5");

  const supports =
    isReasoningModelName(deploymentKey) ||
    (isReasoningModelName(configuredModel) && !deploymentLooksNonReasoningModel);

  deploymentReasoningEffortSupport.set(deploymentKey, supports);
  return supports;
}

function isUnsupportedReasoningEffortError(errorText: string): boolean {
  const normalized = errorText.toLowerCase();
  return normalized.includes("reasoning_effort") && (
    normalized.includes("unrecognized request argument") ||
    normalized.includes("unknown parameter") ||
    normalized.includes("unsupported")
  );
}

async function runAzureOpenAiRequest(
  endpoint: string,
  key: string,
  deployment: string,
  apiVersion: string,
  request: AiTextRequest,
  useLegacyMaxTokens: boolean,
  includeReasoningEffort: boolean,
  stream: boolean,
): Promise<Response> {
  throwIfAborted(request.signal);
  const reasoningEffort = includeReasoningEffort
    ? validReasoningEffort(
      request._reasoningEffortOverride ?? process.env.AI_REASONING_EFFORT,
    )
    : undefined;

  const body: Record<string, unknown> = {
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
    ...(useLegacyMaxTokens
      ? { max_tokens: request.maxTokens }
      : { max_completion_tokens: request.maxTokens }),
  };

  if (request.cacheKey) {
    body.prompt_cache_key = request.cacheKey;
  }

  return fetch(
    `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`,
    {
      method: "POST",
      headers: {
        "api-key": key,
        accept: stream ? "text/event-stream" : "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: request.signal,
    }
  );
}

async function executeAzureRequest(
  base: string,
  key: string,
  deployment: string,
  apiVersion: string,
  request: AiTextRequest,
  stream = false,
): Promise<Response> {
  throwIfAborted(request.signal);
  const deploymentKey = deployment.trim().toLowerCase();
  let useLegacyMaxTokens = false;
  let includeReasoningEffort = shouldSendReasoningEffort(deployment);

  while (true) {
    const response = await runAzureOpenAiRequest(
      base, key, deployment, apiVersion, request, useLegacyMaxTokens, includeReasoningEffort, stream,
    );

    if (response.ok || response.status === 429) {
      return response;
    }

    const details = await response.text();

    if (includeReasoningEffort && isUnsupportedReasoningEffortError(details)) {
      deploymentReasoningEffortSupport.set(deploymentKey, false);
      includeReasoningEffort = false;
      continue;
    }

    if (!useLegacyMaxTokens && details.includes("max_completion_tokens")) {
      useLegacyMaxTokens = true;
      continue;
    }

    if (useLegacyMaxTokens && details.includes("max_tokens")) {
      useLegacyMaxTokens = false;
      continue;
    }

    if (isAzureDeploymentNotFoundResponse(response.status, details)) {
      throw new AzureDeploymentNotFoundError(
        `Azure OpenAI request failed (${response.status}): ${details}`,
      );
    }

    if (request.route) logTokenError(request.route, details.slice(0, 200));
    throw new Error(
      `Azure OpenAI request failed (${response.status}): ${details}`
    );
  }
}

function extractAzureTextContent(content: string | Array<{ text?: string }> | undefined): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

async function requestAzureOpenAiResponse(
  request: AiTextRequest,
  stream = false,
): Promise<{ response: Response; deployment: string; latencyStartMs: number }> {
  throwIfAborted(request.signal);
  const endpoint = process.env.AI_AZURE_OPENAI_ENDPOINT!;
  const key = process.env.AI_AZURE_OPENAI_API_KEY!;
  let deployment = getDeploymentForRoute(request.route);
  const routeSpecificDeployment = getRouteSpecificAzureDeployment(request.route);
  const globalDeployment = process.env.AI_AZURE_OPENAI_DEPLOYMENT?.trim() ?? "";
  const canDeploymentFallback =
    Boolean(routeSpecificDeployment) &&
    globalDeployment.length > 0 &&
    routeSpecificDeployment !== globalDeployment;
  const apiVersion = getAzureOpenAiApiVersion();
  const latencyStartMs = Date.now();

  const base = endpoint.replace(/\/+$/, "");

  let response: Response | undefined;
  let consumedDeploymentFallback = false;

  outer: while (true) {
    for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        response = await executeAzureRequest(base, key, deployment, apiVersion, request, stream);
      } catch (error) {
        if (error instanceof AzureDeploymentNotFoundError) {
          if (
            canDeploymentFallback &&
            !consumedDeploymentFallback &&
            deployment === routeSpecificDeployment
          ) {
            console.warn(
              `[ai-runtime] route-specific Azure OpenAI deployment not found (deployment=${deployment}, route=${request.route ?? "none"}); retrying once with deployment=${globalDeployment}`,
            );
            deployment = globalDeployment;
            consumedDeploymentFallback = true;
            continue outer;
          }

          if (request.route) logTokenError(request.route, error.message);
        }
        throw error;
      }

      if (response.status === 429) {
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
          "Azure OpenAI is currently rate-limited. Please wait a moment and try again.",
        );
      }

      break;
    }
    break outer;
  }

  if (!response!.ok) {
    const details = await response!.text();
    if (request.route) logTokenError(request.route, details.slice(0, 200));
    throw new Error(`Azure OpenAI request failed (${response!.status}): ${details}`);
  }

  return { response: response!, deployment, latencyStartMs };
}

async function* parseAzureOpenAiStream(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<AzureChatStreamChunk, void, void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Azure OpenAI stream did not include a readable body");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => {
    void reader.cancel(toAbortError(signal?.reason));
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const flushBuffer = (
    rawBuffer: string,
  ): { events: AzureChatStreamChunk[]; remainder: string; done: boolean } => {
    const events: AzureChatStreamChunk[] = [];
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

      let parsed: AzureChatStreamChunk;
      try {
        parsed = JSON.parse(data) as AzureChatStreamChunk;
      } catch {
        throw new Error(`Azure SSE stream: malformed JSON chunk received`);
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
    throw new Error("Azure OpenAI stream ended before the completion marker");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

async function callAzureOpenAi(request: AiTextRequest): Promise<string> {
  const { response, deployment, latencyStartMs } = await requestAzureOpenAiResponse(request);
  const payload = (await response.json()) as AzureChatResponse;

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
      deployment,
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
  const text = extractAzureTextContent(messageContent).trim();

  const refusal = firstChoice?.message?.refusal?.trim() ?? "";
  if (!text && refusal) {
    return refusal;
  }

  if (!text) {
    const finishedByLength = firstChoice?.finish_reason === "length";

    if (finishedByLength && completionTokens > 0 && reasoningTokens > 0) {
      const msg = "Azure OpenAI consumed completion tokens for reasoning without output text";
      if (request.route) logTokenError(request.route, msg);
      throw new AiReasoningExhaustedError();
    }

    const msg = "Azure OpenAI response did not include text content";
    if (request.route) logTokenError(request.route, msg);
    throw new Error(msg);
  }
  return text;
}

async function* streamAzureOpenAi(
  request: AiTextRequest,
): AsyncGenerator<string, void, void> {
  const { response, deployment, latencyStartMs } = await requestAzureOpenAiResponse(request, true);
  let finishReason: string | null | undefined;
  let usage: AzureChatResponse["usage"];
  let sawText = false;
  let refusal = "";

  for await (const chunk of parseAzureOpenAiStream(response, request.signal)) {
    if (chunk.usage) {
      usage = chunk.usage;
    }

    const firstChoice = chunk.choices?.[0];
    if (!firstChoice) continue;

    finishReason = firstChoice.finish_reason ?? finishReason;
    const textChunk = extractAzureTextContent(firstChoice.delta?.content);
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
      deployment,
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

  if (sawText) return;

  const refusalText = refusal.trim();
  if (refusalText) {
    yield refusalText;
    return;
  }

  if (finishReason === "length" && (!usage || (completionTokens > 0 && reasoningTokens > 0))) {
    const msg = "Azure OpenAI consumed completion tokens for reasoning without output text";
    if (request.route) logTokenError(request.route, msg);
    throw new AiReasoningExhaustedError();
  }

  const msg = "Azure OpenAI response did not include text content";
  if (request.route) logTokenError(request.route, msg);
  throw new Error(msg);
}

export async function generateAiText(request: AiTextRequest): Promise<string> {
  const readiness = assertAiReadyForRuntime();
  if (readiness.provider === "azure-openai") {
    try {
      return await callAzureOpenAi(request);
    } catch (error) {
      if (error instanceof AiReasoningExhaustedError) {
        console.warn("[ai-runtime] Reasoning exhausted budget, retrying with reasoning_effort=low");
        return callAzureOpenAi({
          ...request,
          _reasoningEffortOverride: "low",
        });
      }
      throw error;
    }
  }
  return generateVertexText(request);
}

export function warmupAiModel(route: AiRoute = "command"): void {
  const readiness = getAiReadiness();
  if (readiness.mockMode) return;

  generateAiText({
    system: "You are a keep-alive bot. Respond with 'ping'.",
    messages: [{ role: "user", content: "ping" }],
    maxTokens: 5,
    route,
    _reasoningEffortOverride: "low",
  }).catch(() => {
    // Intentionally suppress the raw exception. E.g. 'e.message' may leak upstream 503 texts or IP addresses
    // which should not be emitted to stdout. Instead, use a sanitized invariant logging or just ignore it
    // since it's fire-and-forget. The structured telemetry logger in generateAiText will have captured the core
    // upstream request trace already.
    console.warn("[ai-runtime] Warmup request failed (ignored) due to transient AI error.");
  });
}

export async function* streamAiText(
  request: AiTextRequest
): AsyncGenerator<string | AiReasoningRetryEvent, void, void> {
  const readiness = assertAiReadyForRuntime();
  if (readiness.provider === "azure-openai") {
    try {
      yield* streamAzureOpenAi(request);
    } catch (error) {
      if (error instanceof AiReasoningExhaustedError) {
        console.warn("[ai-runtime] Reasoning exhausted budget, retrying with reasoning_effort=low");
        yield new AiReasoningRetryEvent();
        yield* streamAzureOpenAi({
          ...request,
          _reasoningEffortOverride: "low",
        });
      } else {
        throw error;
      }
    }
    return;
  }
  yield* streamVertexText(request);
}
