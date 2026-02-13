import AnthropicVertex from "@anthropic-ai/vertex-sdk";

export const CLAUDE_MODEL = "claude-sonnet-4@20250514";

let client: AnthropicVertex | null = null;

export function getClaudeClient(): AnthropicVertex {
  if (!client) {
    client = new AnthropicVertex({
      region: process.env.CLOUD_ML_REGION!,
      projectId: process.env.ANTHROPIC_VERTEX_PROJECT_ID!,
    });
  }
  return client;
}
