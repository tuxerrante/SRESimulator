import { describe, expect, it, vi, beforeEach } from "vitest";
import type sql from "mssql";
import { MssqlSessionStore } from "./mssql-session-store";
import { MssqlLeaderboardStore } from "./mssql-leaderboard-store";
import { MssqlMetricsStore } from "./mssql-metrics-store";

function createMockRequest(recordset: unknown[] = []) {
  const req = {
    input: vi.fn().mockReturnThis(),
    query: vi.fn().mockResolvedValue({ recordset }),
  };
  return req;
}

function createMockPool(recordset: unknown[] = []) {
  const req = createMockRequest(recordset);
  const pool = {
    request: vi.fn().mockReturnValue(req),
  } as unknown as sql.ConnectionPool;
  return { pool, req };
}

describe("MssqlSessionStore", () => {
  let store: MssqlSessionStore;
  let req: ReturnType<typeof createMockRequest>;
  let pool: sql.ConnectionPool;

  beforeEach(() => {
    const mock = createMockPool();
    pool = mock.pool;
    req = mock.req;
    store = new MssqlSessionStore(pool);
  });

  it("create() inserts a row and returns a UUID token", async () => {
    const token = await store.create("easy", "Test Scenario");

    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(req.input).toHaveBeenCalledWith("token", token);
    expect(req.input).toHaveBeenCalledWith("difficulty", "easy");
    expect(req.input).toHaveBeenCalledWith("scenarioTitle", "Test Scenario");
    expect(req.input).toHaveBeenCalledWith("trafficSource", "player");
    expect(req.query).toHaveBeenCalled();
    const sql = req.query.mock.calls[0][0] as string;
    expect(sql).toContain("INSERT INTO sessions");
  });

  it("validateAndConsume() returns mapped session on match", async () => {
    const validUuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const row = {
      token: validUuid,
      difficulty: "hard" as const,
      scenario_title: "Etcd Quorum Loss",
      start_time: 1700000000000,
      used: true,
      traffic_source: "automated" as const,
    };
    const mock = createMockPool([row]);
    store = new MssqlSessionStore(mock.pool);

    const result = await store.validateAndConsume(validUuid);

    expect(result).toEqual({
      token: validUuid,
      difficulty: "hard",
      scenarioTitle: "Etcd Quorum Loss",
      startTime: 1700000000000,
      used: true,
      trafficSource: "automated",
    });
  });

  it("validateAndConsume() returns null for non-UUID tokens", async () => {
    const result = await store.validateAndConsume("not-a-uuid");
    expect(result).toBeNull();
  });

  it("validateAndConsume() returns null when no rows match", async () => {
    const result = await store.validateAndConsume("nonexistent");
    expect(result).toBeNull();
  });
});

describe("MssqlLeaderboardStore", () => {
  it("getLeaderboard() without difficulty does not bind difficulty param", async () => {
    const { pool, req } = createMockPool([]);
    const store = new MssqlLeaderboardStore(pool);

    await store.getLeaderboard();

    const inputCalls = req.input.mock.calls.map((c: unknown[]) => c[0]);
    expect(inputCalls).toContain("limit");
    expect(inputCalls).not.toContain("difficulty");
  });

  it("getLeaderboard() with difficulty filters by it", async () => {
    const { pool, req } = createMockPool([]);
    const store = new MssqlLeaderboardStore(pool);

    await store.getLeaderboard("medium");

    expect(req.input).toHaveBeenCalledWith("difficulty", "medium");
    const sql = req.query.mock.calls[0][0] as string;
    expect(sql).toContain("WHERE difficulty = @difficulty");
    expect(sql).toContain("traffic_source = 'player'");
  });

  it("getLeaderboard() maps rows to LeaderboardEntry", async () => {
    const row = {
      id: "entry-1",
      nickname: "tester",
      difficulty: "easy" as const,
      score_efficiency: 20,
      score_safety: 22,
      score_documentation: 18,
      score_accuracy: 25,
      score_total: 85,
      grade: "A",
      command_count: 4,
      duration_ms: 120000,
      scenario_title: "The Sleeping Cluster",
      traffic_source: "automated" as const,
      created_at: new Date("2025-01-15T10:00:00Z"),
    };
    const { pool } = createMockPool([row]);
    const store = new MssqlLeaderboardStore(pool);

    const entries = await store.getLeaderboard();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      id: "entry-1",
      nickname: "tester",
      difficulty: "easy",
      score: {
        efficiency: 20,
        safety: 22,
        documentation: 18,
        accuracy: 25,
        total: 85,
      },
      grade: "A",
      commandCount: 4,
      durationMs: 120000,
      scenarioTitle: "The Sleeping Cluster",
      trafficSource: "automated",
      timestamp: new Date("2025-01-15T10:00:00Z").getTime(),
    });
  });

  it("getHallOfFame() aggregates composite scores", async () => {
    const row = {
      nickname: "pro",
      easy: 90,
      medium: 80,
      hard: null,
      composite: 170,
    };
    const { pool } = createMockPool([row]);
    const store = new MssqlLeaderboardStore(pool);

    const fame = await store.getHallOfFame();

    expect(fame).toEqual([
      {
        nickname: "pro",
        compositeScore: 170,
        scores: { easy: 90, medium: 80 },
      },
    ]);
  });

  it("addEntry() upserts within the same traffic source only", async () => {
    const entry = {
      id: "e2",
      nickname: "player",
      difficulty: "easy" as const,
      score: { efficiency: 20, safety: 20, documentation: 20, accuracy: 20, total: 80 },
      grade: "B",
      commandCount: 6,
      durationMs: 90000,
      scenarioTitle: "Master Down",
      trafficSource: "automated" as const,
      timestamp: Date.now(),
    };
    const { pool, req } = createMockPool();
    const store = new MssqlLeaderboardStore(pool);

    await store.addEntry(entry);

    const sql = req.query.mock.calls[0][0] as string;
    expect(sql).toContain("target.traffic_source = source.traffic_source");
  });

  it("addEntry() uses MERGE for upsert and trims", async () => {
    const entry = {
      id: "e1",
      nickname: "player",
      difficulty: "easy" as const,
      score: { efficiency: 20, safety: 20, documentation: 20, accuracy: 20, total: 80 },
      grade: "B",
      commandCount: 6,
      durationMs: 90000,
      scenarioTitle: "Master Down",
      trafficSource: "automated" as const,
      timestamp: Date.now(),
    };
    const { pool, req } = createMockPool();
    const store = new MssqlLeaderboardStore(pool);

    const result = await store.addEntry(entry);

    expect(result).toBe(entry);
    expect(req.input).toHaveBeenCalledWith("trafficSource", "automated");
    const queries = req.query.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(queries.some((q: string) => q.includes("MERGE"))).toBe(true);
    expect(queries.some((q: string) => q.includes("DELETE FROM leaderboard_entries"))).toBe(true);
  });

  it("addEntry() trims only the entry traffic source", async () => {
    const entry = {
      id: "e3",
      nickname: "player",
      difficulty: "hard" as const,
      score: { efficiency: 20, safety: 20, documentation: 20, accuracy: 20, total: 80 },
      grade: "B",
      commandCount: 6,
      durationMs: 90000,
      scenarioTitle: "Master Down",
      trafficSource: "automated" as const,
      timestamp: Date.now(),
    };
    const { pool, req } = createMockPool();
    const store = new MssqlLeaderboardStore(pool);

    await store.addEntry(entry);

    const trimQueries = req.query.mock.calls
      .map((c: unknown[]) => c[0] as string)
      .filter((sql: string) => sql.includes("DELETE FROM leaderboard_entries"));

    expect(trimQueries).toHaveLength(1);
    expect(req.input).toHaveBeenCalledWith("trafficSource", "automated");
  });
});

