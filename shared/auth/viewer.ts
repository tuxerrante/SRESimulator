import type { Difficulty } from "../types/game";

export interface GithubViewer {
  kind: "github";
  githubUserId: string;
  githubLogin: string;
  displayName: string;
  avatarUrl: string | null;
}

export type Viewer = GithubViewer | null;

export interface ViewerAccessPolicy {
  authKind: "anonymous" | "github";
  allowedDifficulties: Difficulty[];
  canPersistScores: boolean;
  leaderboardMode: "ephemeral" | "persistent";
  requiresAnonymousTrialVerification: boolean;
}
