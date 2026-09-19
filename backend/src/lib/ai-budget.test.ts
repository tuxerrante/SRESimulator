import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import type { AiBudgetOutcome } from "./ai-budget";

const TEST_ENV_KEYS = [
  "AI_PROVIDER",
  "AI_MOCK_MODE",
  "AI_GLOBAL_BUDGET_ENABLED",
  "AI_GLOBAL_DAILY_MAX",
  "AI_GLOBAL_MINUTE_MAX",
  "AI_GLOBAL_DAILY_EXHAUSTED_MODE",
  "AI_GLOBAL_BUDGET_FAIL_MODE",
  "AI_DEGRADE_ON_QUOTA_EXHAUSTED",
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
  getHeader: (name: string) => string | undefined;
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
    getHeader(name) {
      return response.headers[name.toLowerCase()];
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

interface ChargeResult {
  res: FakeResponse;
  outcome: AiBudgetOutcome;
}

/**
 * The budget is charged by the route, not by middleware, so a case exercises
 * it the way a route does: hand it a response and read the outcome back.
 */
async function charge(
  chargeAiBudget: (res: Response) => Promise<AiBudgetOutcome>,
): Promise<ChargeResult> {
  const res = createResponse();
  const outcome = await chargeAiBudget(res as unknown as Response);
  return { res, outcome };
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
 * only reports the last decision the charge *remembered*, so it cannot see a
 * window that was charged and then discarded -- only the store can.
 */
async function loadBudgetWithRecordingStore(): Promise<{
  budget: typeof import("./ai-budget");
  consumedKeys: string[];
  consumedWindowsMs: number[];
}> {
  vi.resetModules();
  const consumedKeys: string[] = [];
  const consumedWindowsMs: number[] = [];
  const counts = new Map<string, number>();
  vi.doMock("./rate-limit", () => ({
    consumeSharedWindow: vi.fn(
      async (key: string, windowMs: number, limit: number, nowMs: number) => {
        consumedKeys.push(key);
        consumedWindowsMs.push(windowMs);
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
  return { budget: await import("./ai-budget"), consumedKeys, consumedWindowsMs };
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

describe("chargeAiBudget", () => {
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
    const { chargeAiBudget } = await loadBudget();

    const first = await charge(chargeAiBudget);
    const second = await charge(chargeAiBudget);

    expect(first.outcome).toBe("ok");
    // The minute limit of 1 would have refused this one if the budget were on.
    expect(second.outcome).toBe("ok");
    expect(second.res.statusCode).toBeNull();
    expect(second.res.headers).toEqual({});
  });

  it("can be switched on explicitly for another provider", async () => {
    process.env.AI_PROVIDER = "azure";
    process.env.AI_GLOBAL_BUDGET_ENABLED = "true";
    const { chargeAiBudget } = await loadBudget();

    const { res, outcome } = await charge(chargeAiBudget);

    expect(outcome).toBe("ok");
    expect(res.headers["x-sresim-ai-budget"]).toBe("ok");
  });

  it("labels an affordable request ok and lets the route proceed", async () => {
    const { chargeAiBudget } = await loadBudget();

    const { res, outcome } = await charge(chargeAiBudget);

    expect(outcome).toBe("ok");
    expect(res.statusCode).toBeNull();
    expect(res.headers["x-sresim-ai-budget"]).toBe("ok");
  });

  it("refuses a minute overrun with a retryable 429", async () => {
    process.env.AI_GLOBAL_MINUTE_MAX = "1";
    const { chargeAiBudget } = await loadBudget();

    await charge(chargeAiBudget);
    const { res, outcome } = await charge(chargeAiBudget);

    expect(outcome).toBe("answered");
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
    const { chargeAiBudget, getAiBudgetSnapshot } = budget;

    await charge(chargeAiBudget);
    const refusedFirst = await charge(chargeAiBudget);
    const refusedSecond = await charge(chargeAiBudget);

    expect(refusedFirst.res.statusCode).toBe(429);
    expect(refusedSecond.res.statusCode).toBe(429);
    // One request reached the provider, so exactly one day slot is spent. The
    // two refusals never left the process and must not cost anything -- which
    // is a claim about the store, not about what the snapshot reports.
    expect(consumedKeys).toEqual([
      "global:ai:minute",
      `global:ai:day:${new Date().toISOString().slice(0, 10)}`,
      "global:ai:minute",
      "global:ai:minute",
    ]);
    await expect(getAiBudgetSnapshot()).resolves.toMatchObject({
      dailyLimit: 5,
      dailyRemaining: 4,
    });
  });

  it("hands a spent day back to the route rather than answering for it", async () => {
    process.env.AI_GLOBAL_DAILY_MAX = "1";
    const { chargeAiBudget } = await loadBudget();

    await charge(chargeAiBudget);
    const { res, outcome } = await charge(chargeAiBudget);

    expect(outcome).toBe("exhausted");
    expect(res.statusCode).toBeNull();
    // The header states what was observed, not how the route will answer:
    // chat and command turn AI_DEGRADE_ON_QUOTA_EXHAUSTED=false into a 429
    // while scenario still returns a playable catalog session, so a header
    // promising `degraded` here would be wrong on two routes out of three --
    // and it is written before the answer exists. The route that does answer
    // with simulated output calls `markAiBudgetDegraded` (below).
    expect(res.headers["x-sresim-ai-budget"]).toBe("daily-exhausted");
  });

  it("counts the day by UTC calendar date, not by a rolling 24 hours", async () => {
    process.env.AI_GLOBAL_DAILY_MAX = "1";
    const { budget, consumedKeys, consumedWindowsMs } =
      await loadBudgetWithRecordingStore();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-18T23:59:00.000Z"));
      const lastNight = await charge(budget.chargeAiBudget);

      // Ten minutes later, one minute into the next UTC day. OpenRouter has
      // already reset the account's free-model allowance; a 24-hour sliding
      // window would still be refusing until 23:59 tomorrow.
      vi.setSystemTime(new Date("2026-09-19T00:01:00.000Z"));
      const thisMorning = await charge(budget.chargeAiBudget);

      expect(lastNight.outcome).toBe("ok");
      expect(thisMorning.outcome).toBe("ok");
      expect(consumedKeys).toEqual([
        "global:ai:minute",
        "global:ai:day:2026-09-18",
        "global:ai:minute",
        "global:ai:day:2026-09-19",
      ]);
      // The window handed to the store stays 24 hours even though the key
      // rolls at midnight: it is the key's TTL, and shortening it to "time
      // since midnight" would expire the counter after a quiet minute early
      // in the day and silently reset the spend.
      expect(consumedWindowsMs).toEqual([60_000, 86_400_000, 60_000, 86_400_000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("points a spent day at the next UTC midnight, not at the oldest request", async () => {
    process.env.AI_GLOBAL_DAILY_MAX = "1";
    process.env.AI_GLOBAL_DAILY_EXHAUSTED_MODE = "reject";
    const { chargeAiBudget } = await loadBudget();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-18T18:00:00.000Z"));
      await charge(chargeAiBudget);
      const { res } = await charge(chargeAiBudget);

      // The store's own answer would be the oldest entry plus 24 hours, which
      // is the sliding window this key deliberately is not.
      expect(res.body?.resetAt).toBe("2026-09-19T00:00:00.000Z");
      expect(res.headers["retry-after"]).toBe(String(6 * 60 * 60));
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects the daily overrun instead when the mode says reject", async () => {
    process.env.AI_GLOBAL_DAILY_MAX = "1";
    process.env.AI_GLOBAL_DAILY_EXHAUSTED_MODE = "reject";
    const { chargeAiBudget } = await loadBudget();

    await charge(chargeAiBudget);
    const { res, outcome } = await charge(chargeAiBudget);

    expect(outcome).toBe("answered");
    expect(res.statusCode).toBe(429);
    expect(res.headers["x-sresim-ai-budget"]).toBe("daily-exhausted");
    expect(res.body).toMatchObject({ code: "ai_budget_exhausted", scope: "daily" });
  });

  it("does not let AI_DEGRADE_ON_QUOTA_EXHAUSTED decide this limiter's answer", async () => {
    // The two switches are about different things and were briefly conflated.
    // `AI_GLOBAL_DAILY_EXHAUSTED_MODE` is this limiter's: reject, or hand
    // back. `AI_DEGRADE_ON_QUOTA_EXHAUSTED` is the routes', and scenario
    // reads it as a relabel rather than a refusal -- so reading it here would
    // have turned a playable catalog session into a 429.
    process.env.AI_GLOBAL_DAILY_MAX = "1";
    process.env.AI_DEGRADE_ON_QUOTA_EXHAUSTED = "false";
    const { chargeAiBudget } = await loadBudget();

    await charge(chargeAiBudget);
    const { res, outcome } = await charge(chargeAiBudget);

    expect(outcome).toBe("exhausted");
    expect(res.statusCode).toBeNull();
  });

  it("fails closed when the budget store cannot answer", async () => {
    const { chargeAiBudget } = await loadBudgetWithBrokenStore();

    const { res, outcome } = await charge(chargeAiBudget);

    // Closed, not open: an unreadable counter must never authorise spending on
    // a shared account. It is affordable only because the route degrades.
    expect(outcome).toBe("exhausted");
    // Not `daily-exhausted`: nothing was observed here, let alone spent, and
    // an operator reading headers during an incident needs the outage to be
    // distinguishable from a real cap.
    expect(res.headers["x-sresim-ai-budget"]).toBe("store-unavailable");
  });

  it("says the store is unreadable, not that the day is spent, when it refuses", async () => {
    process.env.AI_GLOBAL_DAILY_EXHAUSTED_MODE = "reject";
    const { chargeAiBudget } = await loadBudgetWithBrokenStore();

    const { res, outcome } = await charge(chargeAiBudget);

    expect(outcome).toBe("answered");
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

    const first = await charge(budget.chargeAiBudget);
    const second = await charge(budget.chargeAiBudget);

    // The minute limit of 1 would have refused the second request if the
    // budget were charged. The free-e2e gate drives four players through this
    // path with AI_MOCK_MODE=true.
    expect(first.outcome).toBe("ok");
    expect(second.outcome).toBe("ok");
    expect(second.res.headers).toEqual({});
    expect(consumedKeys).toEqual([]);
  });

  it("fails open only when explicitly configured to", async () => {
    process.env.AI_GLOBAL_BUDGET_FAIL_MODE = "open";
    const { chargeAiBudget } = await loadBudgetWithBrokenStore();

    const { res, outcome } = await charge(chargeAiBudget);

    expect(outcome).toBe("ok");
    expect(res.headers["x-sresim-ai-budget"]).toBe("fail-open");
  });
});

describe("markAiBudgetDegraded", () => {
  beforeEach(() => {
    restoreTestEnv();
    vi.doUnmock("./rate-limit");
    process.env.AI_PROVIDER = "openrouter";
    delete process.env.AI_MOCK_MODE;
  });

  afterEach(() => {
    restoreTestEnv();
  });

  it("lets the route say the answer it sent is simulated", async () => {
    process.env.AI_GLOBAL_DAILY_MAX = "1";
    const { chargeAiBudget, markAiBudgetDegraded } = await loadBudget();

    await charge(chargeAiBudget);
    const { res, outcome } = await charge(chargeAiBudget);
    markAiBudgetDegraded(res as unknown as Response);

    // `degraded` is a claim about the response body, so only the route that
    // wrote one may make it -- and the documented header contract has to name
    // a value the code actually emits.
    expect(outcome).toBe("exhausted");
    expect(res.headers["x-sresim-ai-budget"]).toBe("degraded");
  });

  it("keeps a store outage distinguishable from a spent account", async () => {
    const { chargeAiBudget, markAiBudgetDegraded } = await loadBudgetWithBrokenStore();

    const { res, outcome } = await charge(chargeAiBudget);
    markAiBudgetDegraded(res as unknown as Response);

    // The answer is equally simulated either way, but this header is the only
    // signal that the window store, not the account, is what degraded the
    // deployment -- which is what an operator reads during an incident.
    expect(outcome).toBe("exhausted");
    expect(res.headers["x-sresim-ai-budget"]).toBe("store-unavailable");
  });

  it("says nothing about a response the budget never intervened in", async () => {
    const { chargeAiBudget, markAiBudgetDegraded } = await loadBudget();

    const { res, outcome } = await charge(chargeAiBudget);
    markAiBudgetDegraded(res as unknown as Response);

    // The command route calls this from a catch that also handles a provider
    // -side quota exhaustion, where the shared budget was affordable.
    expect(outcome).toBe("ok");
    expect(res.headers["x-sresim-ai-budget"]).toBe("ok");
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
    const { chargeAiBudget, getAiBudgetSnapshot } = await loadBudget();

    await getAiBudgetSnapshot();
    await getAiBudgetSnapshot();
    const { res, outcome } = await charge(chargeAiBudget);

    // The banner polls this endpoint; if describing the budget consumed it, a
    // visitor watching the page would exhaust the day on their own.
    expect(outcome).toBe("ok");
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
    const { chargeAiBudget, getAiBudgetSnapshot } = await loadBudget();

    await charge(chargeAiBudget);
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
    const { chargeAiBudget, getAiBudgetSnapshot } = await loadBudget();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-18T12:00:00.000Z"));
      await charge(chargeAiBudget);
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
