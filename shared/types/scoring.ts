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

export function scoreToGrade(totalScore: number): string {
  if (totalScore >= 90) return "A";
  if (totalScore >= 80) return "B";
  if (totalScore >= 70) return "C";
  if (totalScore >= 60) return "D";
  return "F";
}