describe("MssqlMetricsStore", () => {
  it("recordGameplay() inserts with all fields", async () => {
    const { pool, req } = createMockPool();
    const store = new MssqlMetricsStore(pool);

    await store.recordGameplay({
      sessionToken: "tok-1",
      nickname: "tester",
      difficulty: "hard",
      scenarioTitle: "Cosmos DB Flood",
      commandsExecuted: ["oc get pods"],
      scoringEvents: [{ type: "safety", points: 5 }],
      chatMessageCount: 12,
      aiPromptTokens: 5000,
      aiCompletionTokens: 2000,
      durationMs: 300000,
      completed: true,
      trafficSource: "automated",
      metadata: { version: "1.0" },
    });

    expect(req.input).toHaveBeenCalledWith("sessionToken", "tok-1");
    expect(req.input).toHaveBeenCalledWith("nickname", "tester");
    expect(req.input).toHaveBeenCalledWith("trafficSource", "automated");
    expect(req.input).toHaveBeenCalledWith(
      "commandsExecuted",
      JSON.stringify(["oc get pods"])
    );
    expect(req.input).toHaveBeenCalledWith(
      "metadata",
      JSON.stringify({ version: "1.0" })
    );
    const sql = req.query.mock.calls[0][0] as string;
    expect(sql).toContain("INSERT INTO gameplay_metrics");
  });

  it("recordGameplay() defaults nullable fields to null/empty", async () => {
    const { pool, req } = createMockPool();
    const store = new MssqlMetricsStore(pool);

    await store.recordGameplay({});

    expect(req.input).toHaveBeenCalledWith("sessionToken", null);
    expect(req.input).toHaveBeenCalledWith("nickname", null);
    expect(req.input).toHaveBeenCalledWith("commandsExecuted", "[]");
    expect(req.input).toHaveBeenCalledWith("metadata", "{}");
  });

  it("getPlayerHistory() maps JSON string columns back to objects", async () => {
    const row = {
      id: "m1",
      session_token: "tok-1",
      nickname: "tester",
      difficulty: "easy",
      scenario_title: "Master Down",
      commands_executed: '["oc get nodes"]',
      scoring_events: '[{"type":"accuracy","points":10}]',
      chat_message_count: 5,
      ai_prompt_tokens: 3000,
      ai_completion_tokens: 1500,
      duration_ms: 60000,
      completed: true,
      traffic_source: "automated",
      metadata: '{"v":2}',
      created_at: new Date("2025-06-01T12:00:00Z"),
    };
    const { pool } = createMockPool([row]);
    const store = new MssqlMetricsStore(pool);

    const history = await store.getPlayerHistory("tester");

    expect(history).toHaveLength(1);
    expect(history[0].commandsExecuted).toEqual(["oc get nodes"]);
    expect(history[0].scoringEvents).toEqual([{ type: "accuracy", points: 10 }]);
    expect(history[0].metadata).toEqual({ v: 2 });
    expect(history[0].durationMs).toBe(60000);
    expect(history[0].trafficSource).toBe("automated");
  });
});
