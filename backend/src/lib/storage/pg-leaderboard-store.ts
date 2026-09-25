import type { Difficulty } from "../../../../shared/types/game";
import type { PlatformId } from "../../../../shared/types/platform";
import type { LeaderboardEntry, HallOfFameEntry } from "../../../../shared/types/leaderboard";
import { pgQuery, pgReadQuery, type PgQueryable } from "./pg-pool";
import type { ILeaderboardStore, LeaderboardFilters } from "./types";

const MAX_ENTRIES_PER_DIFFICULTY = 10;
const MAX_HALL_OF_FAME = 10;

interface LeaderboardRow {
  id: string;
  nickname: string;
  platform: PlatformId;
  difficulty: Difficulty;
  score_efficiency: number;
  score_safety: number;
  score_documentation: number;
  score_accuracy: number;
  score_total: number;
  grade: string;
  command_count: number;
  duration_ms: string | number;
  scenario_title: string;
  traffic_source: "player" | "automated" | null;
  identity_kind: "github" | null;
  github_user_id: string | null;
  github_login: string | null;
  created_at: Date;
}

function rowToEntry(row: LeaderboardRow): LeaderboardEntry {
  return {
    id: row.id,
    nickname: row.nickname,
    platform: row.platform,
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
    ...(row.traffic_source ? { trafficSource: row.traffic_source } : {}),
    ...(row.identity_kind ? { identityKind: row.identity_kind } : {}),
    ...(row.github_user_id ? { githubUserId: row.github_user_id } : {}),
    ...(row.github_login ? { githubLogin: row.github_login } : {}),
    timestamp: row.created_at.getTime(),
  };
}

export class PgLeaderboardStore implements ILeaderboardStore {
  constructor(private pool: PgQueryable) {}

  async getLeaderboard(filters?: LeaderboardFilters): Promise<LeaderboardEntry[]> {
    const difficulty = filters?.difficulty;
    const platform = filters?.platform ?? null;

    // Difficulty is folded into one placeholder rather than branching the SQL:
    // a NULL parameter means "any", the same trick the platform filter already
    // uses on both backends.
    const result = await pgReadQuery<LeaderboardRow>(this.pool, `
      SELECT *
      FROM leaderboard_entries
      WHERE ($1::text IS NULL OR difficulty = $1)
        AND ($2::text IS NULL OR platform = $2)
        AND traffic_source = 'player'
        AND identity_kind = 'github'
        AND github_user_id IS NOT NULL
      ORDER BY score_total DESC, duration_ms ASC
      LIMIT $3
    `, [difficulty ?? null, platform, MAX_ENTRIES_PER_DIFFICULTY]);

    return result.rows.map(rowToEntry);
  }

  async getHallOfFame(platform: PlatformId): Promise<HallOfFameEntry[]> {
    const result = await pgReadQuery<{
      nickname: string;
      easy: number | null;
      medium: number | null;
      hard: number | null;
      composite: string | number;
    }>(this.pool, `
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
        WHERE platform = $1
          AND traffic_source = 'player'
          AND identity_kind = 'github'
          AND github_user_id IS NOT NULL
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
      SELECT
        latest.nickname,
        aggregated_scores.easy,
        aggregated_scores.medium,
        aggregated_scores.hard,
        COALESCE(aggregated_scores.easy, 0) +
        COALESCE(aggregated_scores.medium, 0) +
        COALESCE(aggregated_scores.hard, 0) AS composite
      FROM aggregated_scores
      INNER JOIN github_entries AS latest
        ON latest.github_user_id = aggregated_scores.github_user_id
       AND latest.nickname_rank = 1
      ORDER BY composite DESC
      LIMIT $2
    `, [platform, MAX_HALL_OF_FAME]);

    return result.rows.map((r) => ({
      nickname: r.nickname,
      platform,
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
    const trafficSource = entry.trafficSource ?? "player";

    // The conflict target restates the partial index's predicate. Without
    // `WHERE github_user_id IS NOT NULL` Postgres cannot infer
    // ux_leaderboard_entries_github_platform_difficulty_traffic and raises
    // "no unique or exclusion constraint matching the ON CONFLICT
    // specification" -- at runtime, not at deploy time.
    await pgQuery(this.pool, `
      INSERT INTO leaderboard_entries (
        id, nickname, platform, difficulty, score_efficiency, score_safety,
        score_documentation, score_accuracy, score_total,
        grade, command_count, duration_ms, scenario_title,
        traffic_source, identity_kind, github_user_id, github_login
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      ON CONFLICT (github_user_id, platform, difficulty, traffic_source)
        WHERE github_user_id IS NOT NULL
      DO UPDATE SET
        id = EXCLUDED.id,
        nickname = EXCLUDED.nickname,
        platform = EXCLUDED.platform,
        score_efficiency = EXCLUDED.score_efficiency,
        score_safety = EXCLUDED.score_safety,
        score_documentation = EXCLUDED.score_documentation,
        score_accuracy = EXCLUDED.score_accuracy,
        score_total = EXCLUDED.score_total,
        grade = EXCLUDED.grade,
        command_count = EXCLUDED.command_count,
        duration_ms = EXCLUDED.duration_ms,
        scenario_title = EXCLUDED.scenario_title,
        traffic_source = EXCLUDED.traffic_source,
        identity_kind = EXCLUDED.identity_kind,
        github_user_id = EXCLUDED.github_user_id,
        github_login = EXCLUDED.github_login,
        created_at = now()
      WHERE EXCLUDED.score_total > leaderboard_entries.score_total
         OR (EXCLUDED.score_total = leaderboard_entries.score_total
             AND EXCLUDED.duration_ms < leaderboard_entries.duration_ms)
    `, [
      entry.id,
      entry.nickname,
      entry.platform,
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
      trafficSource,
      entry.identityKind,
      entry.githubUserId,
      entry.githubLogin ?? null,
    ]);

    await this.trimPerDifficulty(entry.platform, entry.difficulty, trafficSource);

    return entry;
  }

  private async trimPerDifficulty(
    platform: PlatformId,
    difficulty: Difficulty,
    trafficSource: NonNullable<LeaderboardEntry["trafficSource"]>,
  ): Promise<void> {
    await pgQuery(this.pool, `
      DELETE FROM leaderboard_entries
      WHERE platform = $1
        AND difficulty = $2
        AND traffic_source = $3
        AND id NOT IN (
          SELECT id FROM leaderboard_entries
          WHERE platform = $1
            AND difficulty = $2
            AND traffic_source = $3
          ORDER BY score_total DESC, duration_ms ASC
          LIMIT $4
        )
    `, [platform, difficulty, trafficSource, MAX_ENTRIES_PER_DIFFICULTY]);
  }
}
