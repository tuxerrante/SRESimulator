import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

describe("leaderboard", () => {
  let tmpDir: string;
  let origDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "lb-test-"));
    origDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tmpDir;
    vi.resetModules();
  });

  afterEach(async () => {
    if (origDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = origDataDir;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeEntry(
    nickname: string,
    difficulty: "easy" | "medium" | "hard",
    total: number,
    durationMs = 60000
  ) {
    const githubUserId = `gh-${nickname}`;
    return {
      id: crypto.randomUUID(),
      nickname,
      difficulty,
      score: {
        efficiency: total / 4,
        safety: total / 4,
        documentation: total / 4,
        accuracy: total / 4,
        total,
      },
      grade: total >= 80 ? "A" : "B",
      commandCount: 5,
      durationMs,
      scenarioTitle: `${difficulty} scenario`,
      identityKind: "github" as const,
      githubUserId,
      githubLogin: `login-${nickname}`,
      timestamp: Date.now(),
    };
  }

  it("starts with empty leaderboard", async () => {
    const { getLeaderboard } = await import("./leaderboard");
    const entries = await getLeaderboard();
    expect(entries).toEqual([]);
  });

  it("adds and retrieves entries", async () => {
    const { addEntry, getLeaderboard } = await import("./leaderboard");

    await addEntry(makeEntry("alice", "easy", 80));
    await addEntry(makeEntry("bob", "easy", 90));

    const entries = await getLeaderboard("easy");
    expect(entries).toHaveLength(2);
    expect(entries[0].nickname).toBe("bob");
    expect(entries[1].nickname).toBe("alice");
  });

  it("updates existing entry when score improves", async () => {
    const { addEntry, getLeaderboard } = await import("./leaderboard");

    await addEntry(makeEntry("alice", "easy", 60));
    await addEntry(makeEntry("alice", "easy", 90));

    const entries = await getLeaderboard("easy");
    expect(entries).toHaveLength(1);
    expect(entries[0].score.total).toBe(90);
  });

  it("does not update existing entry when score is lower", async () => {
    const { addEntry, getLeaderboard } = await import("./leaderboard");

    await addEntry(makeEntry("alice", "easy", 90));
    await addEntry(makeEntry("alice", "easy", 60));

    const entries = await getLeaderboard("easy");
    expect(entries).toHaveLength(1);
    expect(entries[0].score.total).toBe(90);
  });

  it("trims to 10 entries per difficulty", async () => {
    const { addEntry, getLeaderboard } = await import("./leaderboard");

    for (let i = 0; i < 12; i++) {
      await addEntry(makeEntry(`player-${i}`, "easy", 50 + i));
    }

    const entries = await getLeaderboard("easy");
    expect(entries.length).toBeLessThanOrEqual(10);
    expect(entries[0].score.total).toBe(61);
  });

  it("filters leaderboard by difficulty", async () => {
    const { addEntry, getLeaderboard } = await import("./leaderboard");

    await addEntry(makeEntry("alice", "easy", 80));
    await addEntry(makeEntry("bob", "medium", 70));

    expect(await getLeaderboard("easy")).toHaveLength(1);
    expect(await getLeaderboard("medium")).toHaveLength(1);
    expect(await getLeaderboard("hard")).toHaveLength(0);
  });

  it("computes hall of fame with composite scores", async () => {
    const { addEntry, getHallOfFame } = await import("./leaderboard");

    await addEntry(makeEntry("alice", "easy", 80));
    await addEntry(makeEntry("alice", "medium", 70));
    await addEntry(makeEntry("bob", "easy", 90));

    const hall = await getHallOfFame();
    expect(hall).toHaveLength(2);
    expect(hall[0].nickname).toBe("alice");
    expect(hall[0].compositeScore).toBe(150);
    expect(hall[1].nickname).toBe("bob");
    expect(hall[1].compositeScore).toBe(90);
  });

  it("uses higher score for hall of fame when multiple attempts exist", async () => {
    const { addEntry, getHallOfFame } = await import("./leaderboard");

    await addEntry(makeEntry("alice", "easy", 60));
    await addEntry(makeEntry("alice", "easy", 90));

    const hall = await getHallOfFame();
    expect(hall[0].scores.easy).toBe(90);
  });

  it("uses the latest nickname seen for a GitHub player in hall of fame", async () => {
    const { addEntry, getHallOfFame } = await import("./leaderboard");
    const first = makeEntry("alice", "easy", 80);
    const renamed = {
      ...makeEntry("alice-renamed", "medium", 70),
      githubUserId: first.githubUserId,
      githubLogin: first.githubLogin,
      timestamp: first.timestamp + 1_000,
    };

    await addEntry(first);
    await addEntry(renamed);

    const hall = await getHallOfFame();
    expect(hall[0].nickname).toBe("alice-renamed");
  });
});
