import { beforeEach, describe, expect, it, vi } from "vitest";
import { logTokenUsage, logTokenError, getTokenMetrics, type TokenUsageEntry } from "./token-logger";

function makeEntry(overrides: Partial<TokenUsageEntry> = {}): TokenUsageEntry {
  return {
    route: "chat",
    model: "gpt-4o",
    promptTokens: 100,
    completionTokens: 50,
    reasoningTokens: 0,
    totalTokens: 150,
    latencyMs: 500,
    timestamp: Date.now(),
    compacted: false,
    compactedMessageCount: 0,
    ...overrides,
  };
}

describe("token-logger", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("logs token usage and accumulates per-route totals", () => {
    logTokenUsage(makeEntry({ route: "chat", promptTokens: 100, completionTokens: 50 }));
    logTokenUsage(makeEntry({ route: "chat", promptTokens: 200, completionTokens: 100 }));
    logTokenUsage(makeEntry({ route: "command", promptTokens: 80, completionTokens: 40 }));

    const metrics = getTokenMetrics();
    expect(metrics.perRoute.chat.requests).toBeGreaterThanOrEqual(2);
    expect(metrics.perRoute.command.requests).toBeGreaterThanOrEqual(1);
    expect(metrics.recentEntries.length).toBeGreaterThanOrEqual(3);
  });

  it("logs console output with route and model", () => {
    logTokenUsage(makeEntry({ route: "scenario", model: "gpt-5.2" }));
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("route=scenario")
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("model=gpt-5.2")
    );
  });

  it("tracks errors per route", () => {
    const before = getTokenMetrics().perRoute.command.errors;
    logTokenError("command", "test error");
    const after = getTokenMetrics().perRoute.command.errors;
    expect(after).toBe(before + 1);
  });

  it("includes compaction info in log when compacted", () => {
    logTokenUsage(makeEntry({ compacted: true, compactedMessageCount: 12 }));
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("compacted=12msgs")
    );
  });
});
