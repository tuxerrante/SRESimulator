import AnthropicVertex from "@anthropic-ai/vertex-sdk";
import {
  assertAiReadyForRuntime,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  /** @internal Set by the retry path when reasoning exhausted the completion budget. */
  _reasoningRetried?: boolean;
  /** @internal Override reasoning_effort on retry. */
  _reasoningEffortOverride?: string;
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

async function generateVertexText(request: AiTextRequest): Promise<string> {
  const client = getVertexClient();
  const model = getConfiguredModel();
  const start = Date.now();

  const response = await client.messages.create({
    model,
    max_tokens: request.maxTokens,
    system: request.system,
    messages: request.messages,
  });

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
  const client = getVertexClient();
  const model = getConfiguredModel();
  const start = Date.now();

  const stream = await client.messages.stream({
    model,
    max_tokens: request.maxTokens,
    system: request.system,
    messages: request.messages,
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }

  const finalMessage = await stream.finalMessage();
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

async function runAzureOpenAiRequest(
  endpoint: string,
  key: string,
  deployment: string,
  apiVersion: string,
  request: AiTextRequest,
  useLegacyMaxTokens: boolean
): Promise<Response> {
  const reasoningEffort =
    request._reasoningEffortOverride
    ?? process.env.AI_REASONING_EFFORT
    ?? "medium";

  const body: Record<string, unknown> = {
    messages: [
      { role: "system", content: request.system },
      ...request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ],
    temperature: 0,
    reasoning_effort: reasoningEffort,
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
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
}

async function executeAzureRequest(
  base: string,
  key: string,
  deployment: string,
  apiVersion: string,
  request: AiTextRequest,
): Promise<Response> {
  let response = await runAzureOpenAiRequest(
    base, key, deployment, apiVersion, request, false,
  );

  if (!response.ok && response.status !== 429) {
    const firstError = await response.text();
    if (firstError.includes("max_completion_tokens")) {
      response = await runAzureOpenAiRequest(
        base, key, deployment, apiVersion, request, true,
      );
    } else if (firstError.includes("max_tokens")) {
      response = await runAzureOpenAiRequest(
        base, key, deployment, apiVersion, request, false,
      );
    } else {
      if (request.route) logTokenError(request.route, firstError.slice(0, 200));
      throw new Error(
        `Azure OpenAI request failed (${response.status}): ${firstError}`
      );
    }
  }

  return response;
}

async function callAzureOpenAi(request: AiTextRequest): Promise<string> {
  const endpoint = process.env.AI_AZURE_OPENAI_ENDPOINT!;
  const key = process.env.AI_AZURE_OPENAI_API_KEY!;
  const deployment = getDeploymentForRoute(request.route);
  const apiVersion = getAzureOpenAiApiVersion();
  const start = Date.now();

  const base = endpoint.replace(/\/+$/, "");

  let response: Response | undefined;
  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
    response = await executeAzureRequest(base, key, deployment, apiVersion, request);

    if (response.status === 429) {
      if (attempt < RETRY_MAX_ATTEMPTS - 1) {
        const delay = retryDelayMs(attempt, response.headers.get("retry-after"));
        const route = request.route ?? "unknown";
        console.warn(
          `[ai-runtime] 429 throttled on route=${route} attempt=${attempt + 1}/${RETRY_MAX_ATTEMPTS}, retrying in ${Math.round(delay)}ms`,
        );
        await sleep(delay);
        continue;
      }
      if (request.route) logTokenError(request.route, "429 throttled after max retries");
      throw new AiThrottledError(
        "Azure OpenAI is currently rate-limited. Please wait a moment and try again.",
      );
    }

    break;
  }

  if (!response!.ok) {
    const details = await response!.text();
    if (request.route) logTokenError(request.route, details.slice(0, 200));
    throw new Error(`Azure OpenAI request failed (${response!.status}): ${details}`);
  }

  const payload = (await response!.json()) as AzureChatResponse;

  const latencyMs = Date.now() - start;
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
  const text =
    typeof messageContent === "string"
      ? messageContent.trim()
      : Array.isArray(messageContent)
        ? messageContent
            .map((part) => (typeof part?.text === "string" ? part.text : ""))
            .join("")
            .trim()
        : "";

  const refusal = firstChoice?.message?.refusal?.trim() ?? "";
  if (!text && refusal) {
    return refusal;
  }

  if (!text) {
    const finishedByLength = firstChoice?.finish_reason === "length";

    if (finishedByLength && completionTokens > 0 && reasoningTokens > 0) {
      if (!request._reasoningRetried) {
        console.warn(
          "[ai-runtime] Reasoning exhausted completion budget, retrying with reasoning_effort=low",
        );
        return callAzureOpenAi({
          ...request,
          _reasoningRetried: true,
          _reasoningEffortOverride: "low",
        });
      }
      const msg = "Azure OpenAI consumed completion tokens for reasoning without output text";
      if (request.route) logTokenError(request.route, msg);
      throw new Error(msg);
    }

    const msg = "Azure OpenAI response did not include text content";
    if (request.route) logTokenError(request.route, msg);
    throw new Error(msg);
  }
  return text;
}

export async function generateAiText(request: AiTextRequest): Promise<string> {
  const readiness = assertAiReadyForRuntime();
  if (readiness.provider === "azure-openai") {
    return callAzureOpenAi(request);
  }
  return generateVertexText(request);
}

export async function* streamAiText(
  request: AiTextRequest
): AsyncGenerator<string | AiReasoningRetryEvent, void, void> {
  const readiness = assertAiReadyForRuntime();
  if (readiness.provider === "azure-openai") {
    try {
      const text = await callAzureOpenAi(request);
      yield text;
    } catch (error) {
      const isReasoningExhausted =
        error instanceof Error &&
        error.message.includes("reasoning without output text");
      if (isReasoningExhausted && !request._reasoningRetried) {
        yield new AiReasoningRetryEvent();
        const text = await callAzureOpenAi({
          ...request,
          _reasoningRetried: true,
          _reasoningEffortOverride: "low",
        });
        yield text;
      } else {
        throw error;
      }
    }
    return;
  }
  yield* streamVertexText(request);
}
