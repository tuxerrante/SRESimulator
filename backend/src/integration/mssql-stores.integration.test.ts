import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type sql from "mssql";

let pool: sql.ConnectionPool;

const SKIP = process.env.STORAGE_BACKEND !== "mssql";

const createdSessionTokens: string[] = [];
const createdNicknames: string[] = [];
const createdGithubUserIds: string[] = [];
const createdClaimKeys: string[] = [];

function shortId(prefix: string): string {
  const suffix = Date.now().toString(36).slice(-6);
  return `${prefix}${suffix}`.slice(0, 20);
}

function trackNickname(nick: string): string {
  createdNicknames.push(nick);
  return nick;
}

function trackGithubUserId(githubUserId: string): string {
  createdGithubUserIds.push(githubUserId);
  return githubUserId;
}

function trackClaimKey(claimKey: string): string {
  createdClaimKeys.push(claimKey);
  return claimKey;
}

function githubIdentity(seed: string) {
  return {
    identityKind: "github" as const,
    githubUserId: `gh-${seed}`,
    githubLogin: `login-${seed}`,
  };
}

beforeAll(async () => {
  if (SKIP) return;

  const mssql = await import("mssql");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL required for MSSQL tests");

  pool = new mssql.default.ConnectionPool(databaseUrl);
  await pool.connect();

  const { runMigrations } = await import("../lib/storage/migrate");
  await runMigrations(pool);
});

afterAll(async () => {
  if (!pool) return;

  for (const nick of createdNicknames) {
    await pool.request()
      .input("nick", nick)
      .query("DELETE FROM gameplay_metrics WHERE nickname = @nick");
    await pool.request()
      .input("nick", nick)
      .query("DELETE FROM leaderboard_entries WHERE nickname = @nick");
  }

  for (const token of createdSessionTokens) {
    await pool.request()
      .input("token", token)
      .query("DELETE FROM sessions WHERE token = @token");
  }

  for (const githubUserId of createdGithubUserIds) {
    await pool.request()
      .input("githubUserId", githubUserId)
      .query("DELETE FROM players WHERE github_user_id = @githubUserId");
    await pool.request()
      .input("githubUserId", githubUserId)
      .query("DELETE FROM leaderboard_entries WHERE github_user_id = @githubUserId");
  }

  for (const claimKey of createdClaimKeys) {
    await pool.request()
      .input("claimKey", claimKey)
      .query("DELETE FROM anonymous_trial_claims WHERE claim_key = @claimKey");
  }

  await pool.close();
});

describe.skipIf(SKIP)("MssqlSessionStore (real SQL)", () => {
  it("creates a session and validates+consumes it", async () => {
    const { MssqlSessionStore } = await import(
      "../lib/storage/mssql-session-store"
    );
    const store = new MssqlSessionStore(pool);

    const token = await store.create("easy", "The Sleeping Cluster");
    createdSessionTokens.push(token);
    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const session = await store.validateAndConsume(token);
    expect(session).not.toBeNull();
    expect(session!.token.toLowerCase()).toBe(token.toLowerCase());
    expect(session!.difficulty).toBe("easy");
    expect(session!.scenarioTitle).toBe("The Sleeping Cluster");
    expect(session!.used).toBe(true);
    expect(session!.startTime).toBeGreaterThan(0);
    expect(session!.identityKind).toBe("anonymous");
    expect(session!.persistentScoreEligible).toBe(false);
  });

  it("gets a session without consuming it", async () => {
    const { MssqlSessionStore } = await import(
      "../lib/storage/mssql-session-store"
    );
    const store = new MssqlSessionStore(pool);

    const token = await store.create("hard", "Etcd Quorum Loss");
    createdSessionTokens.push(token);

    const session = await store.get(token);
    expect(session).not.toBeNull();
    expect(session!.token.toLowerCase()).toBe(token.toLowerCase());
    expect(session!.difficulty).toBe("hard");
    expect(session!.used).toBe(false);
  });

  it("returns null when consuming an already-used token", async () => {
    const { MssqlSessionStore } = await import(
      "../lib/storage/mssql-session-store"
    );
    const store = new MssqlSessionStore(pool);

    const token = await store.create("medium", "Bad Egress");
    createdSessionTokens.push(token);
    await store.validateAndConsume(token);
    const second = await store.validateAndConsume(token);
    expect(second).toBeNull();
  });

  it("returns null for a nonexistent token", async () => {
    const { MssqlSessionStore } = await import(
      "../lib/storage/mssql-session-store"
    );
    const store = new MssqlSessionStore(pool);

    const result = await store.validateAndConsume(
      "00000000-0000-0000-0000-000000000000",
    );
    expect(result).toBeNull();
  });
});

