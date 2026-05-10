import type {
  GameplayAnalytics,
  GameplayDifficultyAnalytics,
  GameplayScenarioAnalytics,
  RecentGameplaySession,
} from "../../../../shared/types/gameplay";
import type { IMetricsStore, GameplayRecord } from "./types";

const MAX_RECORDS = 10000;

function toRate(part: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((part / total) * 10000) / 100;
}

function isTerminalLifecycleState(
  lifecycleState: GameplayRecord["lifecycleState"],
): boolean {
  return lifecycleState === "completed" || lifecycleState === "abandoned";
}

function getPreferredAnalyticsRecord(
  existing: GameplayRecord | undefined,
  candidate: GameplayRecord,
): GameplayRecord {
  if (!existing) {
    return candidate;
  }

  const existingIsTerminal = isTerminalLifecycleState(existing.lifecycleState);
  const candidateIsTerminal = isTerminalLifecycleState(candidate.lifecycleState);

  if (existingIsTerminal !== candidateIsTerminal) {
    return candidateIsTerminal ? candidate : existing;
  }

  const existingTime = existing.createdAt?.getTime() ?? 0;
  const candidateTime = candidate.createdAt?.getTime() ?? 0;
  return candidateTime >= existingTime ? candidate : existing;
}

export class JsonMetricsStore implements IMetricsStore {
  private readonly records: GameplayRecord[] = [];

  async recordGameplay(data: GameplayRecord): Promise<void> {
    const lifecycleState = data.lifecycleState ?? "completed";

    if (
      data.sessionToken &&
      this.records.some((record) =>
        record.sessionToken === data.sessionToken && record.lifecycleState === lifecycleState
      )
    ) {
      return;
    }

    const record: GameplayRecord = {
      ...data,
      id: data.id ?? crypto.randomUUID(),
      lifecycleState,
      trafficSource: data.trafficSource ?? "player",
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

  async hasLifecycleEvent(sessionToken: string, lifecycleState: GameplayRecord["lifecycleState"]): Promise<boolean> {
    return this.records.some((record) =>
      record.sessionToken === sessionToken && record.lifecycleState === lifecycleState
    );
  }

  async getLatestBySessionToken(sessionToken: string): Promise<GameplayRecord | null> {
    let latest: GameplayRecord | null = null;

    for (const record of this.records) {
      if (record.sessionToken !== sessionToken) {
        continue;
      }
      latest = getPreferredAnalyticsRecord(latest ?? undefined, record);
    }

    return latest;
  }

  async getGameplayAnalytics(): Promise<GameplayAnalytics> {
    const latestBySession = new Map<string, GameplayRecord>();

    for (const record of this.records) {
      if ((record.trafficSource ?? "player") !== "player") {
        continue;
      }

      const sessionKey = record.sessionToken ?? record.id ?? crypto.randomUUID();
      const existing = latestBySession.get(sessionKey);
      latestBySession.set(sessionKey, getPreferredAnalyticsRecord(existing, record));
    }

    const latestSessions = Array.from(latestBySession.values()).sort(
      (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
    );

    const totalSessions = latestSessions.length;
    const completedSessions = latestSessions.filter((record) => record.lifecycleState === "completed");
    const abandonedSessions = latestSessions.filter((record) => record.lifecycleState === "abandoned");
    const inProgressSessions = latestSessions.filter((record) => record.lifecycleState === "started");

    const average = (values: number[]): number | null => {
      if (values.length === 0) return null;
      return values.reduce((sum, value) => sum + value, 0) / values.length;
    };

    const byDifficultyMap = new Map<string, GameplayRecord[]>();
    const byScenarioMap = new Map<string, GameplayRecord[]>();

    for (const record of latestSessions) {
      if (record.difficulty) {
        const entries = byDifficultyMap.get(record.difficulty) ?? [];
        entries.push(record);
        byDifficultyMap.set(record.difficulty, entries);
      }

      if (record.scenarioTitle) {
        const key = `${record.scenarioTitle}::${record.difficulty ?? ""}`;
        const entries = byScenarioMap.get(key) ?? [];
        entries.push(record);
        byScenarioMap.set(key, entries);
      }
    }

    const summarizeRecords = (records: GameplayRecord[]) => {
      const completed = records.filter((record) => record.lifecycleState === "completed").length;
      const abandoned = records.filter((record) => record.lifecycleState === "abandoned").length;
      const inProgress = records.filter((record) => record.lifecycleState === "started").length;
      return {
        totalSessions: records.length,
        completedSessions: completed,
        abandonedSessions: abandoned,
        inProgressSessions: inProgress,
        completionRate: toRate(completed, records.length),
      };
    };

    return {
      summary: {
        totalSessions,
        completedSessions: completedSessions.length,
        abandonedSessions: abandonedSessions.length,
        inProgressSessions: inProgressSessions.length,
        completionRate: toRate(completedSessions.length, totalSessions),
        abandonmentRate: toRate(abandonedSessions.length, totalSessions),
        avgCompletionDurationMs: average(
          completedSessions
            .map((record) => record.durationMs)
            .filter((value): value is number => typeof value === "number"),
        ),
        avgCompletionCommandCount: average(
          completedSessions
            .map((record) => record.commandCount)
            .filter((value): value is number => typeof value === "number"),
        ),
        avgCompletionChatMessageCount: average(
          completedSessions
            .map((record) => record.chatMessageCount)
            .filter((value): value is number => typeof value === "number"),
        ),
        avgCompletionScoreTotal: average(
          completedSessions
            .map((record) => record.scoreTotal)
            .filter((value): value is number => typeof value === "number"),
        ),
      },
      byDifficulty: Array.from(byDifficultyMap.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([difficulty, records]): GameplayDifficultyAnalytics => ({
          difficulty: difficulty as GameplayDifficultyAnalytics["difficulty"],
          ...summarizeRecords(records),
        })),
      byScenario: Array.from(byScenarioMap.entries())
        .map(([, records]): GameplayScenarioAnalytics => ({
          scenarioTitle: records[0]?.scenarioTitle ?? "Unknown",
          difficulty: records[0]?.difficulty,
          ...summarizeRecords(records),
        }))
        .sort((left, right) => {
          if (right.totalSessions !== left.totalSessions) {
            return right.totalSessions - left.totalSessions;
          }
          return left.scenarioTitle.localeCompare(right.scenarioTitle);
        })
        .slice(0, 10),
      recentSessions: latestSessions.slice(0, 20).map(
        (record): RecentGameplaySession => ({
          lifecycleState: record.lifecycleState ?? "completed",
          nickname: record.nickname,
          difficulty: record.difficulty,
          scenarioTitle: record.scenarioTitle,
          commandCount: record.commandCount,
          chatMessageCount: record.chatMessageCount,
          durationMs: record.durationMs,
          scoreTotal: record.scoreTotal,
          grade: record.grade,
          createdAt: (record.createdAt ?? new Date(0)).toISOString(),
        }),
      ),
    };
  }
}
