import type { Difficulty } from "../../../../shared/types/game";
import type { LeaderboardEntry, HallOfFameEntry, TrafficSource } from "../../../../shared/types/leaderboard";
import type { GameplayAnalytics, GameplayLifecycleState } from "../../../../shared/types/gameplay";
import type { GithubViewer } from "../../../../shared/auth/viewer";

export type SessionIdentityKind = "github" | "anonymous";
export type { TrafficSource } from "../../../../shared/types/leaderboard";

export interface GameSession {
  token: string;
  difficulty: Difficulty;
  scenarioId: string | null;
  scenarioTitle: string;
  scenarioPayload: string | null;
  startTime: number;
  used: boolean;
  trafficSource: TrafficSource;
  identityKind: SessionIdentityKind;
  githubUserId: string | null;
  githubLogin: string | null;
  anonymousClaimKey: string | null;
  persistentScoreEligible: boolean;
}

export interface CreateGameSessionInput {
  difficulty: Difficulty;
  scenarioId?: string | null;
  scenarioTitle: string;
  scenarioPayload?: string | null;
  trafficSource?: TrafficSource;
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
  trafficSource?: TrafficSource;
  nickname?: string;
  difficulty?: Difficulty;
  scenarioTitle?: string;
  lifecycleState?: GameplayLifecycleState;
  commandCount?: number;
  commandsExecuted?: string[];
  scoringEvents?: unknown[];
  chatMessageCount?: number;
  aiPromptTokens?: number;
  aiCompletionTokens?: number;
  durationMs?: number;
  scoreTotal?: number;
  grade?: string;
  completed?: boolean;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

export interface ISessionStore {
  create(input: CreateGameSessionInput): Promise<string>;
  create(difficulty: Difficulty, scenarioTitle: string): Promise<string>;
  create(difficulty: Difficulty, scenarioTitle: string, trafficSource: TrafficSource): Promise<string>;
  get(token: string): Promise<GameSession | null>;
  validateAndConsume(token: string): Promise<GameSession | null>;
}

export interface ILeaderboardStore {
  getLeaderboard(difficulty?: Difficulty): Promise<LeaderboardEntry[]>;
  getHallOfFame(): Promise<HallOfFameEntry[]>;
  addEntry(entry: LeaderboardEntry): Promise<LeaderboardEntry>;
}

export interface IMetricsStore {
  recordGameplay(data: GameplayRecord): Promise<void>;
  hasLifecycleEvent(
    sessionToken: string,
    lifecycleState: GameplayLifecycleState,
  ): Promise<boolean>;
  getLatestBySessionToken(sessionToken: string): Promise<GameplayRecord | null>;
  getLatestCompletedBySessionToken(sessionToken: string): Promise<GameplayRecord | null>;
  getPlayerHistory(nickname: string): Promise<GameplayRecord[]>;
  getGameplayAnalytics(): Promise<GameplayAnalytics>;
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