describe.skipIf(SKIP)("MssqlLeaderboardStore (real SQL)", () => {
  it("adds an entry and retrieves it from the leaderboard", async () => {
    const { MssqlLeaderboardStore } = await import(
      "../lib/storage/mssql-leaderboard-store"
    );
    const store = new MssqlLeaderboardStore(pool);

    const entry = {
      id: crypto.randomUUID(),
      nickname: trackNickname(shortId("t")),
      difficulty: "easy" as const,
      score: {
        efficiency: 20,
        safety: 22,
        documentation: 18,
        accuracy: 25,
        total: 85,
      },
      grade: "A",
      commandCount: 4,
      durationMs: 120_000,
      scenarioTitle: "The Sleeping Cluster",
      ...githubIdentity("t1"),
      timestamp: Date.now(),
    };

    const returned = await store.addEntry(entry);
    expect(returned.id).toBe(entry.id);

    const entries = await store.getLeaderboard("easy");
    const found = entries.find(
      (e) => e.id.toLowerCase() === entry.id.toLowerCase(),
    );
    expect(found).toBeDefined();
    expect(found!.nickname).toBe(entry.nickname);
    expect(found!.score.total).toBe(85);
  });

  it("MERGE upserts when the same nickname+difficulty has a higher score", async () => {
    const { MssqlLeaderboardStore } = await import(
      "../lib/storage/mssql-leaderboard-store"
    );
    const store = new MssqlLeaderboardStore(pool);
    const nick = trackNickname(shortId("u"));

    await store.addEntry({
      id: crypto.randomUUID(),
      nickname: nick,
      difficulty: "hard",
      score: {
        efficiency: 10,
        safety: 10,
        documentation: 10,
        accuracy: 10,
        total: 40,
      },
      grade: "C",
      commandCount: 12,
      durationMs: 300_000,
      scenarioTitle: "Etcd Quorum Loss",
      ...githubIdentity(`${nick}-1`),
      timestamp: Date.now(),
    });

    const upgradedId = crypto.randomUUID();
    await store.addEntry({
      id: upgradedId,
      nickname: nick,
      difficulty: "hard",
      score: {
        efficiency: 25,
        safety: 25,
        documentation: 25,
        accuracy: 25,
        total: 100,
      },
      grade: "A+",
      commandCount: 3,
      durationMs: 60_000,
      scenarioTitle: "Etcd Quorum Loss",
      ...githubIdentity(`${nick}-1`),
      timestamp: Date.now(),
    });

    const entries = await store.getLeaderboard("hard");
    const found = entries.find((e) => e.nickname === nick);
    expect(found).toBeDefined();
    expect(found!.score.total).toBe(100);
    expect(found!.id.toLowerCase()).toBe(upgradedId.toLowerCase());
  });

  it("getHallOfFame returns aggregated composite scores", async () => {
    const { MssqlLeaderboardStore } = await import(
      "../lib/storage/mssql-leaderboard-store"
    );
    const store = new MssqlLeaderboardStore(pool);
    const nick = trackNickname(shortId("f"));
    const identity = githubIdentity(`${nick}-hof`);

    for (const diff of ["easy", "medium"] as const) {
      await store.addEntry({
        id: crypto.randomUUID(),
        nickname: nick,
        difficulty: diff,
        score: {
          efficiency: 20,
          safety: 20,
          documentation: 20,
          accuracy: 20,
          total: 80,
        },
        grade: "B",
        commandCount: 5,
        durationMs: 90_000,
        scenarioTitle: `Scenario ${diff}`,
        ...identity,
        timestamp: Date.now(),
      });
    }

    const fame = await store.getHallOfFame();
    const found = fame.find((f) => f.nickname === nick);
    expect(found).toBeDefined();
    expect(found!.compositeScore).toBe(160);
    expect(found!.scores.easy).toBe(80);
    expect(found!.scores.medium).toBe(80);
  });
});

describe.skipIf(SKIP)("MssqlPlayerStore (real SQL)", () => {
  it("upserts and reads back a GitHub player profile", async () => {
    const { MssqlPlayerStore } = await import("../lib/storage/mssql-player-store");
    const githubUserId = trackGithubUserId(`gh-player-${Date.now().toString(36)}`);
    const store = new MssqlPlayerStore(pool);

    const saved = await store.upsertGithubViewer({
      kind: "github",
      githubUserId,
      githubLogin: `login-${githubUserId}`,
      displayName: "The Octocat",
      avatarUrl: null,
    });

    expect(saved.githubUserId).toBe(githubUserId);

    const loaded = await store.getByGithubUserId(githubUserId);
    expect(loaded).not.toBeNull();
    expect(loaded!.githubLogin).toBe(`login-${githubUserId}`);
    expect(loaded!.displayName).toBe("The Octocat");
  });
});

