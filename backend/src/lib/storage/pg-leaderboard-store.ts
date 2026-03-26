import type { Pool } from "pg";
import type { Difficulty } from "../../../../shared/types/game";
import type { LeaderboardEntry, HallOfFameEntry } from "../../../../shared/types/leaderboard";
import type { ILeaderboardStore } from "./types";

const MAX_ENTRIES_PER_DIFFICULTY = 10;
const MAX_HALL_OF_FAME = 10;

interface LeaderboardRow {
  id: string;
  nickname: string;
  difficulty: Difficulty;
  score_efficiency: number;
  score_safety: number;
  score_documentation: number;
  score_accuracy: number;
  score_total: number;
  grade: string;
  command_count: number;
  duration_ms: string;
  scenario_title: string;
  created_at: Date;
}

function rowToEntry(row: LeaderboardRow): LeaderboardEntry {
  return {
    id: row.id,
    nickname: row.nickname,
    difficulty: row.difficulty,
    score: {
      efficiency: row.score_efficiency,
      safety: row.score_safety,
      documentation: row.score_documentation,
      accuracy: row.score_accuracy,
      total: row.score_total,
    },
    grade: row.grade,
    commandCount: row.command_count,
    durationMs: Number(row.duration_ms),
    scenarioTitle: row.scenario_title,
    timestamp: row.created_at.getTime(),
  };
}

export class PgLeaderboardStore implements ILeaderboardStore {
  constructor(private pool: Pool) {}

  async getLeaderboard(difficulty?: Difficulty): Promise<LeaderboardEntry[]> {
    const query = `
      SELECT * FROM leaderboard_entries
      ${difficulty ? "WHERE difficulty = $1" : ""}
      ORDER BY score_total DESC, duration_ms ASC
      LIMIT $${difficulty ? "2" : "1"}
    `;
    const params: unknown[] = difficulty
      ? [difficulty, MAX_ENTRIES_PER_DIFFICULTY]
      : [MAX_ENTRIES_PER_DIFFICULTY];

    const { rows } = await this.pool.query<LeaderboardRow>(query, params);
    return rows.map(rowToEntry);
  }

  async getHallOfFame(): Promise<HallOfFameEntry[]> {
    const { rows } = await this.pool.query<{
      nickname: string;
      easy: number | null;
      medium: number | null;
      hard: number | null;
      composite: number;
    }>(`
      SELECT
        nickname,
        MAX(CASE WHEN difficulty = 'easy'   THEN score_total END) AS easy,
        MAX(CASE WHEN difficulty = 'medium' THEN score_total END) AS medium,
        MAX(CASE WHEN difficulty = 'hard'   THEN score_total END) AS hard,
        COALESCE(MAX(CASE WHEN difficulty = 'easy'   THEN score_total END), 0) +
        COALESCE(MAX(CASE WHEN difficulty = 'medium' THEN score_total END), 0) +
        COALESCE(MAX(CASE WHEN difficulty = 'hard'   THEN score_total END), 0) AS composite
      FROM leaderboard_entries
      GROUP BY nickname
      ORDER BY composite DESC
      LIMIT $1
    `, [MAX_HALL_OF_FAME]);

    return rows.map((r) => ({
      nickname: r.nickname,
      compositeScore: Number(r.composite),
      scores: {
        ...(r.easy != null ? { easy: r.easy } : {}),
        ...(r.medium != null ? { medium: r.medium } : {}),
        ...(r.hard != null ? { hard: r.hard } : {}),
      },
    }));
  }

  async addEntry(entry: LeaderboardEntry): Promise<LeaderboardEntry> {
    await this.pool.query(`
      INSERT INTO leaderboard_entries
        (id, nickname, difficulty, score_efficiency, score_safety,
         score_documentation, score_accuracy, score_total,
         grade, command_count, duration_ms, scenario_title)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (nickname, difficulty) DO UPDATE SET
        id = EXCLUDED.id,
        score_efficiency = EXCLUDED.score_efficiency,
        score_safety = EXCLUDED.score_safety,
        score_documentation = EXCLUDED.score_documentation,
        score_accuracy = EXCLUDED.score_accuracy,
        score_total = EXCLUDED.score_total,
        grade = EXCLUDED.grade,
        command_count = EXCLUDED.command_count,
        duration_ms = EXCLUDED.duration_ms,
        scenario_title = EXCLUDED.scenario_title,
        created_at = NOW()
      WHERE EXCLUDED.score_total > leaderboard_entries.score_total
    `, [
      entry.id,
      entry.nickname,
      entry.difficulty,
      entry.score.efficiency,
      entry.score.safety,
      entry.score.documentation,
      entry.score.accuracy,
      entry.score.total,
      entry.grade,
      entry.commandCount,
      entry.durationMs,
      entry.scenarioTitle,
    ]);

    await this.trimPerDifficulty(entry.difficulty);

    return entry;
  }

  private async trimPerDifficulty(difficulty: Difficulty): Promise<void> {
    await this.pool.query(`
      DELETE FROM leaderboard_entries
      WHERE difficulty = $1
        AND id NOT IN (
          SELECT id FROM leaderboard_entries
          WHERE difficulty = $1
          ORDER BY score_total DESC, duration_ms ASC
          LIMIT $2
        )
    `, [difficulty, MAX_ENTRIES_PER_DIFFICULTY]);
  }
}
