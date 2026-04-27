import type sql from "mssql";
import type { GameplayAnalytics, GameplayDifficultyAnalytics, GameplayScenarioAnalytics } from "../../../../shared/types/gameplay";
import type { IMetricsStore, GameplayRecord } from "./types";

function toRate(part: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((part / total) * 10000) / 100;
}

export class MssqlMetricsStore implements IMetricsStore {
  constructor(private pool: sql.ConnectionPool) {}

  async recordGameplay(data: GameplayRecord): Promise<void> {
    await this.pool.request()
      .input("sessionToken", data.sessionToken ?? null)
      .input("nickname", data.nickname ?? null)
      .input("difficulty", data.difficulty ?? null)
      .input("scenarioTitle", data.scenarioTitle ?? null)
      .input("lifecycleState", data.lifecycleState ?? "completed")
      .input("commandCount", data.commandCount ?? data.commandsExecuted?.length ?? 0)
      .input("commandsExecuted", JSON.stringify(data.commandsExecuted ?? []))
      .input("scoringEvents", JSON.stringify(data.scoringEvents ?? []))
      .input("chatMessageCount", data.chatMessageCount ?? 0)
      .input("aiPromptTokens", data.aiPromptTokens ?? 0)
      .input("aiCompletionTokens", data.aiCompletionTokens ?? 0)
      .input("durationMs", data.durationMs ?? null)
      .input("scoreTotal", data.scoreTotal ?? null)
      .input("grade", data.grade ?? null)
      .input("completed", data.completed ?? false)
      .input("metadata", JSON.stringify(data.metadata ?? {}))
      .query(`
        INSERT INTO gameplay_metrics
          (session_token, nickname, difficulty, scenario_title, lifecycle_state,
           command_count,
           commands_executed, scoring_events, chat_message_count,
           ai_prompt_tokens, ai_completion_tokens, duration_ms, score_total, grade,
           completed, metadata)
        VALUES (@sessionToken, @nickname, @difficulty, @scenarioTitle, @lifecycleState,
                @commandCount, @commandsExecuted, @scoringEvents, @chatMessageCount,
                @aiPromptTokens, @aiCompletionTokens, @durationMs,
                @scoreTotal, @grade, @completed, @metadata)
      `);
  }

