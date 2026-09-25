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
    delete process.env.ALLOW_DEPLOYED_JSON_STORAGE_FOR_TESTS;
    delete process.env.AI_MOCK_MODE;
    process.env.NODE_ENV = "test";
  });

  afterEach(async () => {
    try {
      const storage = await import("./index");
      await storage.shutdownStorage();
    } finally {
      Object.assign(process.env, ORIGINAL_ENV);
      for (const key of Object.keys(process.env)) {
        if (!(key in ORIGINAL_ENV)) {
          delete process.env[key];
        }
      }
      vi.doUnmock("mssql");
      vi.doUnmock("./migrate");
      vi.doUnmock("./mssql-session-store");
      vi.doUnmock("./mssql-leaderboard-store");
      vi.doUnmock("./mssql-metrics-store");
      vi.doUnmock("./mssql-player-store");
      vi.doUnmock("./mssql-anonymous-trial-store");
      vi.doUnmock("pg");
      vi.doUnmock("./migrate-pg");
      vi.doUnmock("./pg-session-store");
      vi.doUnmock("./pg-leaderboard-store");
      vi.doUnmock("./pg-metrics-store");
      vi.doUnmock("./pg-player-store");
      vi.doUnmock("./pg-anonymous-trial-store");
      vi.resetModules();
    }
  });

  test("blocks the default JSON backend in production mode", async () => {
    process.env.NODE_ENV = "production";

    const storage = await loadStorageModule();

    await expect(storage.initStorage()).rejects.toThrow(
      'Refusing to start with STORAGE_BACKEND=json in production or deployed mode. '
      + 'Set STORAGE_BACKEND=mssql or STORAGE_BACKEND=postgres, and DATABASE_URL.'
    );
  });

  test("blocks the JSON backend for deployed runtimes", async () => {
    process.env.NODE_ENV = "development";
    process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
    process.env.STORAGE_BACKEND = "json";

    const storage = await loadStorageModule();

    await expect(storage.initStorage()).rejects.toThrow(
      'Refusing to start with STORAGE_BACKEND=json in production or deployed mode. '
      + 'Set STORAGE_BACKEND=mssql or STORAGE_BACKEND=postgres, and DATABASE_URL.'
    );
  });

  test("keeps the JSON backend available for local development", async () => {
    process.env.NODE_ENV = "development";

    const storage = await loadStorageModule();

    await expect(storage.initStorage()).resolves.toBeUndefined();
    expect(storage.getStorageBackend()).toBe("json");
    expect(storage.getSessionStore()).toBeDefined();
  });

  test("allows deployed JSON only for explicit mock integration tests", async () => {
    process.env.NODE_ENV = "production";
    process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
    process.env.ALLOW_DEPLOYED_JSON_STORAGE_FOR_TESTS = "true";
    process.env.AI_MOCK_MODE = "true";

    const storage = await loadStorageModule();

    await expect(storage.initStorage()).resolves.toBeUndefined();
    expect(storage.getStorageBackend()).toBe("json");
  });

  test("does not allow deployed JSON without mock AI mode", async () => {
    process.env.NODE_ENV = "production";
    process.env.ALLOW_DEPLOYED_JSON_STORAGE_FOR_TESTS = "true";
    process.env.AI_MOCK_MODE = "false";

    const storage = await loadStorageModule();

    await expect(storage.initStorage()).rejects.toThrow(
      "Refusing to start with STORAGE_BACKEND=json",
    );
  });

  test("does not allow deployed JSON with mock AI mode alone", async () => {
    process.env.NODE_ENV = "production";
    process.env.AI_MOCK_MODE = "true";

    const storage = await loadStorageModule();

    await expect(storage.initStorage()).rejects.toThrow(
      "Refusing to start with STORAGE_BACKEND=json",
    );
  });

  test("rejects whitespace-only DATABASE_URL for mssql", async () => {
    process.env.NODE_ENV = "production";
    process.env.STORAGE_BACKEND = "mssql";
    process.env.DATABASE_URL = "   ";

    const storage = await loadStorageModule();

    await expect(storage.initStorage()).rejects.toThrow("DATABASE_URL is required when STORAGE_BACKEND=mssql");
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
  test("rejects an unknown STORAGE_BACKEND by name", async () => {
    process.env.STORAGE_BACKEND = "cockroach";

    const storage = await loadStorageModule();

    expect(() => storage.getStorageBackend()).toThrow(
      'Invalid STORAGE_BACKEND: cockroach. Must be "json", "mssql" or "postgres".',
    );
  });

  test("rejects whitespace-only DATABASE_URL for postgres", async () => {
    process.env.NODE_ENV = "production";
    process.env.STORAGE_BACKEND = "postgres";
    process.env.DATABASE_URL = "   ";

    const storage = await loadStorageModule();

    await expect(storage.initStorage()).rejects.toThrow(
      "DATABASE_URL is required when STORAGE_BACKEND=postgres",
    );
  });

  test("allows production-like runtimes to proceed with postgres", async () => {
    process.env.NODE_ENV = "production";
    process.env.STORAGE_BACKEND = "postgres";
    process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/sresimulator";

    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const end = vi.fn().mockResolvedValue(undefined);
    const on = vi.fn();
    const runPgMigrations = vi.fn().mockResolvedValue(undefined);
    const poolConfigs: unknown[] = [];

    class FakePool {
      query = query;
      end = end;
      on = on;

      constructor(config: unknown) {
        poolConfigs.push(config);
      }
    }

    class FakePgSessionStore {}
    class FakePgLeaderboardStore {}
    class FakePgMetricsStore {}
    class FakePgPlayerStore {}
    class FakePgAnonymousTrialStore {}

    vi.doMock("pg", () => ({ default: { Pool: FakePool } }));
    vi.doMock("./migrate-pg", () => ({ runPgMigrations }));
    vi.doMock("./pg-session-store", () => ({ PgSessionStore: FakePgSessionStore }));
    vi.doMock("./pg-leaderboard-store", () => ({ PgLeaderboardStore: FakePgLeaderboardStore }));
    vi.doMock("./pg-metrics-store", () => ({ PgMetricsStore: FakePgMetricsStore }));
    vi.doMock("./pg-player-store", () => ({ PgPlayerStore: FakePgPlayerStore }));
    vi.doMock("./pg-anonymous-trial-store", () => ({
      PgAnonymousTrialStore: FakePgAnonymousTrialStore,
    }));

    const storage = await loadStorageModule();

    await expect(storage.initStorage()).resolves.toBeUndefined();
    expect(storage.getStorageBackend()).toBe("postgres");
    expect(runPgMigrations).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith("SELECT 1");
    expect(storage.getSessionStore()).toBeInstanceOf(FakePgSessionStore);
    expect(storage.getAnonymousTrialStore()).toBeInstanceOf(FakePgAnonymousTrialStore);

    // The idle-client handler is the difference between a suspended Neon
    // compute and a dead Node process, so assert it was attached rather than
    // trusting that the pool module was imported.
    expect(on).toHaveBeenCalledWith("error", expect.any(Function));

    await storage.shutdownStorage();
    expect(end).toHaveBeenCalledTimes(1);
  });

  test("closes the postgres pool when the connection check fails", async () => {
    process.env.NODE_ENV = "production";
    process.env.STORAGE_BACKEND = "postgres";
    process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/sresimulator";

    const end = vi.fn().mockResolvedValue(undefined);

    class FakePool {
      query = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      end = end;
      on = vi.fn();
    }

    vi.doMock("pg", () => ({ default: { Pool: FakePool } }));
    vi.doMock("./migrate-pg", () => ({ runPgMigrations: vi.fn() }));

    const storage = await loadStorageModule();

    await expect(storage.initStorage()).rejects.toThrow("ECONNREFUSED");
    expect(end).toHaveBeenCalledTimes(1);
  });
});
