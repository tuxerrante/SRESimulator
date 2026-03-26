import type sql from "mssql";
import type { ISessionStore, ILeaderboardStore, IMetricsStore } from "./types";
import { JsonSessionStore } from "./json-session-store";
import { JsonLeaderboardStore } from "./json-leaderboard-store";
import { JsonMetricsStore } from "./json-metrics-store";

export type { ISessionStore, ILeaderboardStore, IMetricsStore, GameSession, GameplayRecord } from "./types";

let sessionStore: ISessionStore;
let leaderboardStore: ILeaderboardStore;
let metricsStore: IMetricsStore;
let mssqlPool: sql.ConnectionPool | undefined;

export type StorageBackend = "json" | "mssql";

export function getStorageBackend(): StorageBackend {
  const value = process.env.STORAGE_BACKEND ?? "json";
  if (value !== "json" && value !== "mssql") {
    throw new Error(`Invalid STORAGE_BACKEND: ${value}. Must be "json" or "mssql".`);
  }
  return value;
}

export async function initStorage(): Promise<void> {
  const backend = getStorageBackend();

  if (backend === "mssql") {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required when STORAGE_BACKEND=mssql");
    }

    const mssql = await import("mssql");
    const { runMigrations } = await import("./migrate");
    const { MssqlSessionStore } = await import("./mssql-session-store");
    const { MssqlLeaderboardStore } = await import("./mssql-leaderboard-store");
    const { MssqlMetricsStore } = await import("./mssql-metrics-store");

    mssqlPool = new mssql.default.ConnectionPool(databaseUrl);
    await mssqlPool.connect();

    await mssqlPool.request().query("SELECT 1");
    console.log("[storage] Azure SQL connection verified");

    await runMigrations(mssqlPool);
    console.log("[storage] migrations complete");

    sessionStore = new MssqlSessionStore(mssqlPool);
    leaderboardStore = new MssqlLeaderboardStore(mssqlPool);
    metricsStore = new MssqlMetricsStore(mssqlPool);
    console.log("[storage] backend=mssql ready");
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
  if (mssqlPool) {
    await mssqlPool.close();
    mssqlPool = undefined;
    console.log("[storage] Azure SQL pool closed");
  }
}
