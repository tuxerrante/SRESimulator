import type { GameplayAnalytics, GameplayDifficultyAnalytics, GameplayScenarioAnalytics, GameplayLifecycleState } from "../../../../shared/types/gameplay";
import type { Difficulty } from "../../../../shared/types/game";
import type { IMetricsStore, GameplayRecord } from "./types";

const records: GameplayRecord[] = [];

function sessionKey(record: GameplayRecord): string {
  return record.sessionToken ?? record.id ?? crypto.randomUUID();
}

function roundAverage(values: number[]): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Math.round((total / values.length) * 100) / 100;
}

function toRate(part: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((part / total) * 10000) / 100;
}

function latestSessionRecords(): GameplayRecord[] {
  const latest = new Map<string, GameplayRecord>();
  const sorted = [...records].sort((a, b) => {
    const aTime = a.createdAt?.getTime() ?? 0;
    const bTime = b.createdAt?.getTime() ?? 0;
    return aTime - bTime;
  });

  for (const record of sorted) {
    latest.set(sessionKey(record), record);
  }

  return [...latest.values()];
}

function countStates(items: GameplayRecord[]) {
  const states: Record<GameplayLifecycleState, number> = {
    started: 0,
    completed: 0,
    abandoned: 0,
  };

  for (const item of items) {
    const state = item.lifecycleState ?? "completed";
    states[state] += 1;
  }

  return states;
}

export class JsonMetricsStore implements IMetricsStore {
  async recordGameplay(data: GameplayRecord): Promise<void> {
    const record: GameplayRecord = {
      ...data,
      id: data.id ?? crypto.randomUUID(),
      lifecycleState: data.lifecycleState ?? "completed",
      commandCount: data.commandCount ?? data.commandsExecuted?.length ?? 0,
      commandsExecuted: data.commandsExecuted ?? [],
      scoringEvents: data.scoringEvents ?? [],
      chatMessageCount: data.chatMessageCount ?? 0,
      aiPromptTokens: data.aiPromptTokens ?? 0,
      aiCompletionTokens: data.aiCompletionTokens ?? 0,
      completed: data.completed ?? data.lifecycleState === "completed",
      metadata: data.metadata ?? {},
      createdAt: data.createdAt ?? new Date(),
    };

    records.push(record);

    console.log(
      `[metrics] gameplay recorded (in-memory only): session=${record.sessionToken ?? "unknown"} ` +
      `state=${record.lifecycleState} difficulty=${record.difficulty ?? "unknown"}`
    );
  }

  async getPlayerHistory(nickname: string): Promise<GameplayRecord[]> {
    return records
      .filter((record) => record.nickname === nickname)
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  }

  async getGameplayAnalytics(): Promise<GameplayAnalytics> {
    const latest = latestSessionRecords();
    const completed = latest.filter((record) => record.lifecycleState === "completed");
    const summaryStates = countStates(latest);

    const byDifficulty = (["easy", "medium", "hard"] as Difficulty[])
      .map((difficulty): GameplayDifficultyAnalytics => {
        const scoped = latest.filter((record) => record.difficulty === difficulty);
        const scopedStates = countStates(scoped);
        return {
          difficulty,
          totalSessions: scoped.length,
          completedSessions: scopedStates.completed,
          abandonedSessions: scopedStates.abandoned,
          inProgressSessions: scopedStates.started,
          completionRate: toRate(scopedStates.completed, scoped.length),
        };
      })
      .filter((bucket) => bucket.totalSessions > 0);

    const scenarioMap = new Map<string, GameplayRecord[]>();
    for (const record of latest) {
      const key = `${record.difficulty ?? "unknown"}::${record.scenarioTitle ?? "Unknown Scenario"}`;
      const existing = scenarioMap.get(key) ?? [];
      existing.push(record);
      scenarioMap.set(key, existing);
    }

    const byScenario = [...scenarioMap.entries()]
      .map(([key, scoped]): GameplayScenarioAnalytics => {
        const [difficulty, scenarioTitle] = key.split("::");
        const scopedStates = countStates(scoped);
        return {
          difficulty: difficulty === "unknown" ? undefined : (difficulty as Difficulty),
          scenarioTitle,
          totalSessions: scoped.length,
          completedSessions: scopedStates.completed,
          abandonedSessions: scopedStates.abandoned,
          inProgressSessions: scopedStates.started,
          completionRate: toRate(scopedStates.completed, scoped.length),
        };
      })
      .sort((a, b) => b.totalSessions - a.totalSessions || a.scenarioTitle.localeCompare(b.scenarioTitle));

    return {
      summary: {
        totalSessions: latest.length,
        completedSessions: summaryStates.completed,
        abandonedSessions: summaryStates.abandoned,
        inProgressSessions: summaryStates.started,
        completionRate: toRate(summaryStates.completed, latest.length),
        abandonmentRate: toRate(summaryStates.abandoned, latest.length),
        avgCompletionDurationMs: roundAverage(
          completed.map((record) => record.durationMs).filter((value): value is number => typeof value === "number"),
        ),
        avgCompletionCommandCount: roundAverage(
          completed.map((record) => record.commandCount).filter((value): value is number => typeof value === "number"),
        ),
        avgCompletionChatMessageCount: roundAverage(
          completed.map((record) => record.chatMessageCount).filter((value): value is number => typeof value === "number"),
        ),
        avgCompletionScoreTotal: roundAverage(
          completed.map((record) => record.scoreTotal).filter((value): value is number => typeof value === "number"),
        ),
      },
      byDifficulty,
      byScenario,
      recentSessions: latest
        .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
        .slice(0, 20)
        .map((record) => ({
          sessionToken: record.sessionToken,
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
        })),
    };
  }
}
