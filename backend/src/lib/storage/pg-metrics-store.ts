import type { Pool } from "pg";
import type { IMetricsStore, GameplayRecord } from "./types";

export class PgMetricsStore implements IMetricsStore {
  constructor(private pool: Pool) {}

  async recordGameplay(data: GameplayRecord): Promise<void> {
    await this.pool.query(`
      INSERT INTO gameplay_metrics
        (session_token, nickname, difficulty, scenario_title,
         commands_executed, scoring_events, chat_message_count,
         ai_prompt_tokens, ai_completion_tokens, duration_ms,
         completed, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `, [
      data.sessionToken ?? null,
      data.nickname ?? null,
      data.difficulty ?? null,
      data.scenarioTitle ?? null,
      JSON.stringify(data.commandsExecuted ?? []),
      JSON.stringify(data.scoringEvents ?? []),
      data.chatMessageCount ?? 0,
      data.aiPromptTokens ?? 0,
      data.aiCompletionTokens ?? 0,
      data.durationMs ?? null,
      data.completed ?? false,
      JSON.stringify(data.metadata ?? {}),
    ]);
  }

  async getPlayerHistory(nickname: string): Promise<GameplayRecord[]> {
    const { rows } = await this.pool.query<{
      id: string;
      session_token: string | null;
      nickname: string | null;
      difficulty: string | null;
      scenario_title: string | null;
      commands_executed: unknown[];
      scoring_events: unknown[];
      chat_message_count: number;
      ai_prompt_tokens: number;
      ai_completion_tokens: number;
      duration_ms: string | null;
      completed: boolean;
      metadata: Record<string, unknown>;
      created_at: Date;
    }>(`
      SELECT * FROM gameplay_metrics
      WHERE nickname = $1
      ORDER BY created_at DESC
      LIMIT 100
    `, [nickname]);

    return rows.map((r) => ({
      id: r.id,
      sessionToken: r.session_token ?? undefined,
      nickname: r.nickname ?? undefined,
      difficulty: r.difficulty as GameplayRecord["difficulty"],
      scenarioTitle: r.scenario_title ?? undefined,
      commandsExecuted: r.commands_executed as string[],
      scoringEvents: r.scoring_events,
      chatMessageCount: r.chat_message_count,
      aiPromptTokens: r.ai_prompt_tokens,
      aiCompletionTokens: r.ai_completion_tokens,
      durationMs: r.duration_ms != null ? Number(r.duration_ms) : undefined,
      completed: r.completed,
      metadata: r.metadata,
      createdAt: r.created_at,
    }));
  }
}
