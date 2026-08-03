import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { JsonLeaderboardStore } from "./json-leaderboard-store";

describe("JsonLeaderboardStore", () => {
  let tmpDir: string;
  let originalDataDir: string | undefined;
  let originalLockTimeoutMs: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "json-lb-store-"));
    originalDataDir = process.env.DATA_DIR;
    originalLockTimeoutMs =
      process.env.JSON_LEADERBOARD_STORE_LOCK_TIMEOUT_MS;
    process.env.DATA_DIR = tmpDir;
    vi.useRealTimers();
  });

  afterEach(async () => {
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
    if (originalLockTimeoutMs === undefined) {
      delete process.env.JSON_LEADERBOARD_STORE_LOCK_TIMEOUT_MS;
    } else {
      process.env.JSON_LEADERBOARD_STORE_LOCK_TIMEOUT_MS =
        originalLockTimeoutMs;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("uses the latest timestamp to choose a hall of fame nickname", async () => {
    const store = new JsonLeaderboardStore();
    const firstTimestamp = Date.now();
    await writeFile(
      join(tmpDir, "leaderboard.json"),
      JSON.stringify(
        [
          {
            id: crypto.randomUUID(),
            nickname: "alice-renamed",
            platform: "aro-classic",
            difficulty: "medium",
            score: {
              efficiency: 18,
              safety: 18,
              documentation: 17,
              accuracy: 17,
              total: 70,
            },
            grade: "B",
            commandCount: 6,
            durationMs: 70_000,
            scenarioTitle: "Medium",
            identityKind: "github",
            githubUserId: "gh-alice",
            githubLogin: "alice",
            timestamp: firstTimestamp + 1_000,
          },
          {
            id: crypto.randomUUID(),
            nickname: "alice",
            platform: "aro-classic",
            difficulty: "easy",
            score: {
              efficiency: 20,
              safety: 20,
              documentation: 20,
              accuracy: 20,
              total: 80,
            },
            grade: "A",
            commandCount: 5,
            durationMs: 60_000,
            scenarioTitle: "Easy",
            identityKind: "github",
            githubUserId: "gh-alice",
            githubLogin: "alice",
            timestamp: firstTimestamp,
          },
        ],
        null,
        2
      ),
      "utf8"
    );

    const hallOfFame = await store.getHallOfFame("aro-classic");
    expect(hallOfFame[0]?.nickname).toBe("alice-renamed");
    expect(hallOfFame[0]?.platform).toBe("aro-classic");
  });

  it("keeps separate persistent leaderboard rows per platform", async () => {
    const store = new JsonLeaderboardStore();
    const baseEntry = {
      nickname: "player",
      score: {
        efficiency: 20,
        safety: 20,
        documentation: 20,
        accuracy: 20,
        total: 80,
      },
      grade: "B",
      commandCount: 6,
      durationMs: 90_000,
      scenarioTitle: "Platform Scenario",
      identityKind: "github" as const,
      githubUserId: "gh-player",
      githubLogin: "player",
      trafficSource: "player" as const,
      timestamp: Date.now(),
    };

    await store.addEntry({
      ...baseEntry,
      id: "aro-entry",
      platform: "aro-classic",
      difficulty: "easy",
    });
    await store.addEntry({
      ...baseEntry,
      id: "aks-entry",
      platform: "aks",
      difficulty: "easy",
    });

    expect(
      await store.getLeaderboard({ platform: "aro-classic", difficulty: "easy" }),
    ).toHaveLength(1);
    expect(
      await store.getLeaderboard({ platform: "aks", difficulty: "easy" }),
    ).toHaveLength(1);
  });

  it("serializes writes across store instances sharing one data directory", async () => {
    const stores = [new JsonLeaderboardStore(), new JsonLeaderboardStore()];
    const baseEntry = {
      nickname: "concurrent-player",
      score: {
        efficiency: 20,
        safety: 20,
        documentation: 20,
        accuracy: 20,
        total: 80,
      },
      grade: "B",
      commandCount: 6,
      durationMs: 90_000,
      scenarioTitle: "Concurrent Scenario",
      identityKind: "github" as const,
      githubLogin: "concurrent-player",
      trafficSource: "player" as const,
      timestamp: Date.now(),
      platform: "aro-classic" as const,
      difficulty: "easy" as const,
    };

    await expect(
      Promise.all(
        stores.map((store, index) =>
          store.addEntry({
            ...baseEntry,
            id: `concurrent-entry-${index}`,
            githubUserId: `gh-concurrent-${index}`,
          }),
        ),
      ),
    ).resolves.toHaveLength(2);

    await expect(
      stores[0].getLeaderboard({ platform: "aro-classic", difficulty: "easy" }),
    ).resolves.toHaveLength(2);
  });

  it("fails fast when a stale leaderboard lock never clears", async () => {
    process.env.JSON_LEADERBOARD_STORE_LOCK_TIMEOUT_MS = "30";
    await mkdir(join(tmpDir, ".leaderboard.lock"));
    const store = new JsonLeaderboardStore();

    await expect(
      store.addEntry({
        id: "stale-lock-entry",
        nickname: "stale-lock-player",
        platform: "aro-classic",
        difficulty: "easy",
        score: {
          efficiency: 20,
          safety: 20,
          documentation: 20,
          accuracy: 20,
          total: 80,
        },
        grade: "B",
        commandCount: 1,
        durationMs: 1_000,
        scenarioTitle: "Stale Lock Scenario",
        identityKind: "github",
        githubUserId: "gh-stale-lock",
        trafficSource: "player",
        timestamp: Date.now(),
      }),
    ).rejects.toThrow(/Timed out waiting for leaderboard lock/);
  });
});
