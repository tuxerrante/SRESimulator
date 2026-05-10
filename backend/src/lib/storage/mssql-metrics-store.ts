import type sql from "mssql";
import type {
  GameplayAnalytics,
  GameplayDifficultyAnalytics,
  GameplayScenarioAnalytics,
} from "../../../../shared/types/gameplay";
import type { IMetricsStore, GameplayRecord } from "./types";

const DUPLICATE_LIFECYCLE_INDEX = "ux_gameplay_metrics_session_lifecycle";

function isDuplicateLifecycleEventError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const number = (error as { number?: unknown }).number;
  const message = (error as { message?: unknown }).message;

  return (
    (number === 2601 || number === 2627) &&
    typeof message === "string" &&
    message.toLowerCase().includes(DUPLICATE_LIFECYCLE_INDEX)
  );
}

function toRate(part: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((part / total) * 10000) / 100;
}

export class MssqlMetricsStore implements IMetricsStore {
  constructor(private pool: sql.ConnectionPool) {}

  async recordGameplay(data: GameplayRecord): Promise<void> {
    const lifecycleState = data.lifecycleState ?? "completed";

    try {
      await this.pool.request()
        .input("sessionToken", data.sessionToken ?? null)
        .input("trafficSource", data.trafficSource ?? "player")
        .input("nickname", data.nickname ?? null)
        .input("difficulty", data.difficulty ?? null)
        .input("scenarioTitle", data.scenarioTitle ?? null)
        .input("lifecycleState", lifecycleState)
        .input("commandCount", data.commandCount ?? data.commandsExecuted?.length ?? 0)
        .input("commandsExecuted", JSON.stringify(data.commandsExecuted ?? []))
        .input("scoringEvents", JSON.stringify(data.scoringEvents ?? []))
        .input("chatMessageCount", data.chatMessageCount ?? 0)
        .input("aiPromptTokens", data.aiPromptTokens ?? 0)
        .input("aiCompletionTokens", data.aiCompletionTokens ?? 0)
        .input("durationMs", data.durationMs ?? null)
        .input("scoreTotal", data.scoreTotal ?? null)
        .input("grade", data.grade ?? null)
        .input("completed", data.completed ?? lifecycleState === "completed")
        .input("metadata", JSON.stringify(data.metadata ?? {}))
        .query(`
          INSERT INTO gameplay_metrics
            (session_token, traffic_source, nickname, difficulty, scenario_title, lifecycle_state,
             command_count,
             commands_executed, scoring_events, chat_message_count,
             ai_prompt_tokens, ai_completion_tokens, duration_ms, score_total, grade,
             completed, metadata)
          VALUES (@sessionToken, @trafficSource, @nickname, @difficulty, @scenarioTitle, @lifecycleState,
                  @commandCount, @commandsExecuted, @scoringEvents, @chatMessageCount,
                  @aiPromptTokens, @aiCompletionTokens, @durationMs,
                  @scoreTotal, @grade, @completed, @metadata)
        `);
    } catch (error) {
      if (isDuplicateLifecycleEventError(error)) {
        return;
      }
      throw error;
    }
  }

