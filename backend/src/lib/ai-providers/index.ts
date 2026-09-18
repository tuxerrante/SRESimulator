import type { AiProvider } from "../ai-config";
import { buildAzureOpenAiTarget } from "./azure-openai";
import { buildOpenRouterTarget } from "./openrouter";
import { callOpenAiCompatible, streamOpenAiCompatible } from "./openai-compatible";
import { generateVertexText, streamVertexText } from "./vertex";
import type { AiTextRequest, OpenAiCompatibleTarget } from "./types";

export interface AiProviderAdapter {
  generate(request: AiTextRequest): Promise<string>;
  stream(request: AiTextRequest): AsyncGenerator<string, void, void>;
}

/**
 * The target is rebuilt per request because the model/deployment is
 * route-scoped, and because every input it reads is an env var that a test or
 * an operator can change between calls.
 */
function openAiCompatibleAdapter(
  buildTarget: (request: AiTextRequest) => OpenAiCompatibleTarget,
): AiProviderAdapter {
  return {
    generate: (request) => callOpenAiCompatible(buildTarget(request), request),
    stream: (request) => streamOpenAiCompatible(buildTarget(request), request),
  };
}

const PROVIDER_ADAPTERS: Record<AiProvider, AiProviderAdapter> = {
  vertex: { generate: generateVertexText, stream: streamVertexText },
  "azure-openai": openAiCompatibleAdapter(buildAzureOpenAiTarget),
  openrouter: openAiCompatibleAdapter(buildOpenRouterTarget),
};

export function getProviderAdapter(provider: AiProvider): AiProviderAdapter {
  return PROVIDER_ADAPTERS[provider];
}
