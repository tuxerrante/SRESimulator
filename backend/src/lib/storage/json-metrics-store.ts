import type { IMetricsStore, GameplayRecord } from "./types";

export class JsonMetricsStore implements IMetricsStore {
  async recordGameplay(data: GameplayRecord): Promise<void> {
    console.log(
      `[metrics] gameplay recorded (in-memory only): session=${data.sessionToken ?? "unknown"} ` +
      `nickname=${data.nickname ?? "unknown"} difficulty=${data.difficulty ?? "unknown"}`
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getPlayerHistory(_nickname: string): Promise<GameplayRecord[]> {
    return [];
  }
}
