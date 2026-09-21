import type sql from "mssql";
import {
  runStoreContractSuite,
  type StoreContractStores,
  type StoreContractTracker,
} from "./store-contract";

/**
 * MSSQL driver for the shared store contract. Every assertion lives in
 * `store-contract.ts`; this file only knows how to connect, migrate and clean
 * up. The Postgres driver next door is the same shape.
 */

const SKIP = process.env.STORAGE_BACKEND !== "mssql";

let pool: sql.ConnectionPool | undefined;

async function connect(): Promise<sql.ConnectionPool> {
  if (pool) return pool;

  const mssql = await import("mssql");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL required for MSSQL tests");

  pool = new mssql.default.ConnectionPool(databaseUrl);
  await pool.connect();
  return pool;
}

async function migrate(): Promise<void> {
  const { runMigrations } = await import("../lib/storage/migrate");
  await runMigrations(await connect());
}

runStoreContractSuite({
  backendName: "MSSQL",
  skip: SKIP,

  async setup(): Promise<StoreContractStores> {
    const connection = await connect();
    await migrate();

    const [
      { MssqlSessionStore },
      { MssqlLeaderboardStore },
      { MssqlMetricsStore },
      { MssqlPlayerStore },
      { MssqlAnonymousTrialStore },
    ] = await Promise.all([
      import("../lib/storage/mssql-session-store"),
      import("../lib/storage/mssql-leaderboard-store"),
      import("../lib/storage/mssql-metrics-store"),
      import("../lib/storage/mssql-player-store"),
      import("../lib/storage/mssql-anonymous-trial-store"),
    ]);

    return {
      sessions: new MssqlSessionStore(connection),
      leaderboard: new MssqlLeaderboardStore(connection),
      metrics: new MssqlMetricsStore(connection),
      players: new MssqlPlayerStore(connection),
      anonymousTrials: new MssqlAnonymousTrialStore(connection),
    };
  },

  runMigrations: migrate,

  async teardown(tracked: StoreContractTracker): Promise<void> {
    if (!pool) return;

    for (const nick of tracked.nicknames) {
      await pool.request()
        .input("nick", nick)
        .query("DELETE FROM gameplay_metrics WHERE nickname = @nick");
      await pool.request()
        .input("nick", nick)
        .query("DELETE FROM leaderboard_entries WHERE nickname = @nick");
    }

    for (const token of tracked.sessionTokens) {
      await pool.request()
        .input("token", token)
        .query("DELETE FROM gameplay_metrics WHERE session_token = @token");
      await pool.request()
        .input("token", token)
        .query("DELETE FROM sessions WHERE token = @token");
    }

    for (const githubUserId of tracked.githubUserIds) {
      await pool.request()
        .input("githubUserId", githubUserId)
        .query("DELETE FROM players WHERE github_user_id = @githubUserId");
      await pool.request()
        .input("githubUserId", githubUserId)
        .query("DELETE FROM leaderboard_entries WHERE github_user_id = @githubUserId");
    }

    for (const claimKey of tracked.claimKeys) {
      await pool.request()
        .input("claimKey", claimKey)
        .query("DELETE FROM anonymous_trial_claims WHERE claim_key = @claimKey");
    }

    await pool.close();
    pool = undefined;
  },
});
