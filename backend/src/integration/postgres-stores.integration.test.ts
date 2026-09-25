import type { Pool } from "pg";
import {
  runStoreContractSuite,
  type StoreContractStores,
  type StoreContractTracker,
} from "./store-contract";

/**
 * Postgres driver for the shared store contract.
 *
 * The Postgres schema is a consolidated baseline rather than a replay of the
 * eight T-SQL migrations, so this file passing against the same assertions the
 * MSSQL driver passes is the evidence that the consolidation preserved
 * behaviour.
 */

const SKIP = process.env.STORAGE_BACKEND !== "postgres";

let pool: Pool | undefined;

async function connect(): Promise<Pool> {
  if (pool) return pool;

  const pg = await import("pg");
  const { buildPgPoolConfig, attachPoolErrorHandler } = await import("../lib/storage/pg-pool");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL required for Postgres tests");

  pool = new pg.default.Pool(buildPgPoolConfig(databaseUrl));
  attachPoolErrorHandler(pool);
  await pool.query("SELECT 1");
  return pool;
}

async function migrate(): Promise<void> {
  const { runPgMigrations } = await import("../lib/storage/migrate-pg");
  await runPgMigrations(await connect());
}

runStoreContractSuite({
  backendName: "Postgres",
  skip: SKIP,

  async setup(): Promise<StoreContractStores> {
    const connection = await connect();
    await migrate();

    const [
      { PgSessionStore },
      { PgLeaderboardStore },
      { PgMetricsStore },
      { PgPlayerStore },
      { PgAnonymousTrialStore },
    ] = await Promise.all([
      import("../lib/storage/pg-session-store"),
      import("../lib/storage/pg-leaderboard-store"),
      import("../lib/storage/pg-metrics-store"),
      import("../lib/storage/pg-player-store"),
      import("../lib/storage/pg-anonymous-trial-store"),
    ]);

    return {
      sessions: new PgSessionStore(connection),
      leaderboard: new PgLeaderboardStore(connection),
      metrics: new PgMetricsStore(connection),
      players: new PgPlayerStore(connection),
      anonymousTrials: new PgAnonymousTrialStore(connection),
    };
  },

  runMigrations: migrate,

  async teardown(tracked: StoreContractTracker): Promise<void> {
    if (!pool) return;

    await pool.query("DELETE FROM gameplay_metrics WHERE nickname = ANY($1::text[])", [
      tracked.nicknames,
    ]);
    await pool.query("DELETE FROM leaderboard_entries WHERE nickname = ANY($1::text[])", [
      tracked.nicknames,
    ]);
    await pool.query("DELETE FROM gameplay_metrics WHERE session_token = ANY($1::uuid[])", [
      tracked.sessionTokens,
    ]);
    await pool.query("DELETE FROM sessions WHERE token = ANY($1::uuid[])", [
      tracked.sessionTokens,
    ]);
    await pool.query("DELETE FROM players WHERE github_user_id = ANY($1::text[])", [
      tracked.githubUserIds,
    ]);
    await pool.query("DELETE FROM leaderboard_entries WHERE github_user_id = ANY($1::text[])", [
      tracked.githubUserIds,
    ]);
    await pool.query("DELETE FROM anonymous_trial_claims WHERE claim_key = ANY($1::text[])", [
      tracked.claimKeys,
    ]);

    await pool.end();
    pool = undefined;
  },
});