  async getPlayerHistory(nickname: string): Promise<GameplayRecord[]> {
    const result = await this.pool.request()
      .input("nickname", nickname)
      .query<{
        id: string;
        session_token: string | null;
        traffic_source: "player" | "automated" | null;
        nickname: string | null;
        difficulty: string | null;
        scenario_title: string | null;
        lifecycle_state: string | null;
        command_count: number;
        commands_executed: string;
        scoring_events: string;
        chat_message_count: number;
        ai_prompt_tokens: number;
        ai_completion_tokens: number;
        duration_ms: number | null;
        score_total: number | null;
        grade: string | null;
        completed: boolean;
        metadata: string;
        created_at: Date;
      }>(`
        SELECT TOP 100
          id,
          session_token,
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
        FROM gameplay_metrics
        WHERE nickname = @nickname
        ORDER BY created_at DESC
      `);

    return result.recordset.map((r) => ({
      id: r.id,
      sessionToken: r.session_token ?? undefined,
      trafficSource: r.traffic_source ?? undefined,
      nickname: r.nickname ?? undefined,
      difficulty: (r.difficulty ?? undefined) as GameplayRecord["difficulty"],
      scenarioTitle: r.scenario_title ?? undefined,
      lifecycleState: (r.lifecycle_state ?? undefined) as GameplayRecord["lifecycleState"],
      commandCount: r.command_count,
      commandsExecuted: JSON.parse(r.commands_executed || "[]") as string[],
      scoringEvents: JSON.parse(r.scoring_events || "[]") as unknown[],
      chatMessageCount: r.chat_message_count,
      aiPromptTokens: r.ai_prompt_tokens,
      aiCompletionTokens: r.ai_completion_tokens,
      durationMs: r.duration_ms != null ? Number(r.duration_ms) : undefined,
      scoreTotal: r.score_total != null ? Number(r.score_total) : undefined,
      grade: r.grade ?? undefined,
      completed: r.completed,
      metadata: JSON.parse(r.metadata || "{}") as Record<string, unknown>,
      createdAt: r.created_at,
    }));
  }

  async hasLifecycleEvent(sessionToken: string, lifecycleState: GameplayRecord["lifecycleState"]): Promise<boolean> {
    const result = await this.pool.request()
      .input("sessionToken", sessionToken)
      .input("lifecycleState", lifecycleState)
      .query<{ matched: number }>(`
        SELECT TOP 1 1 AS matched
        FROM gameplay_metrics
        WHERE session_token = @sessionToken
          AND lifecycle_state = @lifecycleState
      `);

    return result.recordset.length > 0;
  }

