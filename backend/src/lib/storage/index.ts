import type { Pool } from "pg";
import type { ISessionStore, ILeaderboardStore, IMetricsStore } from "./types";
import { JsonSessionStore } from "./json-session-store";
import { JsonLeaderboardStore } from "./json-leaderboard-store";
import { JsonMetricsStore } from "./json-metrics-store";

export type { ISessionStore, ILeaderboardStore, IMetricsStore, GameSession, GameplayRecord } from "./types";

let sessionStore: ISessionStore;
let leaderboardStore: ILeaderboardStore;
let metricsStore: IMetricsStore;
let pgPool: Pool | undefined;

export type StorageBackend = "json" | "postgres";

export function getStorageBackend(): StorageBackend {
  const value = process.env.STORAGE_BACKEND ?? "json";
  if (value !== "json" && value !== "postgres") {
    throw new Error(`Invalid STORAGE_BACKEND: ${value}. Must be "json" or "postgres".`);
  }
  return value;
}

export async function initStorage(): Promise<void> {
  const backend = getStorageBackend();

  if (backend === "postgres") {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required when STORAGE_BACKEND=postgres");
    }

    const pg = await import("pg");
    const { runMigrations } = await import("./migrate");
    const { PgSessionStore } = await import("./pg-session-store");
    const { PgLeaderboardStore } = await import("./pg-leaderboard-store");
    const { PgMetricsStore } = await import("./pg-metrics-store");

    pgPool = new pg.Pool({
      connectionString: databaseUrl,
      max: 10,
    });

    await pgPool.query("SELECT 1");
    console.log("[storage] PostgreSQL connection verified");

    await runMigrations(pgPool);
    console.log("[storage] migrations complete");

    sessionStore = new PgSessionStore(pgPool);
    leaderboardStore = new PgLeaderboardStore(pgPool);
    metricsStore = new PgMetricsStore(pgPool);
    console.log("[storage] backend=postgres ready");
  } else {
    sessionStore = new JsonSessionStore();
    leaderboardStore = new JsonLeaderboardStore();
    metricsStore = new JsonMetricsStore();
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

export async function shutdownStorage(): Promise<void> {
  if (pgPool) {
    await pgPool.end();
    pgPool = undefined;
    console.log("[storage] PostgreSQL pool closed");
  }
}
