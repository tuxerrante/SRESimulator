import AnthropicVertex from "@anthropic-ai/vertex-sdk";
import { assertAiReadyForRuntime, getConfiguredModel } from "./ai-config";

let client: AnthropicVertex | null = null;

export function getClaudeClient(): AnthropicVertex {
  if (!client) {
    const readiness = assertAiReadyForRuntime();
    if (readiness.mockMode) {
      throw new Error(
        "AI mock mode is enabled; live Claude client is unavailable."
      );
    }

    client = new AnthropicVertex({
      region: process.env.CLOUD_ML_REGION!,
      projectId: process.env.ANTHROPIC_VERTEX_PROJECT_ID!,
    });
  }
  return client;
}

export function getClaudeModel(): string {
  return getConfiguredModel();
}
