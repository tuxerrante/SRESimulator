import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type {
  IAnonymousTrialStore,
  ILeaderboardStore,
  IMetricsStore,
  IPlayerStore,
  ISessionStore,
} from "../lib/storage/types";

/**
 * The behavioural contract every SQL storage backend must satisfy, run against
 * a real server.
 *
 * This exists because the Postgres schema is a *consolidated* baseline rather
 * than a file-for-file translation of the T-SQL lineage, so line-by-line SQL
 * review cannot prove the two backends agree. Running the same assertions
 * against both can. Anything asserted here is a cross-backend guarantee;
 * anything backend-specific belongs in that backend's own test file.
 */

export interface StoreContractStores {
  sessions: ISessionStore;
  leaderboard: ILeaderboardStore;
  metrics: IMetricsStore;
  players: IPlayerStore;
  anonymousTrials: IAnonymousTrialStore;
}

/**
 * Rows the suite created, for the driver to delete. Integration runs share a
 * database with whatever else is in it, so cleanup is by tracked key rather
 * than by truncation.
 */
export interface StoreContractTracker {
  sessionTokens: string[];
  nicknames: string[];
  githubUserIds: string[];
  claimKeys: string[];
}

export interface StoreContractDriver {
  /** Appears in every describe block, so a failure names its backend. */
  backendName: string;
  /** True when this backend is not the one under test in this run. */
  skip: boolean;
  /** Connect, migrate, and hand back the stores. */
  setup(): Promise<StoreContractStores>;
  /** Called twice in a row to prove the migration runner is idempotent. */
  runMigrations(): Promise<void>;
  /** Delete the tracked rows, then close the pool. */
  teardown(tracked: StoreContractTracker): Promise<void>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * MSSQL returns UNIQUEIDENTIFIER uppercased and Postgres returns uuid
 * lowercased. Both are the same value, so every identifier comparison in this
 * suite folds case rather than asserting one backend's spelling.
 */
function sameId(a: string | undefined, b: string): boolean {
  return a?.toLowerCase() === b.toLowerCase();
}

export function runStoreContractSuite(driver: StoreContractDriver): void {
  const { backendName, skip } = driver;

  const tracked: StoreContractTracker = {
    sessionTokens: [],
    nicknames: [],
    githubUserIds: [],
    claimKeys: [],
  };

  let stores: StoreContractStores;

  function shortId(prefix: string): string {
    const suffix = Date.now().toString(36).slice(-6);
    return `${prefix}${suffix}`.slice(0, 20);
  }

  function trackNickname(nick: string): string {
    tracked.nicknames.push(nick);
    return nick;
  }

  function trackGithubUserId(githubUserId: string): string {
    tracked.githubUserIds.push(githubUserId);
    return githubUserId;
  }

  function trackClaimKey(claimKey: string): string {
    tracked.claimKeys.push(claimKey);
    return claimKey;
  }

  function githubIdentity(seed: string) {
    const githubUserId = trackGithubUserId(`gh-${seed}`.slice(0, 64));
    return {
      identityKind: "github" as const,
      githubUserId,
      githubLogin: `login-${seed}`.slice(0, 255),
    };
  }

  beforeAll(async () => {
    if (skip) return;
    stores = await driver.setup();
  });

  afterAll(async () => {
    if (skip) return;
    await driver.teardown(tracked);
  });

  describe.skipIf(skip)(`${backendName} session store (real SQL)`, () => {
    it("creates a session and validates+consumes it", async () => {
      const token = await stores.sessions.create("easy", "The Sleeping Cluster", "automated");
      tracked.sessionTokens.push(token);
      expect(token).toMatch(UUID_RE);

      const session = await stores.sessions.validateAndConsume(token);
      expect(session).not.toBeNull();
      expect(sameId(session!.token, token)).toBe(true);
      expect(session!.difficulty).toBe("easy");
      expect(session!.scenarioTitle).toBe("The Sleeping Cluster");
      expect(session!.used).toBe(true);
      expect(session!.startTime).toBeGreaterThan(0);
      expect(session!.identityKind).toBe("anonymous");
      expect(session!.persistentScoreEligible).toBe(false);
    });

    it("gets a session without consuming it", async () => {
      const token = await stores.sessions.create("hard", "Etcd Quorum Loss");
      tracked.sessionTokens.push(token);

      const session = await stores.sessions.get(token);
      expect(session).not.toBeNull();
      expect(sameId(session!.token, token)).toBe(true);
      expect(session!.difficulty).toBe("hard");
      expect(session!.used).toBe(false);
    });

    it("returns null when consuming an already-used token", async () => {
      const token = await stores.sessions.create("medium", "Bad Egress");
      tracked.sessionTokens.push(token);
      await stores.sessions.validateAndConsume(token);
      const second = await stores.sessions.validateAndConsume(token);
      expect(second).toBeNull();
    });

    it("returns null for a nonexistent token", async () => {
      const result = await stores.sessions.validateAndConsume(
        "00000000-0000-0000-0000-000000000000",
      );
      expect(result).toBeNull();
    });

    it("returns null for a token that is not a UUID at all", async () => {
      // Postgres raises 22P02 for a malformed uuid where MSSQL returns no rows,
      // so this is the assertion that keeps the two backends interchangeable
      // for a caller passing through an attacker-supplied token.
      await expect(stores.sessions.get("' OR 1=1 --")).resolves.toBeNull();
      await expect(stores.sessions.validateAndConsume("not-a-uuid")).resolves.toBeNull();
    });

    it("round-trips a GitHub-backed session with its identity columns", async () => {
      const identity = githubIdentity(shortId("sess"));
      const token = await stores.sessions.create({
        platform: "aks",
        difficulty: "medium",
        scenarioId: "scn-contract",
        scenarioTitle: "Permission Drift",
        scenarioPayload: JSON.stringify({ seeded: true }),
        ...identity,
        persistentScoreEligible: true,
      });
      tracked.sessionTokens.push(token);

      const session = await stores.sessions.get(token);
      expect(session).not.toBeNull();
      expect(session!.platform).toBe("aks");
      expect(session!.scenarioId).toBe("scn-contract");
      expect(session!.scenarioPayload).toBe(JSON.stringify({ seeded: true }));
      expect(session!.identityKind).toBe("github");
      expect(session!.githubUserId).toBe(identity.githubUserId);
      expect(session!.githubLogin).toBe(identity.githubLogin);
      // BOOLEAN on Postgres, BIT on MSSQL; both must surface as a JS boolean.
      expect(session!.persistentScoreEligible).toBe(true);
    });
  });

  describe.skipIf(skip)(`${backendName} leaderboard store (real SQL)`, () => {
    it("adds an entry and retrieves it from the leaderboard", async () => {
      const entry = {
        id: crypto.randomUUID(),
        nickname: trackNickname(shortId("t")),
        platform: "aro-classic" as const,
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
        ...githubIdentity(shortId("t1")),
        timestamp: Date.now(),
      };

      const returned = await stores.leaderboard.addEntry(entry);
      expect(returned.id).toBe(entry.id);

      const entries = await stores.leaderboard.getLeaderboard({ difficulty: "easy" });
      const found = entries.find((e) => sameId(e.id, entry.id));
      expect(found).toBeDefined();
      expect(found!.nickname).toBe(entry.nickname);
      expect(found!.score.total).toBe(85);
      expect(found!.trafficSource).toBe("player");
      // BIGINT arrives as a string from `pg`, so this is a real coercion check.
      expect(found!.durationMs).toBe(120_000);
    });

    it("upserts when the same identity posts a higher score", async () => {
      const nick = trackNickname(shortId("u"));
      const identity = githubIdentity(shortId("u1"));

      await stores.leaderboard.addEntry({
        id: crypto.randomUUID(),
        nickname: nick,
        platform: "aro-classic",
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
        ...identity,
        timestamp: Date.now(),
      });

      const upgradedId = crypto.randomUUID();
      await stores.leaderboard.addEntry({
        id: upgradedId,
        nickname: nick,
        platform: "aro-classic",
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
        ...identity,
        timestamp: Date.now(),
      });

      const entries = await stores.leaderboard.getLeaderboard({ difficulty: "hard" });
      const found = entries.find((e) => e.nickname === nick);
      expect(found).toBeDefined();
      expect(found!.score.total).toBe(100);
      expect(sameId(found!.id, upgradedId)).toBe(true);
    });

    it("keeps the better score when a lower one is posted afterwards", async () => {
      const nick = trackNickname(shortId("keep"));
      const identity = githubIdentity(shortId("k1"));

      const bestId = crypto.randomUUID();
      await stores.leaderboard.addEntry({
        id: bestId,
        nickname: nick,
        platform: "aks",
        difficulty: "medium",
        score: { efficiency: 25, safety: 25, documentation: 25, accuracy: 25, total: 100 },
        grade: "A+",
        commandCount: 3,
        durationMs: 60_000,
        scenarioTitle: "Bad Egress",
        ...identity,
        timestamp: Date.now(),
      });

      await stores.leaderboard.addEntry({
        id: crypto.randomUUID(),
        nickname: nick,
        platform: "aks",
        difficulty: "medium",
        score: { efficiency: 5, safety: 5, documentation: 5, accuracy: 5, total: 20 },
        grade: "D",
        commandCount: 30,
        durationMs: 600_000,
        scenarioTitle: "Bad Egress",
        ...identity,
        timestamp: Date.now(),
      });

      // The conditional upsert is the part most easily lost in translation:
      // a plain DO UPDATE would happily overwrite a personal best with a worse
      // run, and nothing would error.
      const entries = await stores.leaderboard.getLeaderboard({
        difficulty: "medium",
        platform: "aks",
      });
      const found = entries.find((e) => e.nickname === nick);
      expect(found).toBeDefined();
      expect(found!.score.total).toBe(100);
      expect(sameId(found!.id, bestId)).toBe(true);
    });

    it("getHallOfFame returns aggregated composite scores", async () => {
      const nick = trackNickname(shortId("f"));
      const identity = githubIdentity(shortId("hof"));

      for (const diff of ["easy", "medium"] as const) {
        await stores.leaderboard.addEntry({
          id: crypto.randomUUID(),
          nickname: nick,
          platform: "aro-classic",
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

      const fame = await stores.leaderboard.getHallOfFame("aro-classic");
      const found = fame.find((f) => f.nickname === nick);
      expect(found).toBeDefined();
      expect(found!.compositeScore).toBe(160);
      expect(found!.scores.easy).toBe(80);
      expect(found!.scores.medium).toBe(80);
    });

    it("keeps automated and player rows separate for the same nickname and difficulty", async () => {
      const nick = trackNickname(shortId("mix"));
      const automatedIdentity = githubIdentity(shortId("auto"));
      const playerIdentity = githubIdentity(shortId("play"));

      await stores.leaderboard.addEntry({
        id: crypto.randomUUID(),
        nickname: nick,
        platform: "aro-classic",
        difficulty: "hard",
        score: {
          efficiency: 25,
          safety: 25,
          documentation: 25,
          accuracy: 25,
          total: 100,
        },
        grade: "A+",
        commandCount: 1,
        durationMs: 30_000,
        scenarioTitle: "Etcd Quorum Loss",
        trafficSource: "automated",
        ...automatedIdentity,
        timestamp: Date.now(),
      });

      await stores.leaderboard.addEntry({
        id: crypto.randomUUID(),
        nickname: nick,
        platform: "aro-classic",
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
        trafficSource: "player",
        ...playerIdentity,
        timestamp: Date.now(),
      });

      const entries = await stores.leaderboard.getLeaderboard({ difficulty: "hard" });
      const found = entries.find((e) => e.nickname === nick);
      expect(found).toBeDefined();
      expect(found!.trafficSource).toBe("player");
      expect(found!.score.total).toBe(40);
    });
  });

  describe.skipIf(skip)(`${backendName} player store (real SQL)`, () => {
    it("upserts and reads back a GitHub player profile", async () => {
      const githubUserId = trackGithubUserId(`gh-player-${Date.now().toString(36)}`);

      const saved = await stores.players.upsertGithubViewer({
        kind: "github",
        githubUserId,
        githubLogin: `login-${githubUserId}`,
        displayName: "The Octocat",
        avatarUrl: null,
      });

      expect(saved.githubUserId).toBe(githubUserId);

      const loaded = await stores.players.getByGithubUserId(githubUserId);
      expect(loaded).not.toBeNull();
      expect(loaded!.githubLogin).toBe(`login-${githubUserId}`);
      expect(loaded!.displayName).toBe("The Octocat");
    });

    it("overwrites the profile on a second upsert", async () => {
      const githubUserId = trackGithubUserId(`gh-rename-${Date.now().toString(36)}`);

      await stores.players.upsertGithubViewer({
        kind: "github",
        githubUserId,
        githubLogin: "before",
        displayName: "Before",
        avatarUrl: null,
      });
      await stores.players.upsertGithubViewer({
        kind: "github",
        githubUserId,
        githubLogin: "after",
        displayName: "After",
        avatarUrl: "https://example.invalid/a.png",
      });

      const loaded = await stores.players.getByGithubUserId(githubUserId);
      expect(loaded!.githubLogin).toBe("after");
      expect(loaded!.displayName).toBe("After");
      expect(loaded!.avatarUrl).toBe("https://example.invalid/a.png");
    });

    it("returns null for an unknown player", async () => {
      await expect(
        stores.players.getByGithubUserId(`gh-absent-${Date.now().toString(36)}`),
      ).resolves.toBeNull();
    });
  });

  describe.skipIf(skip)(`${backendName} anonymous trial store (real SQL)`, () => {
    it("reserves claim keys atomically and rejects a second reservation", async () => {
      const claimKeys = [
        trackClaimKey(`claim-a-${Date.now().toString(36)}`),
        trackClaimKey(`claim-b-${Date.now().toString(36)}`),
      ];
      const claim = {
        claimKey: claimKeys[0],
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };

      const first = await stores.anonymousTrials.reserveClaimKeys(claimKeys, claim);
      const second = await stores.anonymousTrials.reserveClaimKeys(claimKeys, claim);

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(await stores.anonymousTrials.hasActiveClaim(claimKeys[0], claim.createdAt)).toBe(true);
      expect(await stores.anonymousTrials.hasActiveClaim(claimKeys[1], claim.createdAt)).toBe(true);
    });

    it("does not leave a partial reservation behind when one key is taken", async () => {
      const stamp = Date.now().toString(36);
      const taken = trackClaimKey(`claim-taken-${stamp}`);
      const free = trackClaimKey(`claim-free-${stamp}`);
      const claim = { claimKey: taken, createdAt: Date.now(), expiresAt: Date.now() + 60_000 };

      expect(await stores.anonymousTrials.reserveClaimKeys([taken], claim)).toBe(true);
      expect(await stores.anonymousTrials.reserveClaimKeys([taken, free], claim)).toBe(false);

      // All-or-nothing: the caller was told no, so `free` must still be free.
      // Without a transaction around the upsert this leaks a claim on every
      // partially-contended request.
      expect(await stores.anonymousTrials.hasActiveClaim(free, claim.createdAt)).toBe(false);
    });

    it("lets an expired claim be reserved again", async () => {
      const key = trackClaimKey(`claim-exp-${Date.now().toString(36)}`);
      const now = Date.now();

      expect(
        await stores.anonymousTrials.reserveClaimKeys([key], {
          claimKey: key,
          createdAt: now - 120_000,
          expiresAt: now - 60_000,
        }),
      ).toBe(true);
      expect(await stores.anonymousTrials.hasActiveClaim(key, now)).toBe(false);
      expect(
        await stores.anonymousTrials.reserveClaimKeys([key], {
          claimKey: key,
          createdAt: now,
          expiresAt: now + 60_000,
        }),
      ).toBe(true);
    });

    it("releases claim keys", async () => {
      const key = trackClaimKey(`claim-rel-${Date.now().toString(36)}`);
      const claim = { claimKey: key, createdAt: Date.now(), expiresAt: Date.now() + 60_000 };

      await stores.anonymousTrials.createOrRefreshClaim(claim);
      expect(await stores.anonymousTrials.hasActiveClaim(key, claim.createdAt)).toBe(true);

      await stores.anonymousTrials.releaseClaimKeys([key]);
      expect(await stores.anonymousTrials.hasActiveClaim(key, claim.createdAt)).toBe(false);
    });
  });

  describe.skipIf(skip)(`${backendName} metrics store (real SQL)`, () => {
    it("records gameplay and retrieves player history", async () => {
      const nick = trackNickname(shortId("m"));

      await stores.metrics.recordGameplay({
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
        trafficSource: "automated",
        metadata: { version: "test" },
      });

      const history = await stores.metrics.getPlayerHistory(nick);
      expect(history).toHaveLength(1);

      const record = history[0];
      expect(record.nickname).toBe(nick);
      expect(record.difficulty).toBe("easy");
      expect(record.lifecycleState).toBe("completed");
      expect(record.commandCount).toBe(2);
      // JSON round trip: `nvarchar(max)` on MSSQL, `jsonb` on Postgres, which
      // the driver hands back already parsed.
      expect(record.commandsExecuted).toEqual(["oc get nodes", "oc get pods -A"]);
      expect(record.scoringEvents).toEqual([{ type: "safety", points: 5 }]);
      expect(record.chatMessageCount).toBe(8);
      expect(record.durationMs).toBe(120_000);
      expect(record.scoreTotal).toBe(88);
      expect(record.grade).toBe("B");
      expect(record.completed).toBe(true);
      expect(record.trafficSource).toBe("automated");
      expect(record.metadata).toEqual({ version: "test" });
    });

    it("handles empty/default gameplay fields", async () => {
      await stores.metrics.recordGameplay({});

      const history = await stores.metrics.getPlayerHistory("");
      expect(history.length).toBeGreaterThanOrEqual(0);
    });

    it("dedupes duplicate lifecycle inserts for the same session token", async () => {
      const nick = trackNickname(shortId("d"));
      const sessionToken = await stores.sessions.create("medium", "Bad Egress");
      tracked.sessionTokens.push(sessionToken);

      const event = {
        sessionToken,
        nickname: nick,
        difficulty: "medium" as const,
        scenarioTitle: "Bad Egress",
        lifecycleState: "completed" as const,
        completed: true,
      };

      await stores.metrics.recordGameplay(event);
      await expect(stores.metrics.recordGameplay(event)).resolves.not.toThrow();

      const history = await stores.metrics.getPlayerHistory(nick);
      expect(
        history.filter(
          (record) =>
            sameId(record.sessionToken, sessionToken) &&
            record.lifecycleState === "completed",
        ),
      ).toHaveLength(1);
    });

    it("reports lifecycle events and the latest row for a session", async () => {
      const nick = trackNickname(shortId("lc"));
      const sessionToken = await stores.sessions.create("easy", "Invalid SKU");
      tracked.sessionTokens.push(sessionToken);

      await stores.metrics.recordGameplay({
        sessionToken,
        nickname: nick,
        difficulty: "easy",
        scenarioTitle: "Invalid SKU",
        lifecycleState: "started",
      });

      expect(await stores.metrics.hasLifecycleEvent(sessionToken, "started")).toBe(true);
      expect(await stores.metrics.hasLifecycleEvent(sessionToken, "completed")).toBe(false);
      expect(await stores.metrics.getLatestCompletedBySessionToken(sessionToken)).toBeNull();

      await stores.metrics.recordGameplay({
        sessionToken,
        nickname: nick,
        difficulty: "easy",
        scenarioTitle: "Invalid SKU",
        lifecycleState: "completed",
        scoreTotal: 77,
        grade: "C",
        completed: true,
      });

      // A terminal state outranks `started` regardless of insertion order, so
      // this is an ordering assertion, not just a "latest row" one.
      const latest = await stores.metrics.getLatestBySessionToken(sessionToken);
      expect(latest).not.toBeNull();
      expect(latest!.lifecycleState).toBe("completed");
      expect(latest!.scoreTotal).toBe(77);

      const completed = await stores.metrics.getLatestCompletedBySessionToken(sessionToken);
      expect(completed).not.toBeNull();
      expect(completed!.grade).toBe("C");
    });

    it("returns null for a session with no recorded gameplay", async () => {
      const sessionToken = await stores.sessions.create("hard", "The Partition Hang");
      tracked.sessionTokens.push(sessionToken);

      expect(await stores.metrics.getLatestBySessionToken(sessionToken)).toBeNull();
      expect(await stores.metrics.getLatestCompletedBySessionToken(sessionToken)).toBeNull();
      expect(await stores.metrics.hasLifecycleEvent(sessionToken, "started")).toBe(false);
    });

    it("builds gameplay analytics with rates and an ISO-8601 timestamp", async () => {
      const nick = trackNickname(shortId("an"));
      const sessionToken = await stores.sessions.create("easy", "Master Down");
      tracked.sessionTokens.push(sessionToken);

      await stores.metrics.recordGameplay({
        sessionToken,
        platform: "aks",
        nickname: nick,
        difficulty: "easy",
        scenarioTitle: "Master Down",
        lifecycleState: "completed",
        trafficSource: "player",
        commandCount: 4,
        chatMessageCount: 2,
        durationMs: 60_000,
        scoreTotal: 70,
        grade: "B",
        completed: true,
      });

      const analytics = await stores.metrics.getGameplayAnalytics({ platform: "aks" });

      expect(analytics.summary.totalSessions).toBeGreaterThanOrEqual(1);
      expect(analytics.summary.completedSessions).toBeGreaterThanOrEqual(1);
      expect(analytics.summary.completionRate).toBeGreaterThan(0);
      expect(analytics.byPlatform.every((row) => row.platform === "aks")).toBe(true);

      const recent = analytics.recentSessions.find((row) => row.nickname === nick);
      expect(recent).toBeDefined();
      // Rendered by `to_char` on Postgres and `toISOString()` on MSSQL; the
      // frontend parses it, so the two must agree on the exact format.
      expect(recent!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(Number.isNaN(Date.parse(recent!.createdAt))).toBe(false);
    });

    it("excludes automated traffic from analytics", async () => {
      const nick = trackNickname(shortId("bot"));
      const sessionToken = await stores.sessions.create("hard", "Cosmos DB Flood", "automated");
      tracked.sessionTokens.push(sessionToken);

      await stores.metrics.recordGameplay({
        sessionToken,
        platform: "aro-hcp",
        nickname: nick,
        difficulty: "hard",
        scenarioTitle: "Cosmos DB Flood",
        lifecycleState: "completed",
        trafficSource: "automated",
        completed: true,
      });

      const analytics = await stores.metrics.getGameplayAnalytics();
      expect(analytics.recentSessions.some((row) => row.nickname === nick)).toBe(false);
    });
  });

  describe.skipIf(skip)(`${backendName} migration idempotency (real SQL)`, () => {
    it("the migration runner is safe to call multiple times", async () => {
      await expect(driver.runMigrations()).resolves.not.toThrow();
      await expect(driver.runMigrations()).resolves.not.toThrow();
    });
  });
}
