import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonPlayerStore } from "./json-player-store";

describe("JsonPlayerStore", () => {
  const originalDataDir = process.env.DATA_DIR;
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
});
