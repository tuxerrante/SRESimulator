import { describe, expect, it, vi, beforeEach } from "vitest";
import { PgSessionStore } from "./pg-session-store";
import { PgLeaderboardStore } from "./pg-leaderboard-store";
import { PgMetricsStore } from "./pg-metrics-store";
import { PgPlayerStore } from "./pg-player-store";
import { PgAnonymousTrialStore, type PgTransactional } from "./pg-anonymous-trial-store";
import type { GithubViewer } from "../../../../shared/auth/viewer";

interface RecordedQuery {
  text: string;
  values: unknown[];
}

/**
 * Every query this suite provokes is checked for placeholder/value agreement.
 *
 * `$n` is positional, so a mismatch between the highest placeholder and the
 * length of the values array is the characteristic failure of a port away from
 * named `@parameters` — and it is invisible to the type checker, because both
 * sides are just `unknown[]` and a template string.
 */
function assertPlaceholdersLineUp({ text, values }: RecordedQuery): void {
  const referenced = new Set(
    [...text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])),
  );

  if (referenced.size === 0) {
    expect(values).toEqual([]);
    return;
  }

  const highest = Math.max(...referenced);

  // A gap (`$1`, `$3`, no `$2`) means a parameter was dropped during editing
  // and every later value silently shifted into the wrong column.
  for (let i = 1; i <= highest; i += 1) {
    expect(
      referenced.has(i),
      `query references $${highest} but not $${i}:\n${text}`,
    ).toBe(true);
  }

  expect(
    values.length,
    `query references $1..$${highest} but was given ${values.length} value(s):\n${text}`,
  ).toBe(highest);
}

function createFakePool(results: unknown[][] = []) {
  const queries: RecordedQuery[] = [];
  const queued = [...results];

  const query = vi.fn(async (text: string, values?: unknown[]) => {
    queries.push({ text, values: values ?? [] });
    const rows = queued.shift() ?? [];
    return { rows, rowCount: rows.length };
  });

  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));

  const pool = { query, connect } as unknown as PgTransactional;

  return { pool, query, queries, connect, release };
}

/** Fails the test if any query issued so far has mismatched placeholders. */
function expectEveryQueryWellFormed(queries: RecordedQuery[]): void {
  expect(queries.length).toBeGreaterThan(0);
  for (const recorded of queries) {
    assertPlaceholdersLineUp(recorded);
  }
}

const SESSION_ROW = {
  token: "11111111-2222-3333-4444-555555555555",
  platform: "aro-classic",
  difficulty: "easy",
  scenario_id: "scn-1",
  scenario_title: "The Sleeping Cluster",
  scenario_payload: null,
  // BIGINT arrives from `pg` as a string; the mapper has to coerce it.
  start_time: "1737000000000",
  used: false,
  traffic_source: "player",
  identity_kind: "anonymous",
  github_user_id: null,
  github_login: null,
  anonymous_claim_key: null,
  persistent_score_eligible: false,
};

