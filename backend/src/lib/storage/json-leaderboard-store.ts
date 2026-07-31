import { readFile, writeFile, mkdir, rename } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import type { PlatformId } from "../../../../shared/types/platform";
import type { LeaderboardEntry, HallOfFameEntry } from "../../../../shared/types/leaderboard";
import type { ILeaderboardStore, LeaderboardFilters } from "./types";

const MAX_ENTRIES_PER_DIFFICULTY = 10;
const MAX_HALL_OF_FAME = 10;

function sortEntries(entries: LeaderboardEntry[]): LeaderboardEntry[] {
  return entries.sort((a, b) => {
    if (b.score.total !== a.score.total) return b.score.total - a.score.total;
    return a.durationMs - b.durationMs;
  });
}

function isPublicPlayerEntry(entry: LeaderboardEntry): boolean {
  return (
    entry.identityKind === "github" &&
    Boolean(entry.githubUserId) &&
    (entry.trafficSource ?? "player") === "player"
  );
}

export class JsonLeaderboardStore implements ILeaderboardStore {
  private readonly dataDir: string;
  private readonly filePath: string;
  private writeLock: Promise<void> = Promise.resolve();

  constructor() {
    this.dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");
    this.filePath = path.join(this.dataDir, "leaderboard.json");
  }

  private withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeLock.then(fn, fn);
    this.writeLock = next.then(() => {}, () => {});
    return next;
  }

  private async ensureFile(): Promise<void> {
    if (!existsSync(this.dataDir)) {
      await mkdir(this.dataDir, { recursive: true });
    }
    if (!existsSync(this.filePath)) {
      await writeFile(this.filePath, "[]", "utf-8");
    }
  }

  private async readEntries(): Promise<LeaderboardEntry[]> {
    await this.ensureFile();
    const data = await readFile(this.filePath, "utf-8");
    return JSON.parse(data);
  }

  private async writeEntries(entries: LeaderboardEntry[]): Promise<void> {
    await this.ensureFile();
    const tmpFile = this.filePath + ".tmp";
    await writeFile(tmpFile, JSON.stringify(entries, null, 2), "utf-8");
    await rename(tmpFile, this.filePath);
  }

  async getLeaderboard(filters?: LeaderboardFilters): Promise<LeaderboardEntry[]> {
    const entries = await this.readEntries();
    const difficulty = filters?.difficulty;
    const platform = filters?.platform;
    const filtered = difficulty || platform
      ? entries.filter(
          (e) =>
            (!difficulty || e.difficulty === difficulty) &&
            (!platform || e.platform === platform) &&
            isPublicPlayerEntry(e)
        )
      : entries.filter(isPublicPlayerEntry);
    return sortEntries(filtered).slice(0, MAX_ENTRIES_PER_DIFFICULTY);
  }

  async getHallOfFame(platform: PlatformId): Promise<HallOfFameEntry[]> {
    const entries = (await this.readEntries()).filter(
      (entry) => entry.platform === platform && isPublicPlayerEntry(entry),
    );

    const playerMap = new Map<
      string,
      {
        nickname: string;
        latestTimestamp: number;
        scores: { easy?: number; medium?: number; hard?: number };
      }
    >();

    for (const entry of entries) {
      if (!isPublicPlayerEntry(entry)) continue;
      if (!entry.githubUserId) continue;
      const existing = playerMap.get(entry.githubUserId) ?? {
        nickname: entry.nickname,
        latestTimestamp: entry.timestamp,
        scores: {},
      };
      const current = existing.scores[entry.difficulty];
      if (current === undefined || entry.score.total > current) {
        existing.scores[entry.difficulty] = entry.score.total;
      }
      if (entry.timestamp >= existing.latestTimestamp) {
        existing.nickname = entry.nickname;
        existing.latestTimestamp = entry.timestamp;
      }
      playerMap.set(entry.githubUserId, existing);
    }

    const hallOfFame: HallOfFameEntry[] = [];
    for (const [, player] of playerMap) {
      const scores = player.scores;
      const compositeScore =
        (scores.easy ?? 0) + (scores.medium ?? 0) + (scores.hard ?? 0);
      hallOfFame.push({
        nickname: player.nickname,
        platform,
        compositeScore,
        scores,
      });
    }

    hallOfFame.sort((a, b) => b.compositeScore - a.compositeScore);
    return hallOfFame.slice(0, MAX_HALL_OF_FAME);
  }

  addEntry(entry: LeaderboardEntry): Promise<LeaderboardEntry> {
    return this.withWriteLock(async () => {
      if (!entry.githubUserId || entry.identityKind !== "github") {
        throw new Error("Persistent leaderboard entries require a GitHub-backed identity");
      }

      const entries = await this.readEntries();

      const existingIdx = entries.findIndex(
        (e) =>
          e.githubUserId === entry.githubUserId &&
          e.platform === entry.platform &&
          e.difficulty === entry.difficulty &&
          (e.trafficSource ?? "player") === (entry.trafficSource ?? "player")
      );

      if (existingIdx !== -1) {
        const existing = entries[existingIdx];
        const hasBetterScore = entry.score.total > existing.score.total;
        const hasBetterDuration =
          entry.score.total === existing.score.total &&
          entry.durationMs < existing.durationMs;

        if (hasBetterScore || hasBetterDuration) {
          entries[existingIdx] = entry;
        }
      } else {
        entries.push(entry);
      }

      const grouped: Record<string, LeaderboardEntry[]> = {};
      for (const e of entries) {
        const key = `${e.platform}:${e.difficulty}:${e.trafficSource ?? "player"}`;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(e);
      }

      const trimmed: LeaderboardEntry[] = [];
      for (const key of Object.keys(grouped)) {
        const sorted = sortEntries(grouped[key]);
        trimmed.push(...sorted.slice(0, MAX_ENTRIES_PER_DIFFICULTY));
      }

      await this.writeEntries(trimmed);
      return entry;
    });
  }
}
