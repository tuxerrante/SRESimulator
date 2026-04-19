import type { Difficulty } from "../../../../shared/types/game";
import type {
  LeaderboardEntry,
  HallOfFameEntry,
  TrafficSource,
} from "../../../../shared/types/leaderboard";

export type { TrafficSource } from "../../../../shared/types/leaderboard";

export interface GameSession {
  token: string;
  difficulty: Difficulty;
  scenarioTitle: string;
  startTime: number;
  used: boolean;
  trafficSource: TrafficSource;
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
  trafficSource?: TrafficSource;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

export interface ISessionStore {
  create(
    difficulty: Difficulty,
    scenarioTitle: string,
    trafficSource?: TrafficSource
  ): Promise<string>;
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
