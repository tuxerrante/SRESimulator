import type { Difficulty } from "../../../../shared/types/game";
import type { LeaderboardEntry, HallOfFameEntry } from "../../../../shared/types/leaderboard";
import type { GithubViewer } from "../../../../shared/auth/viewer";

export type SessionIdentityKind = "github" | "anonymous";

export interface GameSession {
  token: string;
  difficulty: Difficulty;
  scenarioTitle: string;
  startTime: number;
  used: boolean;
  identityKind: SessionIdentityKind;
  githubUserId: string | null;
  githubLogin: string | null;
  anonymousClaimKey: string | null;
  persistentScoreEligible: boolean;
}

export interface CreateGameSessionInput {
  difficulty: Difficulty;
  scenarioTitle: string;
  identityKind: SessionIdentityKind;
  githubUserId?: string | null;
  githubLogin?: string | null;
  anonymousClaimKey?: string | null;
  persistentScoreEligible: boolean;
}

export interface PlayerRecord {
  githubUserId: string;
  githubLogin: string;
  displayName: string;
  avatarUrl: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AnonymousTrialClaim {
  claimKey: string;
  createdAt: number;
  expiresAt: number;
}

export interface GameplayRecord {
  id?: string;
  sessionToken?: string;
  nickname?: string;
  difficulty?: Difficulty;
  scenarioTitle?: string;
  commandsExecuted?: string[];
  scoringEvents?: unknown[];
  chatMessageCount?: number;
  aiPromptTokens?: number;
  aiCompletionTokens?: number;
  durationMs?: number;
  completed?: boolean;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

export interface ISessionStore {
  create(input: CreateGameSessionInput): Promise<string>;
  create(difficulty: Difficulty, scenarioTitle: string): Promise<string>;
  validateAndConsume(token: string): Promise<GameSession | null>;
}

export interface ILeaderboardStore {
  getLeaderboard(difficulty?: Difficulty): Promise<LeaderboardEntry[]>;
  getHallOfFame(): Promise<HallOfFameEntry[]>;
  addEntry(entry: LeaderboardEntry): Promise<LeaderboardEntry>;
}

export interface IMetricsStore {
  recordGameplay(data: GameplayRecord): Promise<void>;
  getPlayerHistory(nickname: string): Promise<GameplayRecord[]>;
}

export interface IPlayerStore {
  upsertGithubViewer(viewer: GithubViewer): Promise<PlayerRecord>;
  getByGithubUserId(githubUserId: string): Promise<PlayerRecord | null>;
}

export interface IAnonymousTrialStore {
  hasActiveClaim(claimKey: string, now?: number): Promise<boolean>;
  createOrRefreshClaim(claim: AnonymousTrialClaim): Promise<void>;
  reserveClaimKeys(claimKeys: string[], claim: AnonymousTrialClaim): Promise<boolean>;
  releaseClaimKeys(claimKeys: string[]): Promise<void>;
}
