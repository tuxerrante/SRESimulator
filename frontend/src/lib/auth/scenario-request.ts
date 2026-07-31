import type { Viewer } from "@shared/auth/viewer";
import type { Difficulty } from "@shared/types/game";
import type { PlatformId } from "@shared/types/platform";

interface BuildScenarioRequestBodyInput {
  platform: PlatformId;
  difficulty: Difficulty;
  viewer: Viewer;
  fingerprintHash: string | null;
  turnstileToken: string | null;
}

export function buildScenarioRequestBody(input: BuildScenarioRequestBodyInput): Record<string, unknown> {
  if (input.viewer?.kind === "github") {
    return {
      platform: input.platform,
      difficulty: input.difficulty,
    };
  }

  return {
    platform: input.platform,
    difficulty: input.difficulty,
    fingerprintHash: input.fingerprintHash,
    turnstileToken: input.turnstileToken,
  };
}