  async getPlayerHistory(nickname: string): Promise<GameplayRecord[]> {
    const result = await this.pool.request()
      .input("nickname", nickname)
      .query<{
        id: string;
        session_token: string | null;
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
        SELECT TOP 100 * FROM gameplay_metrics
        WHERE nickname = @nickname
        ORDER BY created_at DESC
      `);

    return result.recordset.map((r) => ({
      id: r.id,
      sessionToken: r.session_token ?? undefined,
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

  async getGameplayAnalytics(): Promise<GameplayAnalytics> {
    const latestSessionCte = `
      WITH latest AS (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(CAST(session_token AS NVARCHAR(36)), CAST(id AS NVARCHAR(36)))
            ORDER BY created_at DESC, id DESC
          ) AS rn
        FROM gameplay_metrics
      )
    `;

    const summaryResult = await this.pool.request().query<{
      total_sessions: number;
      completed_sessions: number;
      abandoned_sessions: number;
      in_progress_sessions: number;
      avg_completion_duration_ms: number | null;
      avg_completion_command_count: number | null;
      avg_completion_chat_message_count: number | null;
      avg_completion_score_total: number | null;
    }>(`
      ${latestSessionCte}
      SELECT
        COUNT(*) AS total_sessions,
        SUM(CASE WHEN lifecycle_state = 'completed' THEN 1 ELSE 0 END) AS completed_sessions,
        SUM(CASE WHEN lifecycle_state = 'abandoned' THEN 1 ELSE 0 END) AS abandoned_sessions,
        SUM(CASE WHEN lifecycle_state = 'started' THEN 1 ELSE 0 END) AS in_progress_sessions,
        AVG(CASE WHEN lifecycle_state = 'completed' THEN TRY_CAST(duration_ms AS FLOAT) END) AS avg_completion_duration_ms,
        AVG(CASE WHEN lifecycle_state = 'completed' THEN TRY_CAST(command_count AS FLOAT) END) AS avg_completion_command_count,
        AVG(CASE WHEN lifecycle_state = 'completed' THEN TRY_CAST(chat_message_count AS FLOAT) END) AS avg_completion_chat_message_count,
        AVG(CASE WHEN lifecycle_state = 'completed' THEN TRY_CAST(score_total AS FLOAT) END) AS avg_completion_score_total
      FROM latest
      WHERE rn = 1
    `);

    const difficultyResult = await this.pool.request().query<{
      difficulty: string;
      total_sessions: number;
      completed_sessions: number;
      abandoned_sessions: number;
      in_progress_sessions: number;
    }>(`
      ${latestSessionCte}
      SELECT
        difficulty,
        COUNT(*) AS total_sessions,
        SUM(CASE WHEN lifecycle_state = 'completed' THEN 1 ELSE 0 END) AS completed_sessions,
        SUM(CASE WHEN lifecycle_state = 'abandoned' THEN 1 ELSE 0 END) AS abandoned_sessions,
        SUM(CASE WHEN lifecycle_state = 'started' THEN 1 ELSE 0 END) AS in_progress_sessions
      FROM latest
      WHERE rn = 1
        AND difficulty IS NOT NULL
      GROUP BY difficulty
      ORDER BY difficulty
    `);

    const scenarioResult = await this.pool.request().query<{
      scenario_title: string;
      difficulty: string | null;
      total_sessions: number;
      completed_sessions: number;
      abandoned_sessions: number;
      in_progress_sessions: number;
    }>(`
      ${latestSessionCte}
      SELECT TOP 10
        scenario_title,
        difficulty,
        COUNT(*) AS total_sessions,
        SUM(CASE WHEN lifecycle_state = 'completed' THEN 1 ELSE 0 END) AS completed_sessions,
        SUM(CASE WHEN lifecycle_state = 'abandoned' THEN 1 ELSE 0 END) AS abandoned_sessions,
        SUM(CASE WHEN lifecycle_state = 'started' THEN 1 ELSE 0 END) AS in_progress_sessions
      FROM latest
      WHERE rn = 1
        AND scenario_title IS NOT NULL
      GROUP BY scenario_title, difficulty
      ORDER BY total_sessions DESC, scenario_title ASC
    `);

    const recentResult = await this.pool.request().query<{
      session_token: string | null;
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
    }>(`
      ${latestSessionCte}
      SELECT TOP 20
        session_token,
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
      WHERE rn = 1
      ORDER BY created_at DESC
    `);

    const summary = summaryResult.recordset[0] ?? {
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
        completedSessions: summary.completed_sessions,
        abandonedSessions: summary.abandoned_sessions,
        inProgressSessions: summary.in_progress_sessions,
        completionRate: toRate(summary.completed_sessions, summary.total_sessions),
        abandonmentRate: toRate(summary.abandoned_sessions, summary.total_sessions),
        avgCompletionDurationMs: summary.avg_completion_duration_ms,
        avgCompletionCommandCount: summary.avg_completion_command_count,
        avgCompletionChatMessageCount: summary.avg_completion_chat_message_count,
        avgCompletionScoreTotal: summary.avg_completion_score_total,
      },
      byDifficulty: difficultyResult.recordset.map((row): GameplayDifficultyAnalytics => ({
        difficulty: row.difficulty as GameplayDifficultyAnalytics["difficulty"],
        totalSessions: row.total_sessions,
        completedSessions: row.completed_sessions,
        abandonedSessions: row.abandoned_sessions,
        inProgressSessions: row.in_progress_sessions,
        completionRate: toRate(row.completed_sessions, row.total_sessions),
      })),
      byScenario: scenarioResult.recordset.map((row): GameplayScenarioAnalytics => ({
        scenarioTitle: row.scenario_title,
        difficulty: (row.difficulty ?? undefined) as GameplayScenarioAnalytics["difficulty"],
        totalSessions: row.total_sessions,
        completedSessions: row.completed_sessions,
        abandonedSessions: row.abandoned_sessions,
        inProgressSessions: row.in_progress_sessions,
        completionRate: toRate(row.completed_sessions, row.total_sessions),
      })),
      recentSessions: recentResult.recordset.map((row) => ({
        sessionToken: row.session_token ?? undefined,
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
