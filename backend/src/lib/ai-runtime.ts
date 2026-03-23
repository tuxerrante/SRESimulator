import AnthropicVertex from "@anthropic-ai/vertex-sdk";
import {
  assertAiReadyForRuntime,
  getAzureOpenAiApiVersion,
  getConfiguredModel,
} from "./ai-config";
import type { AiRoute } from "./token-logger";
import { logTokenUsage, logTokenError } from "./token-logger";

export interface AiTextMessage {
  role: "user" | "assistant";
  content: string;
}

interface AiTextRequest {
  system: string;
  messages: AiTextMessage[];
  maxTokens: number;
  route?: AiRoute;
}

export interface AiTokenUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
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
 * route-specific override is configured.
 */
function getDeploymentForRoute(route?: AiRoute): string {
  if (route) {
    const envKey = `AI_AZURE_OPENAI_DEPLOYMENT_${route.toUpperCase()}`;
    const routeDeployment = process.env[envKey]?.trim();
    if (routeDeployment && routeDeployment.length > 0) return routeDeployment;
  }
  return process.env.AI_AZURE_OPENAI_DEPLOYMENT!;
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
      totalTokens: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
      latencyMs: Date.now() - start,
      timestamp: Date.now(),
      compacted: false,
      compactedMessageCount: 0,
    });
  }

  return text.trim();
}

async function* streamVertexText(
  request: AiTextRequest
): AsyncGenerator<string, void, void> {
  const client = getVertexClient();
  const stream = await client.messages.stream({
    model: getConfiguredModel(),
    max_tokens: request.maxTokens,
    system: request.system,
    messages: request.messages,
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
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
  const body = {
    messages: [
      { role: "system", content: request.system },
      ...request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ],
    temperature: 0,
    ...(useLegacyMaxTokens
      ? { max_tokens: request.maxTokens }
      : { max_completion_tokens: request.maxTokens }),
  };

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

async function callAzureOpenAi(request: AiTextRequest): Promise<string> {
  const endpoint = process.env.AI_AZURE_OPENAI_ENDPOINT!;
  const key = process.env.AI_AZURE_OPENAI_API_KEY!;
  const deployment = getDeploymentForRoute(request.route);
  const apiVersion = getAzureOpenAiApiVersion();
  const start = Date.now();

  const base = endpoint.replace(/\/+$/, "");
  let response = await runAzureOpenAiRequest(
    base,
    key,
    deployment,
    apiVersion,
    request,
    false
  );

  if (!response.ok) {
    const firstError = await response.text();
    if (firstError.includes("max_completion_tokens")) {
      response = await runAzureOpenAiRequest(
        base,
        key,
        deployment,
        apiVersion,
        request,
        true
      );
    } else if (firstError.includes("max_tokens")) {
      response = await runAzureOpenAiRequest(
        base,
        key,
        deployment,
        apiVersion,
        request,
        false
      );
    } else {
      if (request.route) logTokenError(request.route, firstError.slice(0, 200));
      throw new Error(
        `Azure OpenAI request failed (${response.status}): ${firstError}`
      );
    }
  }

  if (!response.ok) {
    const details = await response.text();
    if (request.route) logTokenError(request.route, details.slice(0, 200));
    throw new Error(`Azure OpenAI request failed (${response.status}): ${details}`);
  }

  const payload = (await response.json()) as AzureChatResponse;

  const latencyMs = Date.now() - start;
  const promptTokens = payload.usage?.prompt_tokens ?? 0;
  const completionTokens = payload.usage?.completion_tokens ?? 0;
  const reasoningTokens = payload.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  const totalTokens = payload.usage?.total_tokens ?? (promptTokens + completionTokens);

  if (request.route) {
    logTokenUsage({
      route: request.route,
      model: deployment,
      promptTokens,
      completionTokens,
      reasoningTokens,
      totalTokens,
      latencyMs,
      timestamp: Date.now(),
      compacted: false,
      compactedMessageCount: 0,
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
      throw new Error(
        "Azure OpenAI consumed completion tokens for reasoning without output text"
      );
    }

    throw new Error("Azure OpenAI response did not include text content");
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
): AsyncGenerator<string, void, void> {
  const readiness = assertAiReadyForRuntime();
  if (readiness.provider === "azure-openai") {
    const text = await callAzureOpenAi(request);
    yield text;
    return;
  }
  yield* streamVertexText(request);
}
