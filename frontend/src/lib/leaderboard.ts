import { readFile, writeFile, mkdir, rename } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import type { Difficulty } from "@/types/game";
import type { LeaderboardEntry, HallOfFameEntry } from "@/types/leaderboard";

const DATA_DIR = path.join(process.cwd(), "data");
const LEADERBOARD_FILE = path.join(DATA_DIR, "leaderboard.json");
const MAX_ENTRIES_PER_DIFFICULTY = 10;
const MAX_HALL_OF_FAME = 10;

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
    ? entries.filter((e) => e.difficulty === difficulty)
    : entries;
  return sortEntries(filtered).slice(0, MAX_ENTRIES_PER_DIFFICULTY);
}

export async function getHallOfFame(): Promise<HallOfFameEntry[]> {
  const entries = await readEntries();

  // Group by nickname, keep best score per difficulty
  const playerMap = new Map<
    string,
    { easy?: number; medium?: number; hard?: number }
  >();

  for (const entry of entries) {
    const existing = playerMap.get(entry.nickname) ?? {};
    const current = existing[entry.difficulty];
    if (current === undefined || entry.score.total > current) {
      existing[entry.difficulty] = entry.score.total;
    }
    playerMap.set(entry.nickname, existing);
  }

  const hallOfFame: HallOfFameEntry[] = [];
  for (const [nickname, scores] of playerMap) {
    const compositeScore =
      (scores.easy ?? 0) + (scores.medium ?? 0) + (scores.hard ?? 0);
    hallOfFame.push({ nickname, compositeScore, scores });
  }

  hallOfFame.sort((a, b) => b.compositeScore - a.compositeScore);
  return hallOfFame.slice(0, MAX_HALL_OF_FAME);
}

export async function addEntry(
  entry: LeaderboardEntry
): Promise<LeaderboardEntry> {
  const entries = await readEntries();

  // Best score per nickname per difficulty: replace if new score is higher
  const existingIdx = entries.findIndex(
    (e) => e.nickname === entry.nickname && e.difficulty === entry.difficulty
  );

  if (existingIdx !== -1) {
    if (entry.score.total > entries[existingIdx].score.total) {
      entries[existingIdx] = entry;
    }
    // If existing score is higher or equal, don't add
  } else {
    entries.push(entry);
  }

  // Trim to top 10 per difficulty
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
}
