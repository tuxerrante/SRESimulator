import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonPlayerStore } from "./json-player-store";

describe("JsonPlayerStore", () => {
  const originalDataDir = process.env.DATA_DIR;
  const originalLockTimeoutMs = process.env.JSON_PLAYER_STORE_LOCK_TIMEOUT_MS;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "json-player-store-"));
    process.env.DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
    if (originalLockTimeoutMs === undefined) {
      delete process.env.JSON_PLAYER_STORE_LOCK_TIMEOUT_MS;
    } else {
      process.env.JSON_PLAYER_STORE_LOCK_TIMEOUT_MS = originalLockTimeoutMs;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it("supports concurrent upserts across store instances that share one data directory", async () => {
    const stores = Array.from({ length: 12 }, () => new JsonPlayerStore());
    const githubUserIds = stores.map((_, index) => `user-${index}`);

    await expect(
      Promise.all(
        stores.map((store, index) =>
          store.upsertGithubViewer({
            kind: "github",
            githubUserId: githubUserIds[index]!,
            githubLogin: githubUserIds[index]!,
            displayName: `User ${index}`,
            avatarUrl: null,
          }),
        ),
      ),
    ).resolves.toHaveLength(12);

    const verifyingStore = new JsonPlayerStore();
    const persistedPlayers = await Promise.all(
      githubUserIds.map((githubUserId) => verifyingStore.getByGithubUserId(githubUserId)),
    );
    expect(persistedPlayers.every((player) => player?.githubUserId)).toBe(true);
  });

  it("fails fast when a stale cross-process lock never clears", async () => {
    process.env.JSON_PLAYER_STORE_LOCK_TIMEOUT_MS = "30";
    await mkdir(join(dataDir, ".players.lock"), { recursive: true });

    const store = new JsonPlayerStore();

    await expect(
      store.upsertGithubViewer({
        kind: "github",
        githubUserId: "stale-lock-user",
        githubLogin: "stale-lock-user",
        displayName: "Stale Lock User",
        avatarUrl: null,
      }),
    ).rejects.toThrow(/Timed out waiting for players lock/);
  });
});
