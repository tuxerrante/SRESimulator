import type sql from "mssql";
import type { Pool as PgPool } from "pg";
import type {
  ISessionStore,
  ILeaderboardStore,
  IMetricsStore,
  IPlayerStore,
  IAnonymousTrialStore,
} from "./types";
import { JsonSessionStore } from "./json-session-store";
import { JsonLeaderboardStore } from "./json-leaderboard-store";
import { JsonMetricsStore } from "./json-metrics-store";
import { JsonPlayerStore } from "./json-player-store";
import { JsonAnonymousTrialStore } from "./json-anonymous-trial-store";

export type {
  ISessionStore,
  ILeaderboardStore,
  IMetricsStore,
  IPlayerStore,
  IAnonymousTrialStore,
  GameSession,
  GameplayRecord,
  CreateGameSessionInput,
  AnonymousTrialClaim,
  PlayerRecord,
} from "./types";

let sessionStore: ISessionStore;
let leaderboardStore: ILeaderboardStore;
let metricsStore: IMetricsStore;
let playerStore: IPlayerStore;
let anonymousTrialStore: IAnonymousTrialStore;
let mssqlPool: sql.ConnectionPool | undefined;
let pgPool: PgPool | undefined;

export type StorageBackend = "json" | "mssql" | "postgres";

export function getStorageBackend(): StorageBackend {
  const value = process.env.STORAGE_BACKEND ?? "json";
  if (value !== "json" && value !== "mssql" && value !== "postgres") {
    throw new Error(
      `Invalid STORAGE_BACKEND: ${value}. Must be "json", "mssql" or "postgres".`
    );
  }
  return value;
}

function isProductionLikeRuntime(): boolean {
  return process.env.NODE_ENV === "production" || Boolean(process.env.KUBERNETES_SERVICE_HOST);
}

function isDeployedJsonTestMode(): boolean {
  return (
    process.env.ALLOW_DEPLOYED_JSON_STORAGE_FOR_TESTS === "true" &&
    process.env.AI_MOCK_MODE === "true"
  );
}

function assertStorageBackendAllowed(backend: StorageBackend): void {
  if (
    backend === "json" &&
    isProductionLikeRuntime() &&
    !isDeployedJsonTestMode()
  ) {
    throw new Error(
      "Refusing to start with STORAGE_BACKEND=json in production or deployed mode. " +
      "Set STORAGE_BACKEND=mssql or STORAGE_BACKEND=postgres, and DATABASE_URL."
    );
  }
}

