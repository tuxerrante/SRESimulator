import type {
  GameplayAnalytics,
  GameplayDifficultyAnalytics,
  GameplayLifecycleState,
  GameplayPlatformAnalytics,
  GameplayScenarioAnalytics,
  RecentGameplaySession,
} from "../../../../shared/types/gameplay";
import { pgQuery, type PgQueryable } from "./pg-pool";
import type { GameplayAnalyticsFilters, IMetricsStore, GameplayRecord } from "./types";

const DUPLICATE_LIFECYCLE_INDEX = "ux_gameplay_metrics_session_lifecycle";

/** SQLSTATE 23505 is unique_violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * Postgres names the offending constraint in `error.constraint`, so unlike the
 * MSSQL classifier this needs no substring match against the message text.
 */
function isDuplicateLifecycleEventError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  const constraint = (error as { constraint?: unknown }).constraint;

  return code === UNIQUE_VIOLATION && constraint === DUPLICATE_LIFECYCLE_INDEX;
}

function toRate(part: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((part / total) * 10000) / 100;
}

/**
 * `jsonb` columns come back from `pg` already parsed, where `mssql` hands back
 * the raw string. Both shapes funnel through here so the store's callers see
 * the same value either way.
 */
function asJsonValue<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

interface GameplayRow {
  id: string;
  session_token: string | null;
  platform: "aro-classic" | "aro-hcp" | "aks" | null;
  traffic_source: "player" | "automated" | null;
  nickname: string | null;
  difficulty: string | null;
  scenario_title: string | null;
  lifecycle_state: string | null;
  command_count: number;
  commands_executed: unknown;
  scoring_events: unknown;
  chat_message_count: number;
  ai_prompt_tokens: number;
  ai_completion_tokens: number;
  duration_ms: string | number | null;
  score_total: number | null;
  grade: string | null;
  completed: boolean;
  metadata: unknown;
  created_at: Date;
}

const GAMEPLAY_COLUMNS = `
  id,
  session_token,
  platform,
  traffic_source,
  nickname,
  difficulty,
  scenario_title,
  lifecycle_state,
  command_count,
  commands_executed,
  scoring_events,
  COALESCE(chat_message_count, 0) AS chat_message_count,
  ai_prompt_tokens,
  ai_completion_tokens,
  duration_ms,
  score_total,
  grade,
  completed,
  metadata,
  created_at
`;

function mapGameplayRow(row: GameplayRow): GameplayRecord {
  return {
    id: row.id,
    sessionToken: row.session_token ?? undefined,
    platform: row.platform ?? undefined,
    trafficSource: row.traffic_source ?? undefined,
    nickname: row.nickname ?? undefined,
    difficulty: (row.difficulty ?? undefined) as GameplayRecord["difficulty"],
    scenarioTitle: row.scenario_title ?? undefined,
    lifecycleState: (row.lifecycle_state ?? undefined) as GameplayRecord["lifecycleState"],
    commandCount: row.command_count,
    commandsExecuted: asJsonValue<string[]>(row.commands_executed, []),
    scoringEvents: asJsonValue<unknown[]>(row.scoring_events, []),
    chatMessageCount: row.chat_message_count,
    aiPromptTokens: row.ai_prompt_tokens,
    aiCompletionTokens: row.ai_completion_tokens,
    durationMs: row.duration_ms != null ? Number(row.duration_ms) : undefined,
    scoreTotal: row.score_total != null ? Number(row.score_total) : undefined,
    grade: row.grade ?? undefined,
    completed: row.completed,
    metadata: asJsonValue<Record<string, unknown>>(row.metadata, {}),
    createdAt: row.created_at,
  };
}

interface AnalyticsSummaryRow {
  total_sessions: number;
  completed_sessions: number;
  abandoned_sessions: number;
  in_progress_sessions: number;
  avg_completion_duration_ms: number | null;
  avg_completion_command_count: number | null;
  avg_completion_chat_message_count: number | null;
  avg_completion_score_total: number | null;
}

interface AnalyticsGroupRow {
  platform: string | null;
  difficulty: string | null;
  scenario_title: string;
  total_sessions: number;
  completed_sessions: number;
  abandoned_sessions: number;
  in_progress_sessions: number;
}

interface AnalyticsRecentRow {
  platform: string | null;
  lifecycle_state: string | null;
  nickname: string | null;
  difficulty: string | null;
  scenario_title: string | null;
  command_count: number;
  chat_message_count: number;
  duration_ms: number | null;
  score_total: number | null;
  grade: string | null;
  created_at: string;
}

interface AnalyticsPayload {
  summary: AnalyticsSummaryRow | null;
  by_platform: AnalyticsGroupRow[];
  by_difficulty: AnalyticsGroupRow[];
  by_scenario: AnalyticsGroupRow[];
  recent_sessions: AnalyticsRecentRow[];
}

