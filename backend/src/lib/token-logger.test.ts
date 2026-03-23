import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logTokenUsage, logTokenError, getTokenMetrics, _resetForTests, type TokenUsageEntry } from "./token-logger";

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
    _resetForTests();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs token usage and accumulates per-route totals", () => {
    logTokenUsage(makeEntry({ route: "chat", promptTokens: 100, completionTokens: 50 }));
    logTokenUsage(makeEntry({ route: "chat", promptTokens: 200, completionTokens: 100 }));
    logTokenUsage(makeEntry({ route: "command", promptTokens: 80, completionTokens: 40 }));

    const metrics = getTokenMetrics();
    expect(metrics.perRoute.chat.requests).toBe(2);
    expect(metrics.perRoute.chat.promptTokens).toBe(300);
    expect(metrics.perRoute.chat.completionTokens).toBe(150);
    expect(metrics.perRoute.command.requests).toBe(1);
    expect(metrics.recentEntries.length).toBe(3);
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

  it("includes deployment in log when present", () => {
    logTokenUsage(makeEntry({ model: "gpt-5.2", deployment: "my-deploy" }));
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("deployment=my-deploy")
    );
  });

  it("tracks errors per route", () => {
    logTokenError("command", "test error");
    const metrics = getTokenMetrics();
    expect(metrics.perRoute.command.errors).toBe(1);
  });

  it("sanitizes error strings to prevent log injection", () => {
    logTokenError("chat", 'line1\nline2\r"injected"');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/error="line1 line2 {2}injected "/)
    );
  });

  it("includes compaction info in log when compacted", () => {
    logTokenUsage(makeEntry({ compacted: true, compactedMessageCount: 12 }));
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("compacted=12msgs")
    );
  });

  it("returns deep copies from getTokenMetrics", () => {
    logTokenUsage(makeEntry());
    const m1 = getTokenMetrics();
    m1.perRoute.chat.requests = 999;
    m1.recentEntries[0].promptTokens = 999;

    const m2 = getTokenMetrics();
    expect(m2.perRoute.chat.requests).toBe(1);
    expect(m2.recentEntries[0].promptTokens).toBe(100);
  });
});
