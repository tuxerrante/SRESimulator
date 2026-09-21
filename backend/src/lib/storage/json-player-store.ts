import { writeFile, mkdir, rename } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import type { GithubViewer } from "../../../../shared/auth/viewer";
import type { IPlayerStore, PlayerRecord } from "./types";
import { acquireJsonProcessLock } from "./json-process-lock";
import { readJsonFileOrEmpty } from "./json-file-read";

const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 5000;
function getLockWaitTimeoutMs(): number {
  const parsed = Number.parseInt(
    process.env.JSON_PLAYER_STORE_LOCK_TIMEOUT_MS ?? "",
    10,
  );
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_LOCK_WAIT_TIMEOUT_MS;
}

export class JsonPlayerStore implements IPlayerStore {
  private readonly dataDir: string;
  private readonly filePath: string;
  private readonly lockPath: string;
  private writeLock: Promise<void> = Promise.resolve();

  constructor() {
    this.dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");
    this.filePath = path.join(this.dataDir, "players.json");
    this.lockPath = path.join(this.dataDir, ".players.lock");
  }

  private withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeLock.then(fn, fn);
    this.writeLock = next.then(() => {}, () => {});
    return next;
  }

  // Only the directory is created eagerly. Seeding the file with "[]" here was
  // racy: two callers could both see it missing, both write, and a third could
  // read the file after creation but before the bytes landed, yielding
  // "Unexpected end of JSON input". The file is instead created by the atomic
  // tmp-file rename below, and a missing file simply reads as empty.
  private async ensureDir(): Promise<void> {
    if (!existsSync(this.dataDir)) {
      await mkdir(this.dataDir, { recursive: true });
    }
  }

  private async readPlayers(): Promise<PlayerRecord[]> {
    const data = await readJsonFileOrEmpty(this.filePath);
    return data === null ? [] : (JSON.parse(data) as PlayerRecord[]);
  }

  private async acquireProcessLock(): Promise<() => Promise<void>> {
    return acquireJsonProcessLock(
      this.lockPath,
      getLockWaitTimeoutMs(),
      "players lock",
    );
  }

  private async writePlayers(players: PlayerRecord[]): Promise<void> {
    await this.ensureDir();
    const tmpFile = `${this.filePath}.${crypto.randomUUID()}.tmp`;
    await writeFile(tmpFile, JSON.stringify(players, null, 2), "utf-8");
    await rename(tmpFile, this.filePath);
  }

  async upsertGithubViewer(viewer: GithubViewer): Promise<PlayerRecord> {
    return this.withWriteLock(async () => {
      const releaseProcessLock = await this.acquireProcessLock();
      try {
        const players = await this.readPlayers();
        const now = new Date();
        const nextRecord: PlayerRecord = {
          githubUserId: viewer.githubUserId,
          githubLogin: viewer.githubLogin,
          displayName: viewer.displayName,
          avatarUrl: viewer.avatarUrl,
          createdAt: now,
          updatedAt: now,
        };

        const existingIndex = players.findIndex(
          (player) => player.githubUserId === viewer.githubUserId
        );

        if (existingIndex >= 0) {
          const existing = players[existingIndex];
          players[existingIndex] = {
            ...existing,
            githubLogin: viewer.githubLogin,
            displayName: viewer.displayName,
            avatarUrl: viewer.avatarUrl,
            updatedAt: now,
          };
        } else {
          players.push(nextRecord);
        }

        await this.writePlayers(players);
        return existingIndex >= 0 ? players[existingIndex] : nextRecord;
      } finally {
        await releaseProcessLock();
      }
    });
  }

  async getByGithubUserId(githubUserId: string): Promise<PlayerRecord | null> {
    const players = await this.readPlayers();
    return players.find((player) => player.githubUserId === githubUserId) ?? null;
  }
}