export async function initStorage(): Promise<void> {
  const backend = getStorageBackend();
  assertStorageBackendAllowed(backend);

  if (backend === "mssql") {
    if (mssqlPool) return;

    const databaseUrl = process.env.DATABASE_URL?.trim();
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required when STORAGE_BACKEND=mssql");
    }

    const mssql = await import("mssql");
    const { runMigrations } = await import("./migrate");
    const { MssqlSessionStore } = await import("./mssql-session-store");
    const { MssqlLeaderboardStore } = await import("./mssql-leaderboard-store");
    const { MssqlMetricsStore } = await import("./mssql-metrics-store");

    const pool = new mssql.default.ConnectionPool(databaseUrl);
    try {
      await pool.connect();

      await pool.request().query("SELECT 1");
      console.log("[storage] Azure SQL connection verified");

      await runMigrations(pool);
      console.log("[storage] migrations complete");

      mssqlPool = pool;
      sessionStore = new MssqlSessionStore(pool);
      leaderboardStore = new MssqlLeaderboardStore(pool);
      metricsStore = new MssqlMetricsStore(pool);
      const { MssqlPlayerStore } = await import("./mssql-player-store");
      const { MssqlAnonymousTrialStore } = await import("./mssql-anonymous-trial-store");
      playerStore = new MssqlPlayerStore(pool);
      anonymousTrialStore = new MssqlAnonymousTrialStore(pool);
      console.log("[storage] backend=mssql ready");
    } catch (error) {
      try { await pool.close(); } catch { /* ignore close errors on failed pool */ }
      throw error;
    }
  } else if (backend === "postgres") {
    if (pgPool) return;

    const databaseUrl = process.env.DATABASE_URL?.trim();
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required when STORAGE_BACKEND=postgres");
    }

    // Dynamic imports throughout, exactly as the mssql branch does: `pg` must
    // never be loaded in JSON mode.
    const pg = await import("pg");
    const { buildPgPoolConfig, attachPoolErrorHandler } = await import("./pg-pool");
    const { runPgMigrations } = await import("./migrate-pg");
    const { PgSessionStore } = await import("./pg-session-store");
    const { PgLeaderboardStore } = await import("./pg-leaderboard-store");
    const { PgMetricsStore } = await import("./pg-metrics-store");

    const pool = new pg.default.Pool(buildPgPoolConfig(databaseUrl));
    attachPoolErrorHandler(pool);

    try {
      await pool.query("SELECT 1");
      console.log("[storage] Postgres connection verified");

      await runPgMigrations(pool);
      console.log("[storage] migrations complete");

      pgPool = pool;
      sessionStore = new PgSessionStore(pool);
      leaderboardStore = new PgLeaderboardStore(pool);
      metricsStore = new PgMetricsStore(pool);
      const { PgPlayerStore } = await import("./pg-player-store");
      const { PgAnonymousTrialStore } = await import("./pg-anonymous-trial-store");
      playerStore = new PgPlayerStore(pool);
      anonymousTrialStore = new PgAnonymousTrialStore(pool);
      console.log("[storage] backend=postgres ready");
    } catch (error) {
      try { await pool.end(); } catch { /* ignore close errors on failed pool */ }
      throw error;
    }
  } else {
    sessionStore = new JsonSessionStore();
    leaderboardStore = new JsonLeaderboardStore();
    metricsStore = new JsonMetricsStore();
    playerStore = new JsonPlayerStore();
    anonymousTrialStore = new JsonAnonymousTrialStore();
    console.log("[storage] backend=json ready");
  }
}

export function getSessionStore(): ISessionStore {
  if (!sessionStore) throw new Error("Storage not initialized. Call initStorage() first.");
  return sessionStore;
}

export function getLeaderboardStore(): ILeaderboardStore {
  if (!leaderboardStore) throw new Error("Storage not initialized. Call initStorage() first.");
  return leaderboardStore;
}

export function getMetricsStore(): IMetricsStore {
  if (!metricsStore) throw new Error("Storage not initialized. Call initStorage() first.");
  return metricsStore;
}

export function getPlayerStore(): IPlayerStore {
  if (!playerStore) throw new Error("Storage not initialized. Call initStorage() first.");
  return playerStore;
}

export function getAnonymousTrialStore(): IAnonymousTrialStore {
  if (!anonymousTrialStore) throw new Error("Storage not initialized. Call initStorage() first.");
  return anonymousTrialStore;
}

/**
 * Issue the cheapest possible liveness query against the active database pool.
 *
 * Returns `false` when the active backend has no database at all (JSON mode),
 * which callers must read as "nothing to check" rather than as a failure.
 * Throws whatever the driver throws when the query fails.
 */
export async function pingDatabase(): Promise<boolean> {
  if (mssqlPool) {
    await mssqlPool.request().query("SELECT 1");
    return true;
  }
  if (pgPool) {
    await pgPool.query("SELECT 1");
    return true;
  }
  return false;
}

export async function shutdownStorage(): Promise<void> {
  if (mssqlPool) {
    await mssqlPool.close();
    mssqlPool = undefined;
    console.log("[storage] Azure SQL pool closed");
  }
  if (pgPool) {
    await pgPool.end();
    pgPool = undefined;
    console.log("[storage] Postgres pool closed");
  }
}
