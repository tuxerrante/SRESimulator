import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

async function loadStorageModule() {
  vi.resetModules();
  return import("./index");
}

describe("initStorage production guard", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.STORAGE_BACKEND;
    delete process.env.DATABASE_URL;
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.NODE_ENV = "test";
  });

  afterEach(async () => {
    try {
      const storage = await import("./index");
      await storage.shutdownStorage();
    } finally {
      process.env = { ...ORIGINAL_ENV };
      vi.resetModules();
    }
  });

  test("blocks the default JSON backend in production mode", async () => {
    process.env.NODE_ENV = "production";

    const storage = await loadStorageModule();

    await expect(storage.initStorage()).rejects.toThrow(
      'Refusing to start with STORAGE_BACKEND=json in production or deployed mode. Set STORAGE_BACKEND=mssql and DATABASE_URL.'
    );
  });

  test("blocks the JSON backend for deployed runtimes", async () => {
    process.env.NODE_ENV = "development";
    process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
    process.env.STORAGE_BACKEND = "json";

    const storage = await loadStorageModule();

    await expect(storage.initStorage()).rejects.toThrow(
      'Refusing to start with STORAGE_BACKEND=json in production or deployed mode. Set STORAGE_BACKEND=mssql and DATABASE_URL.'
    );
  });

  test("keeps the JSON backend available for local development", async () => {
    process.env.NODE_ENV = "development";

    const storage = await loadStorageModule();

    await expect(storage.initStorage()).resolves.toBeUndefined();
    expect(storage.getStorageBackend()).toBe("json");
    expect(storage.getSessionStore()).toBeDefined();
  });

  test("allows production-like runtimes to proceed with mssql", async () => {
    process.env.NODE_ENV = "production";
    process.env.STORAGE_BACKEND = "mssql";
    process.env.DATABASE_URL = "Server=fake;Database=sresimulator;User Id=test;Password=test";

    const query = vi.fn().mockResolvedValue({ recordset: [] });
    const runMigrations = vi.fn().mockResolvedValue(undefined);

    class FakeConnectionPool {
      async connect() {
        return this;
      }

      request() {
        return { query };
      }

      async close() {
        return undefined;
      }
    }

    class FakeSessionStore {}
    class FakeLeaderboardStore {}
    class FakeMetricsStore {}
    class FakePlayerStore {}
    class FakeAnonymousTrialStore {}

    vi.doMock("mssql", () => ({
      default: {
        ConnectionPool: FakeConnectionPool,
      },
    }));
    vi.doMock("./migrate", () => ({ runMigrations }));
    vi.doMock("./mssql-session-store", () => ({ MssqlSessionStore: FakeSessionStore }));
    vi.doMock("./mssql-leaderboard-store", () => ({ MssqlLeaderboardStore: FakeLeaderboardStore }));
    vi.doMock("./mssql-metrics-store", () => ({ MssqlMetricsStore: FakeMetricsStore }));
    vi.doMock("./mssql-player-store", () => ({ MssqlPlayerStore: FakePlayerStore }));
    vi.doMock("./mssql-anonymous-trial-store", () => ({
      MssqlAnonymousTrialStore: FakeAnonymousTrialStore,
    }));

    const storage = await loadStorageModule();

    await expect(storage.initStorage()).resolves.toBeUndefined();
    expect(storage.getStorageBackend()).toBe("mssql");
    expect(runMigrations).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith("SELECT 1");
    expect(storage.getSessionStore()).toBeInstanceOf(FakeSessionStore);
  });
});
