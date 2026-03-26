import type sql from "mssql";
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
  duration_ms: number;
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

export class MssqlLeaderboardStore implements ILeaderboardStore {
  constructor(private pool: sql.ConnectionPool) {}

  async getLeaderboard(difficulty?: Difficulty): Promise<LeaderboardEntry[]> {
    const req = this.pool.request()
      .input("limit", MAX_ENTRIES_PER_DIFFICULTY);

    let query: string;
    if (difficulty) {
      req.input("difficulty", difficulty);
      query = `
        SELECT TOP (@limit) * FROM leaderboard_entries
        WHERE difficulty = @difficulty
        ORDER BY score_total DESC, duration_ms ASC
      `;
    } else {
      query = `
        SELECT TOP (@limit) * FROM leaderboard_entries
        ORDER BY score_total DESC, duration_ms ASC
      `;
    }

    const result = await req.query<LeaderboardRow>(query);
    return result.recordset.map(rowToEntry);
  }

  async getHallOfFame(): Promise<HallOfFameEntry[]> {
    const result = await this.pool.request()
      .input("limit", MAX_HALL_OF_FAME)
      .query<{
        nickname: string;
        easy: number | null;
        medium: number | null;
        hard: number | null;
        composite: number;
      }>(`
        SELECT TOP (@limit)
          nickname,
          MAX(CASE WHEN difficulty = 'easy'   THEN score_total END) AS easy,
          MAX(CASE WHEN difficulty = 'medium' THEN score_total END) AS medium,
          MAX(CASE WHEN difficulty = 'hard'   THEN score_total END) AS hard,
          ISNULL(MAX(CASE WHEN difficulty = 'easy'   THEN score_total END), 0) +
          ISNULL(MAX(CASE WHEN difficulty = 'medium' THEN score_total END), 0) +
          ISNULL(MAX(CASE WHEN difficulty = 'hard'   THEN score_total END), 0) AS composite
        FROM leaderboard_entries
        GROUP BY nickname
        ORDER BY composite DESC
      `);

    return result.recordset.map((r) => ({
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
    await this.pool.request()
      .input("id", entry.id)
      .input("nickname", entry.nickname)
      .input("difficulty", entry.difficulty)
      .input("scoreEfficiency", entry.score.efficiency)
      .input("scoreSafety", entry.score.safety)
      .input("scoreDocumentation", entry.score.documentation)
      .input("scoreAccuracy", entry.score.accuracy)
      .input("scoreTotal", entry.score.total)
      .input("grade", entry.grade)
      .input("commandCount", entry.commandCount)
      .input("durationMs", entry.durationMs)
      .input("scenarioTitle", entry.scenarioTitle)
      .query(`
        MERGE leaderboard_entries AS target
        USING (SELECT @nickname AS nickname, @difficulty AS difficulty) AS source
        ON target.nickname = source.nickname AND target.difficulty = source.difficulty
        WHEN MATCHED AND @scoreTotal > target.score_total THEN
          UPDATE SET
            id = @id,
            score_efficiency = @scoreEfficiency,
            score_safety = @scoreSafety,
            score_documentation = @scoreDocumentation,
            score_accuracy = @scoreAccuracy,
            score_total = @scoreTotal,
            grade = @grade,
            command_count = @commandCount,
            duration_ms = @durationMs,
            scenario_title = @scenarioTitle,
            created_at = SYSDATETIMEOFFSET()
        WHEN NOT MATCHED THEN
          INSERT (id, nickname, difficulty, score_efficiency, score_safety,
                  score_documentation, score_accuracy, score_total,
                  grade, command_count, duration_ms, scenario_title)
          VALUES (@id, @nickname, @difficulty, @scoreEfficiency, @scoreSafety,
                  @scoreDocumentation, @scoreAccuracy, @scoreTotal,
                  @grade, @commandCount, @durationMs, @scenarioTitle);
      `);

    await this.trimPerDifficulty(entry.difficulty);

    return entry;
  }

  private async trimPerDifficulty(difficulty: Difficulty): Promise<void> {
    await this.pool.request()
      .input("difficulty", difficulty)
      .input("keepCount", MAX_ENTRIES_PER_DIFFICULTY)
      .query(`
        DELETE FROM leaderboard_entries
        WHERE difficulty = @difficulty
          AND id NOT IN (
            SELECT TOP (@keepCount) id FROM leaderboard_entries
            WHERE difficulty = @difficulty
            ORDER BY score_total DESC, duration_ms ASC
          )
      `);
  }
}
