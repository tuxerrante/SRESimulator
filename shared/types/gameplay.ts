import type { Difficulty } from "./game";
import type { TrafficSource } from "./leaderboard";

export type GameplayLifecycleState = "started" | "completed" | "abandoned";

export interface GameplayTelemetryEvent {
  sessionToken: string;
  lifecycleState: GameplayLifecycleState;
  trafficSource?: TrafficSource;
  nickname?: string;
  difficulty?: Difficulty;
  scenarioTitle?: string;
  commandCount?: number;
  commandsExecuted?: string[];
  scoringEvents?: unknown[];
  chatMessageCount?: number;
  durationMs?: number;
  scoreTotal?: number;
  grade?: string;
  metadata?: Record<string, unknown>;
}

export interface GameplayAnalyticsSummary {
  totalSessions: number;
  completedSessions: number;
  abandonedSessions: number;
  inProgressSessions: number;
  completionRate: number;
  abandonmentRate: number;
  avgCompletionDurationMs: number | null;
  avgCompletionCommandCount: number | null;
  avgCompletionChatMessageCount: number | null;
  avgCompletionScoreTotal: number | null;
}

export interface GameplayDifficultyAnalytics {
  difficulty: Difficulty;
  totalSessions: number;
  completedSessions: number;
  abandonedSessions: number;
  inProgressSessions: number;
  completionRate: number;
}

export interface GameplayScenarioAnalytics {
  scenarioTitle: string;
  difficulty?: Difficulty;
  totalSessions: number;
  completedSessions: number;
  abandonedSessions: number;
  inProgressSessions: number;
  completionRate: number;
}

export interface RecentGameplaySession {
  lifecycleState: GameplayLifecycleState;
  nickname?: string;
  difficulty?: Difficulty;
  scenarioTitle?: string;
  commandCount?: number;
  chatMessageCount?: number;
  durationMs?: number;
  scoreTotal?: number;
  grade?: string;
  createdAt: string;
}

export interface GameplayAnalytics {
  summary: GameplayAnalyticsSummary;
  byDifficulty: GameplayDifficultyAnalytics[];
  byScenario: GameplayScenarioAnalytics[];
  recentSessions: RecentGameplaySession[];
}