describe("PgSessionStore", () => {
  it("create() inserts a row and returns a UUID token", async () => {
    const { pool, queries } = createFakePool();
    const store = new PgSessionStore(pool);

    const token = await store.create("easy", "Test Scenario");

    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const insert = queries[0];
    expect(insert.text).toContain("INSERT INTO sessions");
    expect(insert.values[0]).toBe(token);
    expect(insert.values[1]).toBe("aro-classic");
    expect(insert.values[2]).toBe("easy");
    expect(insert.values[4]).toBe("Test Scenario");
    expectEveryQueryWellFormed(queries);
  });

  it("create() passes persistentScoreEligible as a boolean, not 0/1", async () => {
    const { pool, queries } = createFakePool();
    const store = new PgSessionStore(pool);

    await store.create({
      platform: "aks",
      difficulty: "hard",
      scenarioTitle: "Etcd Quorum Loss",
      identityKind: "github",
      githubUserId: "12345",
      githubLogin: "octocat",
      persistentScoreEligible: true,
    });

    // MSSQL's BIT column takes 1/0; Postgres `boolean` rejects an integer, and
    // the failure only shows up at runtime against a real server.
    expect(queries[0].values[queries[0].values.length - 1]).toBe(true);
    expectEveryQueryWellFormed(queries);
  });

  it("get() maps a row and coerces the BIGINT start_time to a number", async () => {
    const { pool, queries } = createFakePool([[SESSION_ROW]]);
    const store = new PgSessionStore(pool);

    const session = await store.get(SESSION_ROW.token);

    expect(session).not.toBeNull();
    expect(session?.startTime).toBe(1737000000000);
    expect(typeof session?.startTime).toBe("number");
    expect(session?.persistentScoreEligible).toBe(false);
    expectEveryQueryWellFormed(queries);
  });

  it("get() refuses a malformed token without touching the database", async () => {
    const { pool, query } = createFakePool();
    const store = new PgSessionStore(pool);

    // Postgres raises 22P02 for a malformed uuid rather than returning no rows,
    // so an unguarded lookup would throw where MSSQL returned null.
    await expect(store.get("not-a-uuid")).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("validateAndConsume() claims the row in one UPDATE ... RETURNING", async () => {
    const { pool, queries } = createFakePool([[SESSION_ROW]]);
    const store = new PgSessionStore(pool);

    const session = await store.validateAndConsume(SESSION_ROW.token);

    expect(queries[0].text).toContain("UPDATE sessions");
    expect(queries[0].text).toContain("used = FALSE");
    expect(queries[0].text).toContain("RETURNING");
    expect(session?.used).toBe(true);
    expectEveryQueryWellFormed(queries);
  });

  it("validateAndConsume() returns null when the row was already used", async () => {
    const { pool } = createFakePool([[]]);
    const store = new PgSessionStore(pool);

    await expect(store.validateAndConsume(SESSION_ROW.token)).resolves.toBeNull();
  });
});

describe("PgLeaderboardStore", () => {
  const entry = {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    nickname: "octocat",
    platform: "aks" as const,
    difficulty: "medium" as const,
    score: { efficiency: 20, safety: 25, documentation: 15, accuracy: 30, total: 90 },
    grade: "A",
    commandCount: 7,
    durationMs: 120000,
    scenarioTitle: "Bad Egress",
    trafficSource: "player" as const,
    identityKind: "github" as const,
    githubUserId: "12345",
    githubLogin: "octocat",
    timestamp: 1737000000000,
  };

  it("addEntry() upserts with a conflict target that restates the index predicate", async () => {
    const { pool, queries } = createFakePool();
    const store = new PgLeaderboardStore(pool);

    await store.addEntry(entry);

    const upsert = queries[0].text;
    expect(upsert).toContain("ON CONFLICT (github_user_id, platform, difficulty, traffic_source)");
    // Without the predicate Postgres cannot infer the partial index and raises
    // "no unique or exclusion constraint matching the ON CONFLICT specification".
    expect(upsert).toContain("WHERE github_user_id IS NOT NULL");
    expect(upsert).toContain("EXCLUDED.score_total > leaderboard_entries.score_total");
    expectEveryQueryWellFormed(queries);
  });

  it("addEntry() trims the difficulty bucket after writing", async () => {
    const { pool, queries } = createFakePool();
    const store = new PgLeaderboardStore(pool);

    await store.addEntry(entry);

    expect(queries).toHaveLength(2);
    expect(queries[1].text).toContain("DELETE FROM leaderboard_entries");
    expect(queries[1].text).toContain("LIMIT $4");
    expect(queries[1].values).toEqual(["aks", "medium", "player", 10]);
  });

  it("addEntry() refuses an entry with no GitHub identity", async () => {
    const { pool, query } = createFakePool();
    const store = new PgLeaderboardStore(pool);

    await expect(
      store.addEntry({ ...entry, githubUserId: undefined, identityKind: undefined }),
    ).rejects.toThrow("GitHub-backed identity");
    expect(query).not.toHaveBeenCalled();
  });

  it("getLeaderboard() folds an absent difficulty into a NULL parameter", async () => {
    const { pool, queries } = createFakePool([[]]);
    const store = new PgLeaderboardStore(pool);

    await store.getLeaderboard({ platform: "aks" });

    expect(queries[0].text).toContain("($1::text IS NULL OR difficulty = $1)");
    expect(queries[0].values).toEqual([null, "aks", 10]);
    expectEveryQueryWellFormed(queries);
  });

  it("getHallOfFame() sums the per-difficulty bests into a composite", async () => {
    const { pool, queries } = createFakePool([
      [{ nickname: "octocat", easy: 80, medium: null, hard: 95, composite: "175" }],
    ]);
    const store = new PgLeaderboardStore(pool);

    const hall = await store.getHallOfFame("aks");

    expect(hall).toEqual([
      { nickname: "octocat", platform: "aks", compositeScore: 175, scores: { easy: 80, hard: 95 } },
    ]);
    expectEveryQueryWellFormed(queries);
  });
});

describe("PgPlayerStore", () => {
  const record = {
    githubUserId: "12345",
    githubLogin: "octocat",
    displayName: "The Octocat",
    avatarUrl: "https://example.invalid/a.png",
  };
  const viewer: GithubViewer = { kind: "github", ...record };

  it("upsertGithubViewer() translates MERGE into ON CONFLICT", async () => {
    const { pool, queries } = createFakePool();
    const store = new PgPlayerStore(pool);

    await expect(store.upsertGithubViewer(viewer)).resolves.toEqual(record);

    expect(queries[0].text).toContain("ON CONFLICT (github_user_id) DO UPDATE");
    expect(queries[0].text).toContain("updated_at = now()");
    expectEveryQueryWellFormed(queries);
  });

  it("getByGithubUserId() returns null for an unknown player", async () => {
    const { pool } = createFakePool([[]]);
    const store = new PgPlayerStore(pool);

    await expect(store.getByGithubUserId("404")).resolves.toBeNull();
  });
});

describe("PgAnonymousTrialStore", () => {
  const claim = { claimKey: "ip:1.2.3.4", createdAt: 1000, expiresAt: 2000 };

  it("reserveClaimKeys() commits when every key came back", async () => {
    const { pool, queries, release } = createFakePool([
      [], // BEGIN
      [{ claim_key: "a" }, { claim_key: "b" }],
      [], // COMMIT
    ]);
    const store = new PgAnonymousTrialStore(pool);

    await expect(store.reserveClaimKeys(["a", "b"], claim)).resolves.toBe(true);

    expect(queries.map((q) => q.text.trim().split(/\s/)[0])).toEqual([
      "BEGIN",
      "INSERT",
      "COMMIT",
    ]);
    // The conflict path re-evaluates against the latest row version under a row
    // lock, which is what makes the row count an honest answer.
    expect(queries[1].text).toContain("ON CONFLICT (claim_key) DO UPDATE");
    expect(queries[1].text).toContain("WHERE anonymous_trial_claims.expires_at_ts <= $2::bigint");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("reserveClaimKeys() rolls back a partial win rather than keeping it", async () => {
    const { pool, queries, release } = createFakePool([
      [],
      [{ claim_key: "a" }], // one of two keys
      [],
    ]);
    const store = new PgAnonymousTrialStore(pool);

    await expect(store.reserveClaimKeys(["a", "b"], claim)).resolves.toBe(false);

    // Without the rollback, "a" would stay claimed by a caller that was told no.
    expect(queries[queries.length - 1].text).toBe("ROLLBACK");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("reserveClaimKeys() releases the client when the statement throws", async () => {
    const release = vi.fn();
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockRejectedValueOnce(new Error("57P01"))
      .mockResolvedValue({ rows: [], rowCount: 0 }); // ROLLBACK
    const pool = {
      query,
      connect: vi.fn(async () => ({ query, release })),
    } as unknown as PgTransactional;
    const store = new PgAnonymousTrialStore(pool);

    await expect(store.reserveClaimKeys(["a"], claim)).rejects.toThrow("57P01");
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("reserveClaimKeys() short-circuits an empty key list", async () => {
    const { pool, connect } = createFakePool();
    const store = new PgAnonymousTrialStore(pool);

    await expect(store.reserveClaimKeys([], claim)).resolves.toBe(true);
    expect(connect).not.toHaveBeenCalled();
  });

  it("releaseClaimKeys() deletes with a single array parameter", async () => {
    const { pool, queries } = createFakePool();
    const store = new PgAnonymousTrialStore(pool);

    await store.releaseClaimKeys(["a", "b"]);

    expect(queries[0].text).toContain("claim_key = ANY($1::text[])");
    expect(queries[0].values).toEqual([["a", "b"]]);
    expectEveryQueryWellFormed(queries);
  });
});

describe("PgMetricsStore", () => {
  it("recordGameplay() serialises the three jsonb columns", async () => {
    const { pool, queries } = createFakePool();
    const store = new PgMetricsStore(pool);

    await store.recordGameplay({
      sessionToken: "11111111-2222-3333-4444-555555555555",
      platform: "aks",
      lifecycleState: "completed",
      commandsExecuted: ["oc get nodes"],
      scoringEvents: [{ kind: "safety" }],
      metadata: { source: "test" },
    });

    const values = queries[0].values;
    expect(values[8]).toBe(JSON.stringify(["oc get nodes"]));
    expect(values[9]).toBe(JSON.stringify([{ kind: "safety" }]));
    expect(values[values.length - 1]).toBe(JSON.stringify({ source: "test" }));
    expectEveryQueryWellFormed(queries);
  });

  it("recordGameplay() swallows only the duplicate-lifecycle unique violation", async () => {
    const duplicate = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "ux_gameplay_metrics_session_lifecycle",
    });
    const pool = {
      query: vi.fn().mockRejectedValue(duplicate),
      connect: vi.fn(),
    } as unknown as PgTransactional;

    await expect(
      new PgMetricsStore(pool).recordGameplay({ lifecycleState: "started" }),
    ).resolves.toBeUndefined();
  });

  it("recordGameplay() rethrows a unique violation on a different constraint", async () => {
    // The MSSQL classifier matched a message substring; naming the constraint
    // is what stops an unrelated 23505 from being silently discarded.
    const other = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "ux_leaderboard_entries_github_platform_difficulty_traffic",
    });
    const pool = {
      query: vi.fn().mockRejectedValue(other),
      connect: vi.fn(),
    } as unknown as PgTransactional;

    await expect(
      new PgMetricsStore(pool).recordGameplay({ lifecycleState: "started" }),
    ).rejects.toThrow("duplicate key");
  });

  it("recordGameplay() rethrows a non-unique-violation error", async () => {
    const boom = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    const pool = {
      query: vi.fn().mockRejectedValue(boom),
      connect: vi.fn(),
    } as unknown as PgTransactional;

    await expect(
      new PgMetricsStore(pool).recordGameplay({ lifecycleState: "started" }),
    ).rejects.toThrow("deadlock detected");
  });

  it("getLatestBySessionToken() prefers a terminal lifecycle row", async () => {
    const { pool, queries } = createFakePool([[]]);
    const store = new PgMetricsStore(pool);

    await store.getLatestBySessionToken("11111111-2222-3333-4444-555555555555");

    expect(queries[0].text).toContain(
      "CASE WHEN lifecycle_state IN ('completed', 'abandoned') THEN 1 ELSE 0 END DESC",
    );
    expect(queries[0].text).toContain("LIMIT 1");
    expectEveryQueryWellFormed(queries);
  });

  it("getPlayerHistory() parses jsonb columns however the driver returns them", async () => {
    const { pool } = createFakePool([
      [
        {
          id: "1",
          session_token: null,
          platform: "aks",
          traffic_source: "player",
          nickname: "octocat",
          difficulty: "easy",
          scenario_title: "The Sleeping Cluster",
          lifecycle_state: "completed",
          command_count: 2,
          // jsonb comes back parsed from `pg` ...
          commands_executed: ["oc get nodes"],
          // ... but the contract suite also runs against a driver that hands
          // back the raw string, so both shapes must map identically.
          scoring_events: '[{"kind":"safety"}]',
          chat_message_count: 3,
          ai_prompt_tokens: 10,
          ai_completion_tokens: 20,
          duration_ms: "120000",
          score_total: 90,
          grade: "A",
          completed: true,
          metadata: null,
          created_at: new Date("2026-09-18T00:00:00.000Z"),
        },
      ],
    ]);

    const [record] = await new PgMetricsStore(pool).getPlayerHistory("octocat");

    expect(record.commandsExecuted).toEqual(["oc get nodes"]);
    expect(record.scoringEvents).toEqual([{ kind: "safety" }]);
    expect(record.metadata).toEqual({});
    expect(record.durationMs).toBe(120000);
  });

  it("getGameplayAnalytics() issues one query and maps the json payload", async () => {
    const { pool, queries } = createFakePool([
      [
        {
          analytics: {
            summary: {
              total_sessions: 4,
              completed_sessions: 1,
              abandoned_sessions: 1,
              in_progress_sessions: 2,
              avg_completion_duration_ms: 120000,
              avg_completion_command_count: 7,
              avg_completion_chat_message_count: 3,
              avg_completion_score_total: 90,
            },
            by_platform: [
              {
                platform: "aks",
                total_sessions: 4,
                completed_sessions: 1,
                abandoned_sessions: 1,
                in_progress_sessions: 2,
              },
            ],
            by_difficulty: [],
            by_scenario: [],
            recent_sessions: [
              {
                platform: "aks",
                lifecycle_state: "completed",
                nickname: "octocat",
                difficulty: "easy",
                scenario_title: "The Sleeping Cluster",
                command_count: 7,
                chat_message_count: 3,
                duration_ms: 120000,
                score_total: 90,
                grade: "A",
                created_at: "2026-09-18T00:00:00.000Z",
              },
            ],
          },
        },
      ],
    ]);

    const analytics = await new PgMetricsStore(pool).getGameplayAnalytics({ platform: "aks" });

    // Five MSSQL resultsets collapse into one round trip; asserting the count
    // is what keeps a future edit from quietly reintroducing the fan-out.
    expect(queries).toHaveLength(1);
    expect(queries[0].values).toEqual(["aks"]);
    expect(analytics.summary.completionRate).toBe(25);
    expect(analytics.summary.abandonmentRate).toBe(25);
    expect(analytics.byPlatform[0].completionRate).toBe(25);
    // `to_char` renders the timestamp so it matches MSSQL's `toISOString()`
    // byte for byte, rather than Postgres' own timestamptz JSON format.
    expect(analytics.recentSessions[0].createdAt).toBe("2026-09-18T00:00:00.000Z");
  });

  it("getGameplayAnalytics() survives an empty database", async () => {
    const { pool } = createFakePool([
      [{ analytics: { summary: null, by_platform: [], by_difficulty: [], by_scenario: [], recent_sessions: [] } }],
    ]);

    const analytics = await new PgMetricsStore(pool).getGameplayAnalytics();

    expect(analytics.summary.totalSessions).toBe(0);
    expect(analytics.summary.completionRate).toBe(0);
    expect(analytics.recentSessions).toEqual([]);
  });

  it("getGameplayAnalytics() passes a NULL platform filter when unfiltered", async () => {
    const { pool, queries } = createFakePool([[]]);

    await new PgMetricsStore(pool).getGameplayAnalytics();

    expect(queries[0].values).toEqual([null]);
    expectEveryQueryWellFormed(queries);
  });
});

describe("pgReadQuery retry", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("retries once when the connection was dropped underneath the read", async () => {
    const { pgReadQuery } = await import("./pg-pool");
    const dropped = Object.assign(new Error("terminating connection"), { code: "57P01" });
    const query = vi
      .fn()
      .mockRejectedValueOnce(dropped)
      .mockResolvedValue({ rows: [{ one: 1 }], rowCount: 1 });

    await expect(pgReadQuery({ query }, "SELECT 1")).resolves.toEqual({
      rows: [{ one: 1 }],
      rowCount: 1,
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("does not retry a statement that failed on its own merits", async () => {
    const { pgReadQuery } = await import("./pg-pool");
    const badSyntax = Object.assign(new Error("syntax error"), { code: "42601" });
    const query = vi.fn().mockRejectedValue(badSyntax);

    await expect(pgReadQuery({ query }, "SELECT nope")).rejects.toThrow("syntax error");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("refuses a write before it reaches the database", async () => {
    const { pgReadQuery } = await import("./pg-pool");
    const query = vi.fn();

    // The guard is what makes the read/write split enforceable rather than a
    // naming convention: a write routed here would otherwise look correct until
    // a suspend replayed it in production.
    await expect(pgReadQuery({ query }, "INSERT INTO sessions VALUES ($1)")).rejects.toThrow(
      /not read-only/,
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("refuses a data-modifying CTE, which still opens with WITH", async () => {
    const { pgReadQuery } = await import("./pg-pool");
    const query = vi.fn();

    await expect(
      pgReadQuery({ query }, "WITH moved AS (DELETE FROM sessions RETURNING *) SELECT * FROM moved"),
    ).rejects.toThrow(/not read-only/);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("pgQuery never retries", () => {
  it("surfaces a dropped connection instead of replaying the write", async () => {
    const { pgQuery } = await import("./pg-pool");
    const dropped = Object.assign(new Error("terminating connection"), { code: "57P01" });
    const query = vi.fn().mockRejectedValue(dropped);

    // A retry here could duplicate a write the server already committed but
    // never got to acknowledge — PgSessionStore.create() is a plain INSERT.
    await expect(pgQuery({ query }, "INSERT INTO sessions VALUES ($1)")).rejects.toThrow(
      "terminating connection",
    );
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe("isReadOnlyStatement", () => {
  it("does not mistake this schema's column names for write keywords", async () => {
    const { isReadOnlyStatement } = await import("./pg-pool");

    // `created_at` / `updated_at` continue into another word character, so the
    // \b anchors do not fire. That is the whole reason the guard can be a
    // keyword test rather than a parser.
    expect(
      isReadOnlyStatement("SELECT created_at, updated_at FROM sessions WHERE is_deleted = false"),
    ).toBe(true);
  });

  it("classifies every statement the pg stores actually issue", async () => {
    const { isReadOnlyStatement } = await import("./pg-pool");

    expect(isReadOnlyStatement("  \n  SELECT * FROM players")).toBe(true);
    expect(isReadOnlyStatement("WITH ranked AS (SELECT 1) SELECT * FROM ranked")).toBe(true);
    expect(isReadOnlyStatement("INSERT INTO players VALUES ($1) ON CONFLICT DO UPDATE SET x=1")).toBe(false);
    expect(isReadOnlyStatement("UPDATE sessions SET end_time = $1")).toBe(false);
    expect(isReadOnlyStatement("DELETE FROM sessions WHERE start_time < $1")).toBe(false);
  });
});