const EMPTY_SUMMARY: AnalyticsSummaryRow = {
  total_sessions: 0,
  completed_sessions: 0,
  abandoned_sessions: 0,
  in_progress_sessions: 0,
  avg_completion_duration_ms: null,
  avg_completion_command_count: null,
  avg_completion_chat_message_count: null,
  avg_completion_score_total: null,
};

export class PgMetricsStore implements IMetricsStore {
  constructor(private pool: PgQueryable) {}

  async recordGameplay(data: GameplayRecord): Promise<void> {
    const lifecycleState = data.lifecycleState ?? "completed";

    try {
      await pgQuery(this.pool, `
        INSERT INTO gameplay_metrics
          (session_token, platform, traffic_source, nickname, difficulty, scenario_title, lifecycle_state,
           command_count,
           commands_executed, scoring_events, chat_message_count,
           ai_prompt_tokens, ai_completion_tokens, duration_ms, score_total, grade,
           completed, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7,
                $8, $9, $10, $11,
                $12, $13, $14, $15, $16,
                $17, $18)
      `, [
        data.sessionToken ?? null,
        data.platform ?? "aro-classic",
        data.trafficSource ?? "player",
        data.nickname ?? null,
        data.difficulty ?? null,
        data.scenarioTitle ?? null,
        lifecycleState,
        data.commandCount ?? data.commandsExecuted?.length ?? 0,
        JSON.stringify(data.commandsExecuted ?? []),
        JSON.stringify(data.scoringEvents ?? []),
        data.chatMessageCount ?? 0,
        data.aiPromptTokens ?? 0,
        data.aiCompletionTokens ?? 0,
        data.durationMs ?? null,
        data.scoreTotal ?? null,
        data.grade ?? null,
        data.completed ?? lifecycleState === "completed",
        JSON.stringify(data.metadata ?? {}),
      ]);
    } catch (error) {
      if (isDuplicateLifecycleEventError(error)) {
        return;
      }
      throw error;
    }
  }

  async getPlayerHistory(nickname: string): Promise<GameplayRecord[]> {
    const result = await pgQuery<GameplayRow>(this.pool, `
      SELECT ${GAMEPLAY_COLUMNS}
      FROM gameplay_metrics
      WHERE nickname = $1
      ORDER BY created_at DESC
      LIMIT 100
    `, [nickname]);

    return result.rows.map(mapGameplayRow);
  }

  async hasLifecycleEvent(
    sessionToken: string,
    lifecycleState: GameplayLifecycleState,
  ): Promise<boolean> {
    const result = await pgQuery<{ matched: number }>(this.pool, `
      SELECT 1 AS matched
      FROM gameplay_metrics
      WHERE session_token = $1
        AND lifecycle_state = $2
      LIMIT 1
    `, [sessionToken, lifecycleState]);

    return result.rows.length > 0;
  }

  async getLatestBySessionToken(sessionToken: string): Promise<GameplayRecord | null> {
    const result = await pgQuery<GameplayRow>(this.pool, `
      SELECT ${GAMEPLAY_COLUMNS}
      FROM gameplay_metrics
      WHERE session_token = $1
      ORDER BY
        CASE WHEN lifecycle_state IN ('completed', 'abandoned') THEN 1 ELSE 0 END DESC,
        created_at DESC,
        id DESC
      LIMIT 1
    `, [sessionToken]);

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return mapGameplayRow(row);
  }

  async getLatestCompletedBySessionToken(sessionToken: string): Promise<GameplayRecord | null> {
    const result = await pgQuery<GameplayRow>(this.pool, `
      SELECT ${GAMEPLAY_COLUMNS}
      FROM gameplay_metrics
      WHERE session_token = $1
        AND lifecycle_state = 'completed'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `, [sessionToken]);

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return mapGameplayRow(row);
  }

