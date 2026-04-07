import type { Difficulty } from "./game";
import type { Score } from "./scoring";

export interface LeaderboardEntry {
  id: string;
  nickname: string;
  difficulty: Difficulty;
  score: Score;
  grade: string;
  commandCount: number;
  durationMs: number;
  scenarioTitle: string;
  timestamp: number;
}

export interface HallOfFameEntry {
  nickname: string;
  compositeScore: number;
  scores: {
    easy?: number;
    medium?: number;
    hard?: number;
  };
}