  async getLatestBySessionToken(sessionToken: string): Promise<GameplayRecord | null> {
    const result = await this.pool.request()
      .input("sessionToken", sessionToken)
      .query<{
        id: string;
        session_token: string | null;
        traffic_source: "player" | "automated" | null;
        nickname: string | null;
        difficulty: string | null;
        scenario_title: string | null;
        lifecycle_state: string | null;
        command_count: number;
        commands_executed: string;
        scoring_events: string;
        chat_message_count: number;
        ai_prompt_tokens: number;
        ai_completion_tokens: number;
        duration_ms: number | null;
        score_total: number | null;
        grade: string | null;
        completed: boolean;
        metadata: string;
        created_at: Date;
      }>(`
        SELECT TOP 1
          id,
          session_token,
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
        FROM gameplay_metrics
        WHERE session_token = @sessionToken
        ORDER BY created_at DESC, id DESC
      `);

    const row = result.recordset[0];
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      sessionToken: row.session_token ?? undefined,
      trafficSource: row.traffic_source ?? undefined,
      nickname: row.nickname ?? undefined,
      difficulty: (row.difficulty ?? undefined) as GameplayRecord["difficulty"],
      scenarioTitle: row.scenario_title ?? undefined,
      lifecycleState: (row.lifecycle_state ?? undefined) as GameplayRecord["lifecycleState"],
      commandCount: row.command_count,
      commandsExecuted: JSON.parse(row.commands_executed || "[]") as string[],
      scoringEvents: JSON.parse(row.scoring_events || "[]") as unknown[],
      chatMessageCount: row.chat_message_count,
      aiPromptTokens: row.ai_prompt_tokens,
      aiCompletionTokens: row.ai_completion_tokens,
      durationMs: row.duration_ms != null ? Number(row.duration_ms) : undefined,
      scoreTotal: row.score_total != null ? Number(row.score_total) : undefined,
      grade: row.grade ?? undefined,
      completed: row.completed,
      metadata: JSON.parse(row.metadata || "{}") as Record<string, unknown>,
      createdAt: row.created_at,
    };
  }

  async getGameplayAnalytics(): Promise<GameplayAnalytics> {
    type SummaryRow = {
      total_sessions: number;
      completed_sessions: number;
      abandoned_sessions: number;
      in_progress_sessions: number;
      avg_completion_duration_ms: number | null;
      avg_completion_command_count: number | null;
      avg_completion_chat_message_count: number | null;
      avg_completion_score_total: number | null;
    };
    type DifficultyRow = {
      difficulty: string;
      total_sessions: number;
      completed_sessions: number;
      abandoned_sessions: number;
      in_progress_sessions: number;
    };
    type ScenarioRow = {
      scenario_title: string;
      difficulty: string | null;
      total_sessions: number;
      completed_sessions: number;
      abandoned_sessions: number;
      in_progress_sessions: number;
    };
    type RecentRow = {
      lifecycle_state: string | null;
      nickname: string | null;
      difficulty: string | null;
      scenario_title: string | null;
      command_count: number;
      chat_message_count: number;
      duration_ms: number | null;
      score_total: number | null;
      grade: string | null;
      created_at: Date;
    };

    const latestSessionCte = `
      WITH ranked_sessions AS (
        SELECT
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
      ),
      latest AS (
        SELECT
          lifecycle_state,
          nickname,
          difficulty,
          scenario_title,
          command_count,
          chat_message_count,
          duration_ms,
          score_total,
          grade,
          created_at
        FROM ranked_sessions
        WHERE rn = 1
        UNION ALL
        SELECT
          lifecycle_state,
          nickname,
          difficulty,
          scenario_title,
          command_count,
          chat_message_count,
          duration_ms,
          score_total,
          grade,
          created_at
        FROM gameplay_metrics
        WHERE traffic_source = 'player'
          AND session_token IS NULL
      )
    `;

    const analyticsResult = await this.pool.request().query<SummaryRow>(`
      ${latestSessionCte}
      CREATE TABLE #latest_sessions (
        lifecycle_state VARCHAR(16) NULL,
        nickname NVARCHAR(20) NULL,
        difficulty VARCHAR(10) NULL,
        scenario_title NVARCHAR(255) NULL,
        command_count INT NULL,
        chat_message_count INT NULL,
        duration_ms BIGINT NULL,
        score_total INT NULL,
        grade VARCHAR(5) NULL,
        created_at DATETIMEOFFSET NOT NULL
      );

      INSERT INTO #latest_sessions (
        lifecycle_state,
        nickname,
        difficulty,
        scenario_title,
        command_count,
        chat_message_count,
        duration_ms,
        score_total,
        grade,
        created_at
      )
      SELECT
        lifecycle_state,
        nickname,
        difficulty,
        scenario_title,
        command_count,
        chat_message_count,
        duration_ms,
        score_total,
        grade,
        created_at
      FROM latest
      ;

      SELECT
        COUNT(*) AS total_sessions,
        COALESCE(SUM(CASE WHEN lifecycle_state = 'completed' THEN 1 ELSE 0 END), 0) AS completed_sessions,
        COALESCE(SUM(CASE WHEN lifecycle_state = 'abandoned' THEN 1 ELSE 0 END), 0) AS abandoned_sessions,
        COALESCE(SUM(CASE WHEN lifecycle_state = 'started' THEN 1 ELSE 0 END), 0) AS in_progress_sessions,
        AVG(CASE WHEN lifecycle_state = 'completed' THEN TRY_CAST(duration_ms AS FLOAT) END) AS avg_completion_duration_ms,
        AVG(CASE WHEN lifecycle_state = 'completed' THEN TRY_CAST(command_count AS FLOAT) END) AS avg_completion_command_count,
        AVG(CASE WHEN lifecycle_state = 'completed' THEN TRY_CAST(chat_message_count AS FLOAT) END) AS avg_completion_chat_message_count,
        AVG(CASE WHEN lifecycle_state = 'completed' THEN TRY_CAST(score_total AS FLOAT) END) AS avg_completion_score_total
      FROM #latest_sessions;

      SELECT
        difficulty,
        COUNT(*) AS total_sessions,
        SUM(CASE WHEN lifecycle_state = 'completed' THEN 1 ELSE 0 END) AS completed_sessions,
        SUM(CASE WHEN lifecycle_state = 'abandoned' THEN 1 ELSE 0 END) AS abandoned_sessions,
        SUM(CASE WHEN lifecycle_state = 'started' THEN 1 ELSE 0 END) AS in_progress_sessions
      FROM #latest_sessions
      WHERE difficulty IS NOT NULL
      GROUP BY difficulty
      ORDER BY difficulty;

      SELECT TOP 10
        scenario_title,
        difficulty,
        COUNT(*) AS total_sessions,
        SUM(CASE WHEN lifecycle_state = 'completed' THEN 1 ELSE 0 END) AS completed_sessions,
        SUM(CASE WHEN lifecycle_state = 'abandoned' THEN 1 ELSE 0 END) AS abandoned_sessions,
        SUM(CASE WHEN lifecycle_state = 'started' THEN 1 ELSE 0 END) AS in_progress_sessions
      FROM #latest_sessions
      WHERE scenario_title IS NOT NULL
      GROUP BY scenario_title, difficulty
      ORDER BY total_sessions DESC, scenario_title ASC;

      SELECT TOP 20
        lifecycle_state,
        nickname,
        difficulty,
        scenario_title,
        command_count,
        COALESCE(chat_message_count, 0) AS chat_message_count,
        duration_ms,
        score_total,
        grade,
        created_at
      FROM #latest_sessions
      ORDER BY created_at DESC;

      DROP TABLE #latest_sessions;
    `);

    const recordsets = analyticsResult.recordsets as unknown[];
    const summaryRows = (recordsets[0] as SummaryRow[] | undefined) ?? analyticsResult.recordset;
    const difficultyRows = (recordsets[1] as DifficultyRow[] | undefined) ?? [];
    const scenarioRows = (recordsets[2] as ScenarioRow[] | undefined) ?? [];
    const recentRows = (recordsets[3] as RecentRow[] | undefined) ?? [];
    const summary = summaryRows[0] ?? {
      total_sessions: 0,
      completed_sessions: 0,
      abandoned_sessions: 0,
      in_progress_sessions: 0,
      avg_completion_duration_ms: null,
      avg_completion_command_count: null,
      avg_completion_chat_message_count: null,
      avg_completion_score_total: null,
    };

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
      byDifficulty: (difficultyRows ?? []).map((row): GameplayDifficultyAnalytics => ({
        difficulty: row.difficulty as GameplayDifficultyAnalytics["difficulty"],
        totalSessions: row.total_sessions,
        completedSessions: row.completed_sessions,
        abandonedSessions: row.abandoned_sessions,
        inProgressSessions: row.in_progress_sessions,
        completionRate: toRate(row.completed_sessions, row.total_sessions),
      })),
      byScenario: (scenarioRows ?? []).map((row): GameplayScenarioAnalytics => ({
        scenarioTitle: row.scenario_title,
        difficulty: (row.difficulty ?? undefined) as GameplayScenarioAnalytics["difficulty"],
        totalSessions: row.total_sessions,
        completedSessions: row.completed_sessions,
        abandonedSessions: row.abandoned_sessions,
        inProgressSessions: row.in_progress_sessions,
        completionRate: toRate(row.completed_sessions, row.total_sessions),
      })),
      recentSessions: (recentRows ?? []).map((row) => ({
        lifecycleState: (row.lifecycle_state ?? "completed") as "started" | "completed" | "abandoned",
        nickname: row.nickname ?? undefined,
        difficulty: (row.difficulty ?? undefined) as GameplayRecord["difficulty"],
        scenarioTitle: row.scenario_title ?? undefined,
        commandCount: row.command_count,
        chatMessageCount: row.chat_message_count,
        durationMs: row.duration_ms != null ? Number(row.duration_ms) : undefined,
        scoreTotal: row.score_total != null ? Number(row.score_total) : undefined,
        grade: row.grade ?? undefined,
        createdAt: row.created_at.toISOString(),
      })),
    };
  }
}