  /**
   * The MSSQL original materialises a `#latest_sessions` temp table and then
   * returns five resultsets from one batch. Neither half survives here:
   * Postgres has no multi-resultset wire protocol, and a temp table does not
   * outlive the transaction it was created in under PgBouncer's transaction
   * pooling.
   *
   * So the temp table becomes a CTE and the five resultsets become one
   * `json_build_object` row. That also collapses five round trips into one,
   * which is worth having against Neon's latency.
   *
   * `created_at` is rendered with `to_char` rather than left to the JSON
   * serializer: this must be byte-identical to the MSSQL path's
   * `Date.toISOString()`, and Postgres' own timestamptz JSON rendering is not.
   */
  async getGameplayAnalytics(
    filters?: GameplayAnalyticsFilters,
  ): Promise<GameplayAnalytics> {
    const result = await pgQuery<{ analytics: AnalyticsPayload }>(this.pool, `
      WITH ranked_sessions AS (
        SELECT
          platform,
          lifecycle_state,
          nickname,
          difficulty,
          scenario_title,
          command_count,
          chat_message_count,
          duration_ms,
          score_total,
          grade,
          created_at,
          ROW_NUMBER() OVER (
            PARTITION BY session_token
            ORDER BY
              CASE WHEN lifecycle_state IN ('completed', 'abandoned') THEN 1 ELSE 0 END DESC,
              created_at DESC,
              id DESC
          ) AS rn
        FROM gameplay_metrics
        WHERE traffic_source = 'player'
          AND session_token IS NOT NULL
          AND ($1::text IS NULL OR platform = $1)
      ),
      latest AS (
        SELECT
          platform, lifecycle_state, nickname, difficulty, scenario_title,
          command_count, chat_message_count, duration_ms, score_total, grade, created_at
        FROM ranked_sessions
        WHERE rn = 1
        UNION ALL
        SELECT
          platform, lifecycle_state, nickname, difficulty, scenario_title,
          command_count, chat_message_count, duration_ms, score_total, grade, created_at
        FROM gameplay_metrics
        WHERE traffic_source = 'player'
          AND session_token IS NULL
          AND ($1::text IS NULL OR platform = $1)
      ),
      summary AS (
        SELECT
          COUNT(*) AS total_sessions,
          COALESCE(SUM(CASE WHEN lifecycle_state = 'completed' THEN 1 ELSE 0 END), 0) AS completed_sessions,
          COALESCE(SUM(CASE WHEN lifecycle_state = 'abandoned' THEN 1 ELSE 0 END), 0) AS abandoned_sessions,
          COALESCE(SUM(CASE WHEN lifecycle_state = 'started' THEN 1 ELSE 0 END), 0) AS in_progress_sessions,
          AVG(CASE WHEN lifecycle_state = 'completed' THEN duration_ms::double precision END) AS avg_completion_duration_ms,
          AVG(CASE WHEN lifecycle_state = 'completed' THEN command_count::double precision END) AS avg_completion_command_count,
          AVG(CASE WHEN lifecycle_state = 'completed' THEN chat_message_count::double precision END) AS avg_completion_chat_message_count,
          AVG(CASE WHEN lifecycle_state = 'completed' THEN score_total::double precision END) AS avg_completion_score_total
        FROM latest
      ),
      by_platform AS (
        SELECT
          platform,
          COUNT(*) AS total_sessions,
          SUM(CASE WHEN lifecycle_state = 'completed' THEN 1 ELSE 0 END) AS completed_sessions,
          SUM(CASE WHEN lifecycle_state = 'abandoned' THEN 1 ELSE 0 END) AS abandoned_sessions,
          SUM(CASE WHEN lifecycle_state = 'started' THEN 1 ELSE 0 END) AS in_progress_sessions
        FROM latest
        WHERE platform IS NOT NULL
        GROUP BY platform
      ),
      by_difficulty AS (
        SELECT
          difficulty,
          COUNT(*) AS total_sessions,
          SUM(CASE WHEN lifecycle_state = 'completed' THEN 1 ELSE 0 END) AS completed_sessions,
          SUM(CASE WHEN lifecycle_state = 'abandoned' THEN 1 ELSE 0 END) AS abandoned_sessions,
          SUM(CASE WHEN lifecycle_state = 'started' THEN 1 ELSE 0 END) AS in_progress_sessions
        FROM latest
        WHERE difficulty IS NOT NULL
        GROUP BY difficulty
      ),
      by_scenario AS (
        SELECT
          platform,
          scenario_title,
          difficulty,
          COUNT(*) AS total_sessions,
          SUM(CASE WHEN lifecycle_state = 'completed' THEN 1 ELSE 0 END) AS completed_sessions,
          SUM(CASE WHEN lifecycle_state = 'abandoned' THEN 1 ELSE 0 END) AS abandoned_sessions,
          SUM(CASE WHEN lifecycle_state = 'started' THEN 1 ELSE 0 END) AS in_progress_sessions
        FROM latest
        WHERE scenario_title IS NOT NULL
        GROUP BY platform, scenario_title, difficulty
        ORDER BY total_sessions DESC, scenario_title ASC, platform ASC
        LIMIT 10
      ),
      recent_sessions AS (
        SELECT
          platform,
          lifecycle_state,
          nickname,
          difficulty,
          scenario_title,
          command_count,
          COALESCE(chat_message_count, 0) AS chat_message_count,
          duration_ms,
          score_total,
          grade,
          created_at,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_iso
        FROM latest
        ORDER BY created_at DESC
        LIMIT 20
      )
      SELECT json_build_object(
        'summary', (SELECT row_to_json(s) FROM summary s),
        'by_platform', COALESCE(
          (SELECT json_agg(row_to_json(p) ORDER BY p.platform ASC) FROM by_platform p), '[]'::json),
        'by_difficulty', COALESCE(
          (SELECT json_agg(row_to_json(d) ORDER BY d.difficulty ASC) FROM by_difficulty d), '[]'::json),
        'by_scenario', COALESCE(
          (SELECT json_agg(row_to_json(sc) ORDER BY sc.total_sessions DESC, sc.scenario_title ASC, sc.platform ASC)
           FROM by_scenario sc), '[]'::json),
        'recent_sessions', COALESCE(
          (SELECT json_agg(json_build_object(
              'platform', r.platform,
              'lifecycle_state', r.lifecycle_state,
              'nickname', r.nickname,
              'difficulty', r.difficulty,
              'scenario_title', r.scenario_title,
              'command_count', r.command_count,
              'chat_message_count', r.chat_message_count,
              'duration_ms', r.duration_ms,
              'score_total', r.score_total,
              'grade', r.grade,
              'created_at', r.created_at_iso
            ) ORDER BY r.created_at DESC)
           FROM recent_sessions r), '[]'::json)
      ) AS analytics
    `, [filters?.platform ?? null]);

    const payload = result.rows[0]?.analytics;
    const summary = payload?.summary ?? EMPTY_SUMMARY;
    const platformRows = payload?.by_platform ?? [];
    const difficultyRows = payload?.by_difficulty ?? [];
    const scenarioRows = payload?.by_scenario ?? [];
    const recentRows = payload?.recent_sessions ?? [];

    return {
      summary: {
        totalSessions: summary.total_sessions,
        completedSessions: summary.completed_sessions ?? 0,
        abandonedSessions: summary.abandoned_sessions ?? 0,
        inProgressSessions: summary.in_progress_sessions ?? 0,
        completionRate: toRate(summary.completed_sessions ?? 0, summary.total_sessions),
        abandonmentRate: toRate(summary.abandoned_sessions ?? 0, summary.total_sessions),
        avgCompletionDurationMs: summary.avg_completion_duration_ms,
        avgCompletionCommandCount: summary.avg_completion_command_count,
        avgCompletionChatMessageCount: summary.avg_completion_chat_message_count,
        avgCompletionScoreTotal: summary.avg_completion_score_total,
      },
      byPlatform: platformRows.map((row): GameplayPlatformAnalytics => ({
        platform: row.platform as GameplayPlatformAnalytics["platform"],
        totalSessions: row.total_sessions,
        completedSessions: row.completed_sessions,
        abandonedSessions: row.abandoned_sessions,
        inProgressSessions: row.in_progress_sessions,
        completionRate: toRate(row.completed_sessions, row.total_sessions),
      })),
      byDifficulty: difficultyRows.map((row): GameplayDifficultyAnalytics => ({
        difficulty: row.difficulty as GameplayDifficultyAnalytics["difficulty"],
        totalSessions: row.total_sessions,
        completedSessions: row.completed_sessions,
        abandonedSessions: row.abandoned_sessions,
        inProgressSessions: row.in_progress_sessions,
        completionRate: toRate(row.completed_sessions, row.total_sessions),
      })),
      byScenario: scenarioRows.map((row): GameplayScenarioAnalytics => ({
        scenarioTitle: row.scenario_title,
        platform: (row.platform ?? undefined) as GameplayScenarioAnalytics["platform"],
        difficulty: (row.difficulty ?? undefined) as GameplayScenarioAnalytics["difficulty"],
        totalSessions: row.total_sessions,
        completedSessions: row.completed_sessions,
        abandonedSessions: row.abandoned_sessions,
        inProgressSessions: row.in_progress_sessions,
        completionRate: toRate(row.completed_sessions, row.total_sessions),
      })),
      recentSessions: recentRows.map((row): RecentGameplaySession => ({
        platform: (row.platform ?? undefined) as GameplayRecord["platform"],
        lifecycleState: (row.lifecycle_state ?? "completed") as GameplayLifecycleState,
        nickname: row.nickname ?? undefined,
        difficulty: (row.difficulty ?? undefined) as GameplayRecord["difficulty"],
        scenarioTitle: row.scenario_title ?? undefined,
        commandCount: row.command_count,
        chatMessageCount: row.chat_message_count,
        durationMs: row.duration_ms != null ? Number(row.duration_ms) : undefined,
        scoreTotal: row.score_total != null ? Number(row.score_total) : undefined,
        grade: row.grade ?? undefined,
        createdAt: row.created_at,
      })),
    };
  }
}
