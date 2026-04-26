import type { GithubViewer } from "../../../shared/auth/viewer";
import type { Difficulty } from "../../../shared/types/game";

interface EvaluateScenarioAccessInput {
  difficulty: Difficulty;
  viewer: GithubViewer | null;
  hasValidTurnstileToken: boolean;
  hasAnonymousProof: boolean;
  hasActiveAnonymousClaim: boolean;
}

type ScenarioAccessDecision =
  | {
      allowed: true;
      sessionIdentityKind: "github" | "anonymous";
    }
  | {
      allowed: false;
      code:
        | "github_required"
        | "anonymous_verification_required"
        | "anonymous_daily_limit_reached";
      message: string;
    };

export function evaluateScenarioAccess(
  input: EvaluateScenarioAccessInput
): ScenarioAccessDecision {
  if (input.viewer?.kind === "github") {
    return {
      allowed: true,
      sessionIdentityKind: "github",
    };
  }

  if (input.difficulty !== "easy") {
    return {
      allowed: false,
      code: "github_required",
      message: "GitHub login is required for medium and hard scenarios.",
    };
  }

  if (!input.hasValidTurnstileToken || !input.hasAnonymousProof) {
    return {
      allowed: false,
      code: "anonymous_verification_required",
      message: "Anonymous Easy mode requires captcha-backed verification.",
    };
  }

  if (input.hasActiveAnonymousClaim) {
    return {
      allowed: false,
      code: "anonymous_daily_limit_reached",
      message: "Anonymous Easy mode is limited to one run per day.",
    };
  }

  return {
    allowed: true,
    sessionIdentityKind: "anonymous",
  };
}
