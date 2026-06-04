import { readFile, writeFile, mkdir, rename } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import type { Difficulty } from "../../../shared/types/game";
import type { LeaderboardEntry, HallOfFameEntry } from "../../../shared/types/leaderboard";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const LEADERBOARD_FILE = path.join(DATA_DIR, "leaderboard.json");
const MAX_ENTRIES_PER_DIFFICULTY = 10;
const MAX_HALL_OF_FAME = 10;

let writeLock: Promise<void> = Promise.resolve();

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeLock.then(fn, fn);
  writeLock = next.then(() => {}, () => {});
  return next;
}

async function ensureFile(): Promise<void> {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
  if (!existsSync(LEADERBOARD_FILE)) {
    await writeFile(LEADERBOARD_FILE, "[]", "utf-8");
  }
}

async function readEntries(): Promise<LeaderboardEntry[]> {
  await ensureFile();
  const data = await readFile(LEADERBOARD_FILE, "utf-8");
  return JSON.parse(data);
}

async function writeEntries(entries: LeaderboardEntry[]): Promise<void> {
  await ensureFile();
  const tmpFile = LEADERBOARD_FILE + ".tmp";
  await writeFile(tmpFile, JSON.stringify(entries, null, 2), "utf-8");
  await rename(tmpFile, LEADERBOARD_FILE);
}

function sortEntries(entries: LeaderboardEntry[]): LeaderboardEntry[] {
  return entries.sort((a, b) => {
    if (b.score.total !== a.score.total) return b.score.total - a.score.total;
    return a.durationMs - b.durationMs;
  });
}

export async function getLeaderboard(
  difficulty?: Difficulty
): Promise<LeaderboardEntry[]> {
  const entries = await readEntries();
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

export async function getHallOfFame(): Promise<HallOfFameEntry[]> {
  const entries = await readEntries();

  const playerMap = new Map<
    string,
    {
      easy?: number;
      medium?: number;
      hard?: number;
      latestNickname: string;
      latestTimestamp: number;
    }
  >();

  for (const entry of entries) {
    if (!entry.githubUserId) continue;
    const existing = playerMap.get(entry.githubUserId) ?? {
      latestNickname: entry.nickname,
      latestTimestamp: entry.timestamp,
    };
    const current = existing[entry.difficulty];
    if (current === undefined || entry.score.total > current) {
      existing[entry.difficulty] = entry.score.total;
    }
    if (entry.timestamp >= existing.latestTimestamp) {
      existing.latestNickname = entry.nickname;
      existing.latestTimestamp = entry.timestamp;
    }
    playerMap.set(entry.githubUserId, existing);
  }

  const hallOfFame: HallOfFameEntry[] = [];
  for (const [githubUserId, scores] of playerMap) {
    const compositeScore =
      (scores.easy ?? 0) + (scores.medium ?? 0) + (scores.hard ?? 0);
    hallOfFame.push({
      nickname: scores.latestNickname || githubUserId,
      compositeScore,
      scores: {
        ...(scores.easy !== undefined ? { easy: scores.easy } : {}),
        ...(scores.medium !== undefined ? { medium: scores.medium } : {}),
        ...(scores.hard !== undefined ? { hard: scores.hard } : {}),
      },
    });
  }

  hallOfFame.sort((a, b) => b.compositeScore - a.compositeScore);
  return hallOfFame.slice(0, MAX_HALL_OF_FAME);
}

export function addEntry(
  entry: LeaderboardEntry
): Promise<LeaderboardEntry> {
  return withWriteLock(async () => {
    if (!entry.githubUserId || entry.identityKind !== "github") {
      throw new Error("Persistent leaderboard entries require a GitHub-backed identity");
    }

    const entries = await readEntries();

    const existingIdx = entries.findIndex(
      (e) => e.githubUserId === entry.githubUserId && e.difficulty === entry.difficulty
    );

    if (existingIdx !== -1) {
      if (
        entry.score.total > entries[existingIdx].score.total ||
        (
          entry.score.total === entries[existingIdx].score.total &&
          entry.durationMs < entries[existingIdx].durationMs
        )
      ) {
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

    await writeEntries(trimmed);
    return entry;
  });
}
