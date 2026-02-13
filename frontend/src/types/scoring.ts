export interface Score {
  efficiency: number;
  safety: number;
  documentation: number;
  accuracy: number;
  total: number;
}

export interface ScoringEvent {
  type: "bonus" | "penalty";
  dimension: keyof Omit<Score, "total">;
  points: number;
  reason: string;
  timestamp: number;
}

export const MAX_SCORE_PER_DIMENSION = 25;
export const MAX_TOTAL_SCORE = 100;
