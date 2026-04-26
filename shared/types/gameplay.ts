import type { Difficulty } from "./game";

export type GameplayLifecycleState = "started" | "completed" | "abandoned";

export interface GameplayTelemetryEvent {
  sessionToken: string;
  lifecycleState: GameplayLifecycleState;
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