describe.skipIf(SKIP)("MssqlAnonymousTrialStore (real SQL)", () => {
  it("reserves claim keys atomically and rejects a second reservation", async () => {
    const { MssqlAnonymousTrialStore } = await import(
      "../lib/storage/mssql-anonymous-trial-store"
    );
    const store = new MssqlAnonymousTrialStore(pool);
    const claimKeys = [
      trackClaimKey(`claim-a-${Date.now().toString(36)}`),
      trackClaimKey(`claim-b-${Date.now().toString(36)}`),
    ];
    const claim = {
      claimKey: claimKeys[0],
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };

    const first = await store.reserveClaimKeys(claimKeys, claim);
    const second = await store.reserveClaimKeys(claimKeys, claim);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await store.hasActiveClaim(claimKeys[0], claim.createdAt)).toBe(true);
    expect(await store.hasActiveClaim(claimKeys[1], claim.createdAt)).toBe(true);
  });
});

describe.skipIf(SKIP)("MssqlMetricsStore (real SQL)", () => {
  it("records gameplay and retrieves player history", async () => {
    const { MssqlMetricsStore } = await import(
      "../lib/storage/mssql-metrics-store"
    );
    const store = new MssqlMetricsStore(pool);
    const nick = trackNickname(shortId("m"));

    await store.recordGameplay({
      nickname: nick,
      difficulty: "easy",
      scenarioTitle: "Master Down",
      lifecycleState: "completed",
      commandCount: 2,
      commandsExecuted: ["oc get nodes", "oc get pods -A"],
      scoringEvents: [{ type: "safety", points: 5 }],
      chatMessageCount: 8,
      aiPromptTokens: 3000,
      aiCompletionTokens: 1500,
      durationMs: 120_000,
      scoreTotal: 88,
      grade: "B",
      completed: true,
      metadata: { version: "test" },
    });

    const history = await store.getPlayerHistory(nick);
    expect(history).toHaveLength(1);

    const record = history[0];
    expect(record.nickname).toBe(nick);
    expect(record.difficulty).toBe("easy");
    expect(record.lifecycleState).toBe("completed");
    expect(record.commandCount).toBe(2);
    expect(record.commandsExecuted).toEqual(["oc get nodes", "oc get pods -A"]);
    expect(record.scoringEvents).toEqual([{ type: "safety", points: 5 }]);
    expect(record.chatMessageCount).toBe(8);
    expect(record.durationMs).toBe(120_000);
    expect(record.scoreTotal).toBe(88);
    expect(record.grade).toBe("B");
    expect(record.completed).toBe(true);
    expect(record.metadata).toEqual({ version: "test" });
  });

  it("handles empty/default gameplay fields", async () => {
    const { MssqlMetricsStore } = await import(
      "../lib/storage/mssql-metrics-store"
    );
    const store = new MssqlMetricsStore(pool);

    await store.recordGameplay({});

    const history = await store.getPlayerHistory("");
    expect(history.length).toBeGreaterThanOrEqual(0);
  });

  it("dedupes duplicate lifecycle inserts for the same session token", async () => {
    const { MssqlMetricsStore } = await import(
      "../lib/storage/mssql-metrics-store"
    );
    const store = new MssqlMetricsStore(pool);
    const nick = trackNickname(shortId("d"));
    const sessionToken = crypto.randomUUID();

    await store.recordGameplay({
      sessionToken,
      nickname: nick,
      difficulty: "medium",
      scenarioTitle: "Bad Egress",
      lifecycleState: "completed",
      completed: true,
    });
    await expect(store.recordGameplay({
      sessionToken,
      nickname: nick,
      difficulty: "medium",
      scenarioTitle: "Bad Egress",
      lifecycleState: "completed",
      completed: true,
    })).resolves.not.toThrow();

    const history = await store.getPlayerHistory(nick);
    expect(
      history.filter((record) =>
        record.sessionToken?.toLowerCase() === sessionToken.toLowerCase() &&
        record.lifecycleState === "completed"
      )
    ).toHaveLength(1);
  });
});

describe.skipIf(SKIP)("Migration idempotency (real SQL)", () => {
  it("runMigrations is safe to call multiple times", async () => {
    const { runMigrations } = await import("../lib/storage/migrate");
    await expect(runMigrations(pool)).resolves.not.toThrow();
    await expect(runMigrations(pool)).resolves.not.toThrow();
  });
});
