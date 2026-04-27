import { readFile, writeFile, mkdir, rename } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import type { Difficulty } from "../../../../shared/types/game";
import type { LeaderboardEntry, HallOfFameEntry } from "../../../../shared/types/leaderboard";
import type { ILeaderboardStore } from "./types";

const MAX_ENTRIES_PER_DIFFICULTY = 10;
const MAX_HALL_OF_FAME = 10;

function sortEntries(entries: LeaderboardEntry[]): LeaderboardEntry[] {
  return entries.sort((a, b) => {
    if (b.score.total !== a.score.total) return b.score.total - a.score.total;
    return a.durationMs - b.durationMs;
  });
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

  async getLeaderboard(difficulty?: Difficulty): Promise<LeaderboardEntry[]> {
    const entries = await this.readEntries();
    const filtered = difficulty
      ? entries.filter(
          (e) =>
            e.difficulty === difficulty &&
            e.identityKind === "github" &&
            Boolean(e.githubUserId)
        )
      : entries.filter((e) => e.identityKind === "github" && Boolean(e.githubUserId));
    return sortEntries(filtered).slice(0, MAX_ENTRIES_PER_DIFFICULTY);
  }

  async getHallOfFame(): Promise<HallOfFameEntry[]> {
    const entries = await this.readEntries();

    const playerMap = new Map<
      string,
      {
        nickname: string;
        latestTimestamp: number;
        scores: { easy?: number; medium?: number; hard?: number };
      }
    >();

    for (const entry of entries) {
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
      hallOfFame.push({ nickname: player.nickname, compositeScore, scores });
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
        (e) => e.githubUserId === entry.githubUserId && e.difficulty === entry.difficulty
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
        if (!grouped[e.difficulty]) grouped[e.difficulty] = [];
        grouped[e.difficulty].push(e);
      }

      const trimmed: LeaderboardEntry[] = [];
      for (const difficulty of Object.keys(grouped)) {
        const sorted = sortEntries(grouped[difficulty]);
        trimmed.push(...sorted.slice(0, MAX_ENTRIES_PER_DIFFICULTY));
      }

      await this.writeEntries(trimmed);
      return entry;
    });
  }
}
