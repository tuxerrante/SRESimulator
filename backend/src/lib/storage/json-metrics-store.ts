import type { IMetricsStore, GameplayRecord } from "./types";

const MAX_RECORDS = 10000;

export class JsonMetricsStore implements IMetricsStore {
  private readonly records: GameplayRecord[] = [];

  async recordGameplay(data: GameplayRecord): Promise<void> {
    const lifecycleState = data.lifecycleState ?? "completed";

    const record: GameplayRecord = {
      ...data,
      id: data.id ?? crypto.randomUUID(),
      lifecycleState,
      commandCount: data.commandCount ?? data.commandsExecuted?.length ?? 0,
      commandsExecuted: data.commandsExecuted ?? [],
      scoringEvents: data.scoringEvents ?? [],
      chatMessageCount: data.chatMessageCount ?? 0,
      aiPromptTokens: data.aiPromptTokens ?? 0,
      aiCompletionTokens: data.aiCompletionTokens ?? 0,
      completed: data.completed ?? lifecycleState === "completed",
      metadata: data.metadata ?? {},
      createdAt: data.createdAt ?? new Date(),
    };

    this.records.push(record);
    if (this.records.length > MAX_RECORDS) {
      this.records.splice(0, this.records.length - MAX_RECORDS);
    }

    console.log(
      `[metrics] gameplay recorded (in-memory only): session=${record.sessionToken?.slice(0, 8) ?? "unknown"} ` +
      `state=${record.lifecycleState} difficulty=${record.difficulty ?? "unknown"}`
    );
  }

  async getPlayerHistory(nickname: string): Promise<GameplayRecord[]> {
    return this.records
      .filter((record) => record.nickname === nickname)
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  }
}
