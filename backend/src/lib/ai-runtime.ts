import AnthropicVertex from "@anthropic-ai/vertex-sdk";
import {
  assertAiReadyForRuntime,
  getAzureOpenAiApiVersion,
  getConfiguredModel,
} from "./ai-config";

export interface AiTextMessage {
  role: "user" | "assistant";
  content: string;
}

interface AiTextRequest {
  system: string;
  messages: AiTextMessage[];
  maxTokens: number;
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

async function generateVertexText(request: AiTextRequest): Promise<string> {
  const client = getVertexClient();
  const response = await client.messages.create({
    model: getConfiguredModel(),
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
    completion_tokens?: number;
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
  const deployment = process.env.AI_AZURE_OPENAI_DEPLOYMENT!;
  const apiVersion = getAzureOpenAiApiVersion();

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
      throw new Error(
        `Azure OpenAI request failed (${response.status}): ${firstError}`
      );
    }
  }

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Azure OpenAI request failed (${response.status}): ${details}`);
  }

  const payload = (await response.json()) as AzureChatResponse;
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
    const completionTokens = payload.usage?.completion_tokens ?? 0;
    const reasoningTokens =
      payload.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
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
