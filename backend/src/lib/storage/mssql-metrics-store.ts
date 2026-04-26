import type sql from "mssql";
import type { IMetricsStore, GameplayRecord } from "./types";

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
}
