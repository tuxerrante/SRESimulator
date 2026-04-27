import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { JsonLeaderboardStore } from "./json-leaderboard-store";

describe("JsonLeaderboardStore", () => {
  let tmpDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "json-lb-store-"));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tmpDir;
    vi.useRealTimers();
  });

  afterEach(async () => {
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
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

    const hallOfFame = await store.getHallOfFame();
    expect(hallOfFame[0]?.nickname).toBe("alice-renamed");
  });
});
