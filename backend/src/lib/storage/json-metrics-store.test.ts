import { describe, expect, it, vi } from "vitest";
import { JsonMetricsStore } from "./json-metrics-store";

describe("JsonMetricsStore", () => {
  it("stores lifecycle fields and returns history newest first", async () => {
    const store = new JsonMetricsStore();

    await store.recordGameplay({
      sessionToken: "first-session",
      nickname: "player1",
      difficulty: "easy",
      scenarioTitle: "The Sleeping Cluster",
      lifecycleState: "started",
      createdAt: new Date("2026-04-25T08:00:00Z"),
    });
    await store.recordGameplay({
      sessionToken: "second-session",
      nickname: "player1",
      difficulty: "easy",
      scenarioTitle: "The Sleeping Cluster",
      lifecycleState: "completed",
      commandCount: 4,
      scoreTotal: 82,
      grade: "B",
      createdAt: new Date("2026-04-25T09:00:00Z"),
    });

    const history = await store.getPlayerHistory("player1");

    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      sessionToken: "second-session",
      lifecycleState: "completed",
      commandCount: 4,
      scoreTotal: 82,
      grade: "B",
    });
    expect(history[1]).toMatchObject({
      sessionToken: "first-session",
      lifecycleState: "started",
    });
  });

  it("caps retained in-memory telemetry records", async () => {
    const store = new JsonMetricsStore();

    for (let i = 0; i < 10005; i += 1) {
      await store.recordGameplay({
        sessionToken: `session-${i}`,
        nickname: "captest",
        lifecycleState: "started",
        createdAt: new Date(1_000 + i),
      });
    }

    const history = await store.getPlayerHistory("captest");
    expect(history).toHaveLength(10000);
    expect(history[0].sessionToken).toBe("session-10004");
    expect(history[history.length - 1]?.sessionToken).toBe("session-5");
  });

  it("logs only a short session token prefix", async () => {
    const store = new JsonMetricsStore();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await store.recordGameplay({
      sessionToken: "12345678-1234-1234-1234-123456789abc",
      nickname: "player1",
      lifecycleState: "started",
    });

    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain("12345678-1234-1234-1234-123456789abc");
  });

  it("defaults completed to true when lifecycle state is omitted", async () => {
    const store = new JsonMetricsStore();

    await store.recordGameplay({
      sessionToken: "default-state-session",
      nickname: "default-state-player",
    });

    const history = await store.getPlayerHistory("default-state-player");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      lifecycleState: "completed",
      completed: true,
    });
  });

  it("detects an existing lifecycle event for a session token", async () => {
    const store = new JsonMetricsStore();

    await store.recordGameplay({
      sessionToken: "session-1",
      lifecycleState: "completed",
    });

    await expect(store.hasLifecycleEvent("session-1", "completed")).resolves.toBe(true);
    await expect(store.hasLifecycleEvent("session-1", "started")).resolves.toBe(false);
    await expect(store.hasLifecycleEvent("session-2", "completed")).resolves.toBe(false);
  });
});
