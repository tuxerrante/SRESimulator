import type { Viewer } from "@shared/auth/viewer";
import type { Difficulty } from "@shared/types/game";

interface BuildScenarioRequestBodyInput {
  difficulty: Difficulty;
  viewer: Viewer;
  fingerprintHash: string | null;
  turnstileToken: string | null;
}

export function buildScenarioRequestBody(input: BuildScenarioRequestBodyInput): Record<string, unknown> {
  if (input.viewer?.kind === "github") {
    return {
      difficulty: input.difficulty,
    };
  }

  return {
    difficulty: input.difficulty,
    fingerprintHash: input.fingerprintHash,
    turnstileToken: input.turnstileToken,
  };
}
