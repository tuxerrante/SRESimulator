import type { Difficulty } from "../types/game";
import type { Viewer, ViewerAccessPolicy } from "./viewer";

const ANONYMOUS_DIFFICULTIES: Difficulty[] = ["easy"];
const AUTHENTICATED_DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];

export function getViewerAccessPolicy(viewer: Viewer): ViewerAccessPolicy {
  if (viewer?.kind === "github") {
    return {
      authKind: "github",
      allowedDifficulties: AUTHENTICATED_DIFFICULTIES,
      canPersistScores: true,
      leaderboardMode: "persistent",
      requiresAnonymousTrialVerification: false,
    };
  }

  return {
    authKind: "anonymous",
    allowedDifficulties: ANONYMOUS_DIFFICULTIES,
    canPersistScores: false,
    leaderboardMode: "ephemeral",
    requiresAnonymousTrialVerification: true,
  };
}

export function canAccessDifficulty(viewer: Viewer, difficulty: Difficulty): boolean {
  return getViewerAccessPolicy(viewer).allowedDifficulties.includes(difficulty);
}
