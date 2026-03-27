import type { Difficulty } from "../../../../shared/types/game";
import type { LeaderboardEntry, HallOfFameEntry } from "../../../../shared/types/leaderboard";

export interface GameSession {
  token: string;
  difficulty: Difficulty;
  scenarioTitle: string;
  startTime: number;
  used: boolean;
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
