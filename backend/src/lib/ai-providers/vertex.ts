import AnthropicVertex from "@anthropic-ai/vertex-sdk";
import { getConfiguredModel } from "../ai-config";
import { logTokenUsage } from "../token-logger";
import { raceWithAbort, throwIfAborted } from "./abort";
import type { AiTextRequest } from "./types";

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

export async function generateVertexText(request: AiTextRequest): Promise<string> {
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

export async function* streamVertexText(
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
