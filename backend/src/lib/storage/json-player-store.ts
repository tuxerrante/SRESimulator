import { readFile, writeFile, mkdir, rename } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import type { GithubViewer } from "../../../../shared/auth/viewer";
import type { IPlayerStore, PlayerRecord } from "./types";

export class JsonPlayerStore implements IPlayerStore {
  private readonly dataDir: string;
  private readonly filePath: string;
  private writeLock: Promise<void> = Promise.resolve();

  constructor() {
    this.dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");
    this.filePath = path.join(this.dataDir, "players.json");
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

  private async readPlayers(): Promise<PlayerRecord[]> {
    await this.ensureFile();
    const data = await readFile(this.filePath, "utf-8");
    return JSON.parse(data) as PlayerRecord[];
  }

  private async writePlayers(players: PlayerRecord[]): Promise<void> {
    await this.ensureFile();
    const tmpFile = `${this.filePath}.tmp`;
    await writeFile(tmpFile, JSON.stringify(players, null, 2), "utf-8");
    await rename(tmpFile, this.filePath);
  }

  async upsertGithubViewer(viewer: GithubViewer): Promise<PlayerRecord> {
    return this.withWriteLock(async () => {
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
    });
  }

  async getByGithubUserId(githubUserId: string): Promise<PlayerRecord | null> {
    const players = await this.readPlayers();
    return players.find((player) => player.githubUserId === githubUserId) ?? null;
  }
}
