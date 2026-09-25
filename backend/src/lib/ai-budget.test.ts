import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, RequestHandler, Response } from "express";

const TEST_ENV_KEYS = [
  "AI_PROVIDER",
  "AI_MOCK_MODE",
  "AI_GLOBAL_BUDGET_ENABLED",
  "AI_GLOBAL_DAILY_MAX",
  "AI_GLOBAL_MINUTE_MAX",
  "AI_GLOBAL_DAILY_EXHAUSTED_MODE",
  "AI_GLOBAL_BUDGET_FAIL_MODE",
  "AI_RATE_LIMIT_REDIS_URL",
  "AI_OPENROUTER_API_KEY",
  "AI_OPENROUTER_BASE_URL",
  "AI_OPENROUTER_QUOTA_TTL_MS",
] as const;

const ORIGINAL_ENV_VALUES: Record<string, string | undefined> = {};
for (const key of TEST_ENV_KEYS) {
  ORIGINAL_ENV_VALUES[key] = process.env[key];
}

function restoreTestEnv(): void {
  for (const key of TEST_ENV_KEYS) {
    const originalValue = ORIGINAL_ENV_VALUES[key];
    if (originalValue === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = originalValue;
  }
}

interface FakeResponse {
  locals: Record<string, unknown>;
  headers: Record<string, string>;
  statusCode: number | null;
  body: Record<string, unknown> | null;
  setHeader: (name: string, value: string | number) => void;
  status: (code: number) => FakeResponse;
  json: (payload: Record<string, unknown>) => FakeResponse;
}

function createResponse(): FakeResponse {
  const response: FakeResponse = {
    locals: {},
    headers: {},
    statusCode: null,
    body: null,
    setHeader(name, value) {
      response.headers[name.toLowerCase()] = String(value);
    },
    status(code) {
      response.statusCode = code;
      return response;
    },
    json(payload) {
      response.body = payload;
      return response;
    },
  };
  return response;
}

interface RunResult {
  res: FakeResponse;
  nextCalls: number;
}

async function run(handler: RequestHandler): Promise<RunResult> {
  const res = createResponse();
  let nextCalls = 0;
  await (handler(
    {} as Request,
    res as unknown as Response,
    () => {
      nextCalls += 1;
    },
  ) as unknown as Promise<void>);
  return { res, nextCalls };
}

/**
 * Both the window memory in ai-budget and the in-process sliding-window store
 * in rate-limit are module singletons, so every case gets its own module graph
 * rather than a shared counter carried over from the previous test.
 */
async function loadBudget(): Promise<typeof import("./ai-budget")> {
  vi.resetModules();
  return import("./ai-budget");
}

/**
 * Same, with a store that records which windows were consumed. The snapshot
 * only reports the last decision the middleware *remembered*, so it cannot see
 * a window that was charged and then discarded -- only the store can.
 */
async function loadBudgetWithRecordingStore(): Promise<{
  budget: typeof import("./ai-budget");
  consumedKeys: string[];
}> {
  vi.resetModules();
  const consumedKeys: string[] = [];
  const counts = new Map<string, number>();
  vi.doMock("./rate-limit", () => ({
    consumeSharedWindow: vi.fn(
      async (key: string, windowMs: number, limit: number, nowMs: number) => {
        consumedKeys.push(key);
        const used = (counts.get(key) ?? 0) + 1;
        counts.set(key, used);
        return {
          decision: {
            allowed: used <= limit,
            remaining: Math.max(0, limit - used),
            resetAtMs: nowMs + windowMs,
            retryAfterSeconds: Math.ceil(windowMs / 1000),
          },
          distributed: false,
        };
      },
    ),
  }));
  return { budget: await import("./ai-budget"), consumedKeys };
}

/** Same, with the shared window store replaced by one that cannot answer. */
async function loadBudgetWithBrokenStore(): Promise<typeof import("./ai-budget")> {
  vi.resetModules();
  vi.doMock("./rate-limit", () => ({
    consumeSharedWindow: vi.fn(async () => {
      throw new Error("budget store unavailable");
    }),
  }));
  return import("./ai-budget");
}

describe("aiGlobalBudgetLimit", () => {
  beforeEach(() => {
    restoreTestEnv();
    vi.doUnmock("./rate-limit");
    vi.unstubAllGlobals();
    process.env.AI_PROVIDER = "openrouter";
    delete process.env.AI_RATE_LIMIT_REDIS_URL;
    delete process.env.AI_OPENROUTER_API_KEY;
    delete process.env.AI_MOCK_MODE;
  });

  afterEach(() => {
    restoreTestEnv();
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    restoreTestEnv();
  });

  it("stays out of the way for providers without a shared free-tier cap", async () => {
    process.env.AI_PROVIDER = "azure";
    process.env.AI_GLOBAL_MINUTE_MAX = "1";
    const { aiGlobalBudgetLimit, isAiBudgetExhausted } = await loadBudget();

    const first = await run(aiGlobalBudgetLimit);
    const second = await run(aiGlobalBudgetLimit);

    expect(first.nextCalls).toBe(1);
    // The minute limit of 1 would have refused this one if the budget were on.
    expect(second.nextCalls).toBe(1);
    expect(second.res.statusCode).toBeNull();
    expect(second.res.headers).toEqual({});
    expect(isAiBudgetExhausted(second.res as unknown as Response)).toBe(false);
  });

  it("can be switched on explicitly for another provider", async () => {
    process.env.AI_PROVIDER = "azure";
    process.env.AI_GLOBAL_BUDGET_ENABLED = "true";
    const { aiGlobalBudgetLimit } = await loadBudget();

    const { res, nextCalls } = await run(aiGlobalBudgetLimit);

    expect(nextCalls).toBe(1);
    expect(res.headers["x-sresim-ai-budget"]).toBe("ok");
  });

  it("labels an affordable request ok and passes it on", async () => {
    const { aiGlobalBudgetLimit, isAiBudgetExhausted } = await loadBudget();

    const { res, nextCalls } = await run(aiGlobalBudgetLimit);

    expect(nextCalls).toBe(1);
    expect(res.statusCode).toBeNull();
    expect(res.headers["x-sresim-ai-budget"]).toBe("ok");
    expect(isAiBudgetExhausted(res as unknown as Response)).toBe(false);
  });

  it("refuses a minute overrun with a retryable 429", async () => {
    process.env.AI_GLOBAL_MINUTE_MAX = "1";
    const { aiGlobalBudgetLimit } = await loadBudget();

    await run(aiGlobalBudgetLimit);
    const { res, nextCalls } = await run(aiGlobalBudgetLimit);

    expect(nextCalls).toBe(0);
    expect(res.statusCode).toBe(429);
    expect(res.headers["x-sresim-ai-budget"]).toBe("minute-exhausted");
    expect(res.headers["retry-after"]).toBeDefined();
    expect(Object.keys(res.body ?? {})[0]).toBe("error");
    expect(res.body).toMatchObject({
      code: "ai_budget_exhausted",
      scope: "minute",
      degraded: false,
    });
    expect(typeof res.body?.resetAt).toBe("string");
  });

  it("does not charge the daily budget for a request the minute window refused", async () => {
    process.env.AI_GLOBAL_MINUTE_MAX = "1";
    process.env.AI_GLOBAL_DAILY_MAX = "5";
    const { budget, consumedKeys } = await loadBudgetWithRecordingStore();
    const { aiGlobalBudgetLimit, getAiBudgetSnapshot } = budget;

    await run(aiGlobalBudgetLimit);
    const refusedFirst = await run(aiGlobalBudgetLimit);
    const refusedSecond = await run(aiGlobalBudgetLimit);

    expect(refusedFirst.res.statusCode).toBe(429);
    expect(refusedSecond.res.statusCode).toBe(429);
    // One request reached the provider, so exactly one day slot is spent. The
    // two refusals never left the process and must not cost anything -- which
    // is a claim about the store, not about what the snapshot reports.
    expect(consumedKeys).toEqual([
      "global:ai:minute",
      "global:ai:day",
      "global:ai:minute",
      "global:ai:minute",
    ]);
    await expect(getAiBudgetSnapshot()).resolves.toMatchObject({
      dailyLimit: 5,
      dailyRemaining: 4,
    });
  });

  it("degrades rather than rejecting when the daily budget is spent", async () => {
    process.env.AI_GLOBAL_DAILY_MAX = "1";
    const { aiGlobalBudgetLimit, isAiBudgetExhausted } = await loadBudget();

    await run(aiGlobalBudgetLimit);
    const { res, nextCalls } = await run(aiGlobalBudgetLimit);

    expect(nextCalls).toBe(1);
    expect(res.statusCode).toBeNull();
    expect(res.headers["x-sresim-ai-budget"]).toBe("degraded");
    expect(isAiBudgetExhausted(res as unknown as Response)).toBe(true);
  });

  it("rejects the daily overrun instead when the mode says reject", async () => {
    process.env.AI_GLOBAL_DAILY_MAX = "1";
    process.env.AI_GLOBAL_DAILY_EXHAUSTED_MODE = "reject";
    const { aiGlobalBudgetLimit, isAiBudgetExhausted } = await loadBudget();

    await run(aiGlobalBudgetLimit);
    const { res, nextCalls } = await run(aiGlobalBudgetLimit);

    expect(nextCalls).toBe(0);
    expect(res.statusCode).toBe(429);
    expect(res.headers["x-sresim-ai-budget"]).toBe("daily-exhausted");
    expect(res.body).toMatchObject({ code: "ai_budget_exhausted", scope: "daily" });
    expect(isAiBudgetExhausted(res as unknown as Response)).toBe(false);
  });

  it("fails closed when the budget store cannot answer", async () => {
    const { aiGlobalBudgetLimit, isAiBudgetExhausted } = await loadBudgetWithBrokenStore();

    const { res, nextCalls } = await run(aiGlobalBudgetLimit);

    // Closed, not open: an unreadable counter must never authorise spending on
    // a shared account. It is affordable only because the route degrades.
    expect(nextCalls).toBe(1);
    expect(res.headers["x-sresim-ai-budget"]).toBe("degraded");
    expect(isAiBudgetExhausted(res as unknown as Response)).toBe(true);
  });

  it("says the store is unreadable, not that the day is spent, when it refuses", async () => {
    process.env.AI_GLOBAL_DAILY_EXHAUSTED_MODE = "reject";
    const { aiGlobalBudgetLimit } = await loadBudgetWithBrokenStore();

    const { res, nextCalls } = await run(aiGlobalBudgetLimit);

    expect(nextCalls).toBe(0);
    // 503, not 429: nothing was observed and nothing was spent. Calling this
    // a daily exhaustion would tell the client to come back tomorrow for what
    // is usually a blip, and would send the operator reading the response
    // looking at the budget instead of at the store.
    expect(res.statusCode).toBe(503);
    expect(res.headers["x-sresim-ai-budget"]).toBe("store-unavailable");
    expect(Object.keys(res.body ?? {})[0]).toBe("error");
    expect(res.body).toMatchObject({ code: "ai_budget_unavailable", degraded: false });
    expect(res.body).not.toHaveProperty("scope");
    expect(res.headers["retry-after"]).toBe("60");
  });

  it("charges nothing in mock mode, where no request reaches a provider", async () => {
    process.env.AI_MOCK_MODE = "true";
    process.env.AI_GLOBAL_MINUTE_MAX = "1";
    const { budget, consumedKeys } = await loadBudgetWithRecordingStore();

    const first = await run(budget.aiGlobalBudgetLimit);
    const second = await run(budget.aiGlobalBudgetLimit);

    // The minute limit of 1 would have refused the second request if the
    // budget were charged. The free-e2e gate drives four players through this
    // path with AI_MOCK_MODE=true.
    expect(first.nextCalls).toBe(1);
    expect(second.nextCalls).toBe(1);
    expect(second.res.headers).toEqual({});
    expect(consumedKeys).toEqual([]);
  });

  it("charges nothing on a route that answers without calling a provider", async () => {
    process.env.AI_GLOBAL_MINUTE_MAX = "1";
    const { budget, consumedKeys } = await loadBudgetWithRecordingStore();
    let callsProvider = false;
    const limit = budget.createAiGlobalBudgetLimit(() => callsProvider);

    const exempt = await run(limit);
    callsProvider = true;
    const billable = await run(limit);

    expect(exempt.nextCalls).toBe(1);
    expect(exempt.res.headers).toEqual({});
    expect(billable.res.headers["x-sresim-ai-budget"]).toBe("ok");
    // The predicate is read per request, not captured at mount time.
    expect(consumedKeys).toEqual(["global:ai:minute", "global:ai:day"]);
  });

  it("fails open only when explicitly configured to", async () => {
    process.env.AI_GLOBAL_BUDGET_FAIL_MODE = "open";
    const { aiGlobalBudgetLimit, isAiBudgetExhausted } = await loadBudgetWithBrokenStore();

    const { res, nextCalls } = await run(aiGlobalBudgetLimit);

    expect(nextCalls).toBe(1);
    expect(res.headers["x-sresim-ai-budget"]).toBe("fail-open");
    expect(isAiBudgetExhausted(res as unknown as Response)).toBe(false);
  });
});

describe("getAiBudgetSnapshot", () => {
  beforeEach(() => {
    restoreTestEnv();
    vi.doUnmock("./rate-limit");
    vi.unstubAllGlobals();
    process.env.AI_PROVIDER = "openrouter";
    delete process.env.AI_RATE_LIMIT_REDIS_URL;
    delete process.env.AI_OPENROUTER_API_KEY;
    delete process.env.AI_MOCK_MODE;
  });

  afterEach(() => {
    restoreTestEnv();
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    restoreTestEnv();
  });

  it("reports the budget without spending any of it", async () => {
    process.env.AI_GLOBAL_DAILY_MAX = "1";
    process.env.AI_GLOBAL_MINUTE_MAX = "1";
    const { aiGlobalBudgetLimit, getAiBudgetSnapshot } = await loadBudget();

    await getAiBudgetSnapshot();
    await getAiBudgetSnapshot();
    const { res, nextCalls } = await run(aiGlobalBudgetLimit);

    // The banner polls this endpoint; if describing the budget consumed it, a
    // visitor watching the page would exhaust the day on their own.
    expect(nextCalls).toBe(1);
    expect(res.headers["x-sresim-ai-budget"]).toBe("ok");
  });

  it("reports the full budget before any request has been made", async () => {
    process.env.AI_GLOBAL_DAILY_MAX = "40";
    process.env.AI_GLOBAL_MINUTE_MAX = "7";
    const { getAiBudgetSnapshot } = await loadBudget();

    await expect(getAiBudgetSnapshot()).resolves.toEqual({
      enabled: true,
      dailyLimit: 40,
      dailyRemaining: 40,
      minuteLimit: 7,
      minuteRemaining: 7,
      degraded: false,
      resetAt: null,
      upstream: null,
    });
  });

  it("reports degraded once the daily budget is spent", async () => {
    process.env.AI_GLOBAL_DAILY_MAX = "1";
    const { aiGlobalBudgetLimit, getAiBudgetSnapshot } = await loadBudget();

    await run(aiGlobalBudgetLimit);
    const snapshot = await getAiBudgetSnapshot();

    expect(snapshot.dailyRemaining).toBe(0);
    expect(snapshot.degraded).toBe(true);
    expect(typeof snapshot.resetAt).toBe("string");
  });

  it("never claims a budget when the limiter is off", async () => {
    process.env.AI_PROVIDER = "vertex";
    const { getAiBudgetSnapshot } = await loadBudget();

    const snapshot = await getAiBudgetSnapshot();

    expect(snapshot.enabled).toBe(false);
    expect(snapshot.degraded).toBe(false);
    expect(snapshot.upstream).toBeNull();
  });

  it("adds the provider's own numbers when a key is configured", async () => {
    process.env.AI_OPENROUTER_API_KEY = "test-key";
    const fetchMock = vi.fn(async () =>
      new Response(
        // The real shape: a nested counter, not two flat siblings.
        JSON.stringify({
          data: { free_model_daily_requests: { used: 60, limit: 1000, remaining: 940 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { getAiBudgetSnapshot } = await loadBudget();

    const snapshot = await getAiBudgetSnapshot();

    expect(snapshot.upstream).toEqual({ dailyLimit: 1000, dailyRemaining: 940 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/key");
    expect(init.headers).toMatchObject({ authorization: "Bearer test-key" });
  });

  it("does not ask OpenRouter about an account that is not serving the traffic", async () => {
    // AI_GLOBAL_BUDGET_ENABLED is honoured on any provider, and a deployment
    // that moved to Azure may still carry the key from an earlier experiment.
    // Reporting that account's quota would describe a budget nothing spends.
    process.env.AI_PROVIDER = "azure";
    process.env.AI_GLOBAL_BUDGET_ENABLED = "true";
    process.env.AI_OPENROUTER_API_KEY = "test-key";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { getAiBudgetSnapshot } = await loadBudget();

    const snapshot = await getAiBudgetSnapshot();

    expect(snapshot.enabled).toBe(true);
    expect(snapshot.upstream).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops calling the day spent once the window it was spent in has rolled", async () => {
    process.env.AI_GLOBAL_DAILY_MAX = "1";
    const { aiGlobalBudgetLimit, getAiBudgetSnapshot } = await loadBudget();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-18T12:00:00.000Z"));
      await run(aiGlobalBudgetLimit);
      const spent = await getAiBudgetSnapshot();
      expect(spent.degraded).toBe(true);

      // A remembered decision describes its own window only. Without expiry
      // the banner would keep saying "simulated" until the next AI request
      // refreshed the map -- the very request the banner discouraged.
      vi.setSystemTime(new Date(Date.parse(spent.resetAt as string) + 1000));
      const rolled = await getAiBudgetSnapshot();

      expect(rolled.degraded).toBe(false);
      expect(rolled.dailyRemaining).toBe(1);
      expect(rolled.resetAt).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still answers when the provider's own numbers are unavailable", async () => {
    process.env.AI_OPENROUTER_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network unreachable");
    }));
    const { getAiBudgetSnapshot } = await loadBudget();

    // A budget display failing is not a reason for the endpoint to fail.
    await expect(getAiBudgetSnapshot()).resolves.toMatchObject({
      enabled: true,
      upstream: null,
    });
  });
});
