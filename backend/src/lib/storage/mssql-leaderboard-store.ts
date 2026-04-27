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
  identity_kind: "github" | null;
  github_user_id: string | null;
  github_login: string | null;
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
    ...(row.identity_kind ? { identityKind: row.identity_kind } : {}),
    ...(row.github_user_id ? { githubUserId: row.github_user_id } : {}),
    ...(row.github_login ? { githubLogin: row.github_login } : {}),
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
          AND identity_kind = 'github'
          AND github_user_id IS NOT NULL
        ORDER BY score_total DESC, duration_ms ASC
      `;
    } else {
      query = `
        SELECT TOP (@limit) * FROM leaderboard_entries
        WHERE identity_kind = 'github'
          AND github_user_id IS NOT NULL
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
        WITH github_entries AS (
          SELECT
            github_user_id,
            nickname,
            difficulty,
            score_total,
            ROW_NUMBER() OVER (
              PARTITION BY github_user_id
              ORDER BY created_at DESC, id DESC
            ) AS nickname_rank
          FROM leaderboard_entries
          WHERE identity_kind = 'github' AND github_user_id IS NOT NULL
        ),
        aggregated_scores AS (
          SELECT
            github_user_id,
            MAX(CASE WHEN difficulty = 'easy'   THEN score_total END) AS easy,
            MAX(CASE WHEN difficulty = 'medium' THEN score_total END) AS medium,
            MAX(CASE WHEN difficulty = 'hard'   THEN score_total END) AS hard
          FROM github_entries
          GROUP BY github_user_id
        )
        SELECT TOP (@limit)
          latest.nickname,
          aggregated_scores.easy,
          aggregated_scores.medium,
          aggregated_scores.hard,
          ISNULL(aggregated_scores.easy, 0) +
          ISNULL(aggregated_scores.medium, 0) +
          ISNULL(aggregated_scores.hard, 0) AS composite
        FROM aggregated_scores
        INNER JOIN github_entries AS latest
          ON latest.github_user_id = aggregated_scores.github_user_id
         AND latest.nickname_rank = 1
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
    if (!entry.githubUserId || entry.identityKind !== "github") {
      throw new Error("Persistent leaderboard entries require a GitHub-backed identity");
    }

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
      .input("identityKind", entry.identityKind)
      .input("githubUserId", entry.githubUserId)
      .input("githubLogin", entry.githubLogin ?? null)
      .query(`
        MERGE leaderboard_entries AS target
        USING (SELECT @githubUserId AS github_user_id, @difficulty AS difficulty) AS source
        ON target.github_user_id = source.github_user_id AND target.difficulty = source.difficulty
        WHEN MATCHED AND (@scoreTotal > target.score_total OR (@scoreTotal = target.score_total AND @durationMs < target.duration_ms)) THEN
          UPDATE SET
            id = @id,
            nickname = @nickname,
            score_efficiency = @scoreEfficiency,
            score_safety = @scoreSafety,
            score_documentation = @scoreDocumentation,
            score_accuracy = @scoreAccuracy,
            score_total = @scoreTotal,
            grade = @grade,
            command_count = @commandCount,
            duration_ms = @durationMs,
            scenario_title = @scenarioTitle,
            identity_kind = @identityKind,
            github_user_id = @githubUserId,
            github_login = @githubLogin,
            created_at = SYSDATETIMEOFFSET()
        WHEN NOT MATCHED THEN
          INSERT (id, nickname, difficulty, score_efficiency, score_safety,
                  score_documentation, score_accuracy, score_total,
                  grade, command_count, duration_ms, scenario_title,
                  identity_kind, github_user_id, github_login)
          VALUES (@id, @nickname, @difficulty, @scoreEfficiency, @scoreSafety,
                  @scoreDocumentation, @scoreAccuracy, @scoreTotal,
                  @grade, @commandCount, @durationMs, @scenarioTitle,
                  @identityKind, @githubUserId, @githubLogin);
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
