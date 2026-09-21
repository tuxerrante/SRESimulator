import { readFile } from "fs/promises";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runPgMigrations } from "./migrate-pg";

interface FakeClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

function createFakePool(overrides: {
  appliedNames?: string[];
  failOn?: RegExp;
} = {}): { pool: Pool; client: FakeClient; texts: () => string[] } {
  const applied = overrides.appliedNames ?? [];
  const texts: string[] = [];

  const query = vi.fn(async (text: string) => {
    texts.push(text);
    if (overrides.failOn?.test(text)) {
      throw new Error("migration blew up");
    }
    if (/SELECT name FROM _migrations/.test(text)) {
      return { rows: applied.map((name) => ({ name })), rowCount: applied.length };
    }
    return { rows: [], rowCount: 0 };
  });

  const client: FakeClient = { query, release: vi.fn() };
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

  return { pool, client, texts: () => texts };
}

describe("runPgMigrations", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("takes a transaction-scoped advisory lock, never a session-scoped one", async () => {
    const { pool, texts } = createFakePool();

    await runPgMigrations(pool);

    const lock = texts().find((t) => t.includes("pg_advisory"));
    expect(lock).toContain("pg_advisory_xact_lock");
    // A session-scoped lock would be released onto a connection PgBouncer has
    // already handed to a different client, so the pooled Neon endpoint could
    // not serve both app traffic and migrations.
    expect(texts().join("\n")).not.toContain("pg_advisory_lock(");
  });

  it("casts the lock key so Postgres does not have to guess the overload", async () => {
    const { pool, texts } = createFakePool();

    await runPgMigrations(pool);

    expect(texts().find((t) => t.includes("pg_advisory"))).toContain("$1::bigint");
  });

  it("commits and releases the client on the happy path", async () => {
    const { pool, client, texts } = createFakePool();

    await runPgMigrations(pool);

    expect(texts()[0]).toBe("BEGIN");
    const committed = texts();
    expect(committed[committed.length - 1]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("applies each baseline file exactly once and records it", async () => {
    const { pool, client, texts } = createFakePool();

    await runPgMigrations(pool);

    const inserts = client.query.mock.calls.filter(
      ([text]) => typeof text === "string" && text.startsWith("INSERT INTO _migrations"),
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0][1]).toEqual(["001_init.sql"]);
    expect(texts().some((t) => t.includes("CREATE TABLE IF NOT EXISTS sessions"))).toBe(true);
  });

  it("skips a migration that is already recorded", async () => {
    const { pool, client } = createFakePool({ appliedNames: ["001_init.sql"] });

    await runPgMigrations(pool);

    const inserts = client.query.mock.calls.filter(
      ([text]) => typeof text === "string" && text.startsWith("INSERT INTO _migrations"),
    );
    expect(inserts).toHaveLength(0);
  });

  it("rolls back and still releases the client when a migration fails", async () => {
    const { pool, client, texts } = createFakePool({ failOn: /CREATE TABLE IF NOT EXISTS sessions/ });

    await expect(runPgMigrations(pool)).rejects.toThrow("migration blew up");

    const rolledBack = texts();
    expect(rolledBack[rolledBack.length - 1]).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("reports the build-output problem when the migrations directory is absent", async () => {
    vi.resetModules();
    vi.doMock("fs/promises", () => ({
      readdir: vi.fn().mockRejectedValue(Object.assign(new Error("nope"), { code: "ENOENT" })),
      readFile: vi.fn(),
    }));

    const { runPgMigrations: run } = await import("./migrate-pg");
    const { pool } = createFakePool();

    await expect(run(pool)).rejects.toThrow(
      /Migrations directory not found at .*migrations-pg\. Ensure the \.sql files are copied into the build output/,
    );

    vi.doUnmock("fs/promises");
  });
});

describe("migrations-pg/001_init.sql", () => {
  async function baseline(): Promise<string> {
    return readFile(path.join(__dirname, "migrations-pg", "001_init.sql"), "utf-8");
  }

  it("declares the partial unique index the leaderboard upsert names", async () => {
    const sql = await baseline();
    const store = await readFile(path.join(__dirname, "pg-leaderboard-store.ts"), "utf-8");

    // `ON CONFLICT` can only infer a partial index if the conflict target
    // restates the predicate, so index and upsert have to agree. Disagreement
    // is a runtime-only error ("no unique or exclusion constraint matching the
    // ON CONFLICT specification"), which is why it is asserted across the pair.
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS ux_leaderboard_entries_github_platform_difficulty_traffic[\s\S]*?ON leaderboard_entries \(github_user_id, platform, difficulty, traffic_source\)[\s\S]*?WHERE github_user_id IS NOT NULL/,
    );
    expect(store).toContain(
      "ON CONFLICT (github_user_id, platform, difficulty, traffic_source)",
    );
    expect(store).toContain("WHERE github_user_id IS NOT NULL");
  });

  it("declares the partial unique index whose violation the metrics store swallows", async () => {
    const sql = await baseline();
    const store = await readFile(path.join(__dirname, "pg-metrics-store.ts"), "utf-8");

    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS ux_gameplay_metrics_session_lifecycle[\s\S]*?WHERE session_token IS NOT NULL/,
    );
    // The classifier compares `error.constraint`, so a rename on either side
    // would turn a swallowed duplicate into a 500 with no other signal.
    expect(store).toContain('"ux_gameplay_metrics_session_lifecycle"');
  });

  it("carries no T-SQL left over from the consolidated sources", async () => {
    const sql = await baseline();

    for (const tsqlism of [
      "NVARCHAR",
      "UNIQUEIDENTIFIER",
      "DATETIMEOFFSET",
      "SYSDATETIMEOFFSET",
      "GETUTCDATE",
      "IDENTITY(",
      "[dbo]",
    ]) {
      expect(sql).not.toContain(tsqlism);
    }
  });

  it("uses jsonb for the three columns the store serialises as JSON", async () => {
    const sql = await baseline();

    expect(sql).toMatch(/commands_executed\s+JSONB/i);
    expect(sql).toMatch(/scoring_events\s+JSONB/i);
    expect(sql).toMatch(/metadata\s+JSONB/i);
  });

  it("is idempotent enough to re-run against a database that already has it", async () => {
    const sql = await baseline();

    const creates = [...sql.matchAll(/CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)\s+(IF NOT EXISTS\s+)?/gi)];
    expect(creates.length).toBeGreaterThan(0);
    for (const match of creates) {
      expect(match[3], `missing IF NOT EXISTS: ${match[0]}`).toBeTruthy();
    }
  });
});
