import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
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
  recordedKeys: string[];
}> {
  vi.resetModules();
  const consumedKeys: string[] = [];
  const consumedWindowsMs: number[] = [];
  const recordedKeys: string[] = [];
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
    // Kept separate from `consumedKeys` because the whole difference between
    // the two operations is that this one cannot decline, so a ledger that
    // merged them could not tell a charged retry from a refused one.
    recordSharedWindow: vi.fn(
      async (key: string, windowMs: number, limit: number, nowMs: number) => {
        recordedKeys.push(key);
        const used = (counts.get(key) ?? 0) + 1;
        counts.set(key, used);
        return {
          record: {
            remaining: Math.max(0, limit - used),
            resetAtMs: nowMs + windowMs,
          },
          distributed: false,
        };
      },
    ),
  }));
  return {
    budget: await import("./ai-budget"),
    consumedKeys,
    consumedWindowsMs,
    recordedKeys,
  };
}

/**
 * Same, with the *real* in-process store behind a seam that can break the day
 * window alone. Delegating the counting to the real store is what makes the
 * case that uses this behavioural: what it asserts is whether a later request
 * is allowed, which only the store can decide, rather than a call count a
 * hand-written double would have kept.
 */
async function loadBudgetWithFailingDayWindow(): Promise<{
  budget: typeof import("./ai-budget");
  failDayWindow: (failing: boolean) => void;
}> {
  vi.resetModules();
  let failing = false;
  vi.doMock("./rate-limit", async () => {
    const actual = await vi.importActual<typeof import("./rate-limit")>("./rate-limit");
    return {
      ...actual,
      consumeSharedWindow: async (key: string, ...rest: unknown[]) => {
        if (failing && key.startsWith("global:ai:day:")) {
          throw new Error("budget store unavailable");
        }
        return (actual.consumeSharedWindow as never as (
          ...args: unknown[]
        ) => Promise<unknown>)(key, ...rest);
      },
    };
  });

  return {
    budget: await import("./ai-budget"),
    failDayWindow: (nextFailing: boolean) => {
      failing = nextFailing;
    },
  };
}

/** Same, with the shared window store replaced by one that cannot answer. */
async function loadBudgetWithBrokenStore(): Promise<typeof import("./ai-budget")> {
  vi.resetModules();
  vi.doMock("./rate-limit", () => ({
    consumeSharedWindow: vi.fn(async () => {
      throw new Error("budget store unavailable");
    }),
    recordSharedWindow: vi.fn(async () => {
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

  it("hands the minute slot back when the day window fails after it was charged", async () => {
    // One slot for the whole minute, so the next request's fate is a direct
    // readout of whether the refused one is still holding it.
    process.env.AI_GLOBAL_MINUTE_MAX = "1";
    const { budget, failDayWindow } = await loadBudgetWithFailingDayWindow();

    failDayWindow(true);
    const refused = await charge(budget.chargeAiBudget);
    expect(refused.outcome).toBe("exhausted");
    expect(refused.res.headers["x-sresim-ai-budget"]).toBe("store-unavailable");

    failDayWindow(false);
    const afterRecovery = await charge(budget.chargeAiBudget);

    // The minute is charged before the day is, so the refused request took a
    // slot and then reached no provider. Without the compensating release it
    // keeps that slot until the window rolls, and this request -- arriving
    // after the store recovered -- is refused 429 for spending someone else
    // never did.
    expect(afterRecovery.outcome).toBe("ok");
    expect(afterRecovery.res.statusCode).toBeNull();
    expect(afterRecovery.res.headers["x-sresim-ai-budget"]).toBe("ok");
  });

  it("hands the minute slot back when a spent day is answered with simulated output", async () => {
    // Two slots a minute, one for the whole day. Every request after the first
    // is answered from the simulated path and reaches no provider, so five of
    // them must not be able to fill a window that holds two.
    process.env.AI_GLOBAL_MINUTE_MAX = "2";
    process.env.AI_GLOBAL_DAILY_MAX = "1";
    const budget = await loadBudget();

    expect((await charge(budget.chargeAiBudget)).outcome).toBe("ok");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const degraded = await charge(budget.chargeAiBudget);
      expect(degraded.outcome, `attempt ${attempt + 1}`).toBe("exhausted");
      expect(degraded.res.headers["x-sresim-ai-budget"]).toBe("daily-exhausted");
      expect(degraded.res.statusCode).toBeNull();
    }
  });

  it("keeps a spent day from being reported as a minute refusal", async () => {
    // Same shape with degradation off, where the leak is visible to the client
    // rather than only to the next caller: a minute scope tells them to retry
    // in seconds for a budget that does not come back until tomorrow.
    process.env.AI_GLOBAL_MINUTE_MAX = "2";
    process.env.AI_GLOBAL_DAILY_MAX = "1";
    process.env.AI_GLOBAL_DAILY_EXHAUSTED_MODE = "reject";
    const budget = await loadBudget();

    expect((await charge(budget.chargeAiBudget)).outcome).toBe("ok");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const refused = await charge(budget.chargeAiBudget);
      expect(refused.outcome, `attempt ${attempt + 1}`).toBe("answered");
      expect(refused.res.statusCode).toBe(429);
      expect(refused.res.body?.scope, `attempt ${attempt + 1}`).toBe("daily");
      expect(refused.res.headers["x-sresim-ai-budget"]).toBe("daily-exhausted");
    }
  });

  it("reports the minute slot it gave back, not the one the refusal briefly held", async () => {
    // The snapshot reads the remembered decision rather than the store, and
    // the decision was remembered before the release. Left uncorrected the
    // banner under-reports the minute window for the rest of the window.
    process.env.AI_GLOBAL_MINUTE_MAX = "5";
    process.env.AI_GLOBAL_DAILY_MAX = "1";
    const { chargeAiBudget, getAiBudgetSnapshot } = await loadBudget();

    await charge(chargeAiBudget);
    await expect(getAiBudgetSnapshot()).resolves.toMatchObject({ minuteRemaining: 4 });

    const degraded = await charge(chargeAiBudget);
    expect(degraded.outcome).toBe("exhausted");
    await expect(getAiBudgetSnapshot()).resolves.toMatchObject({ minuteRemaining: 4 });
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

describe("chargeAiProviderRetry", () => {
  beforeEach(() => {
    restoreTestEnv();
    vi.doUnmock("./rate-limit");
    process.env.AI_PROVIDER = "openrouter";
    delete process.env.AI_MOCK_MODE;
  });

  afterEach(() => {
    restoreTestEnv();
  });

  afterAll(() => {
    restoreTestEnv();
  });

  it("charges a second provider request the route never paid for", async () => {
    const { budget, consumedKeys, recordedKeys } = await loadBudgetWithRecordingStore();

    await charge(budget.chargeAiBudget);
    await budget.chargeAiProviderRetry();

    const dayKey = `global:ai:day:${new Date().toISOString().slice(0, 10)}`;
    expect(consumedKeys).toEqual(["global:ai:minute", dayKey]);
    expect(recordedKeys).toEqual(["global:ai:minute", dayKey]);
  });

  it("charges both windows even when the minute window is already spent", async () => {
    // The opposite of chargeAiBudget's ordering rule, on purpose: that rule
    // holds because a caller refused on the minute window never reached the
    // provider. This request is already going out, so skipping either window
    // would under-count a spend that really happens.
    process.env.AI_GLOBAL_MINUTE_MAX = "1";
    const { budget, recordedKeys } = await loadBudgetWithRecordingStore();

    await charge(budget.chargeAiBudget);
    await budget.chargeAiProviderRetry();

    const dayKey = `global:ai:day:${new Date().toISOString().slice(0, 10)}`;
    expect(recordedKeys).toEqual(["global:ai:minute", dayKey]);
  });

  it("charges nothing when the limiter is off", async () => {
    process.env.AI_PROVIDER = "azure";
    const { budget, consumedKeys, recordedKeys } = await loadBudgetWithRecordingStore();

    await budget.chargeAiProviderRetry();

    expect(consumedKeys).toEqual([]);
    expect(recordedKeys).toEqual([]);
  });

  it("swallows a store outage rather than losing an answer already paid for", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { chargeAiProviderRetry } = await loadBudgetWithBrokenStore();

    await expect(chargeAiProviderRetry()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("still occupies the minute window after the requests it overran expire", async () => {
    // The sharp edge of recording rather than consuming, and the one a call
    // count cannot show. Two retries go out while the minute window is full:
    // a consume would add nothing, so a minute later the window would read
    // empty and the deployment would sail past the provider's per-minute cap
    // on requests it had already made.
    process.env.AI_GLOBAL_MINUTE_MAX = "2";
    const { chargeAiBudget, chargeAiProviderRetry } = await loadBudget();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-18T12:00:00.000Z"));
      const first = await charge(chargeAiBudget);
      const second = await charge(chargeAiBudget);

      // Mid-window, so these two entries outlive the two above.
      vi.setSystemTime(new Date("2026-09-18T12:00:30.000Z"));
      await chargeAiProviderRetry();
      await chargeAiProviderRetry();

      // Past the first pair's expiry, inside the retries'.
      vi.setSystemTime(new Date("2026-09-18T12:01:01.000Z"));
      const afterRollover = await charge(chargeAiBudget);

      expect(first.outcome).toBe("ok");
      expect(second.outcome).toBe("ok");
      // `answered`, not `exhausted`: a minute overrun is a 429 the middleware
      // writes itself, because the window rolls in under a minute and a retry
      // genuinely helps. `exhausted` is the daily scope's degrade signal.
      expect(afterRollover.outcome).toBe("answered");
      expect(afterRollover.res.statusCode).toBe(429);
      expect(afterRollover.res.headers["x-sresim-ai-budget"]).toBe("minute-exhausted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes the overspend visible to the next caller", async () => {
    // The point of charging a retry is not bookkeeping for its own sake: it
    // is that the request after it gets refused on time.
    process.env.AI_GLOBAL_DAILY_MAX = "2";
    const { chargeAiBudget, chargeAiProviderRetry } = await loadBudget();

    const first = await charge(chargeAiBudget);
    await chargeAiProviderRetry();
    const third = await charge(chargeAiBudget);

    expect(first.outcome).toBe("ok");
    expect(third.outcome).toBe("exhausted");
    expect(third.res.headers["x-sresim-ai-budget"]).toBe("daily-exhausted");
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
      exhaustedBehaviour: "simulated",
      resetAt: null,
      upstream: null,
    });
  });

  it("reports that a spent budget is answered 429, not simulated", async () => {
    // The banner cannot tell which exhaustion the next request will hit, so a
    // deployment that rejects on either path must not be described as playable.
    process.env.AI_GLOBAL_DAILY_EXHAUSTED_MODE = "reject";
    const { getAiBudgetSnapshot } = await loadBudget();

    await expect(getAiBudgetSnapshot()).resolves.toMatchObject({
      exhaustedBehaviour: "rejected",
    });
  });

  it("reports rejected when provider quota failures are not degraded", async () => {
    process.env.AI_DEGRADE_ON_QUOTA_EXHAUSTED = "false";
    const { getAiBudgetSnapshot } = await loadBudget();

    await expect(getAiBudgetSnapshot()).resolves.toMatchObject({
      exhaustedBehaviour: "rejected",
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

  it("dates the reset when only the provider knows the day is spent", async () => {
    // The local counter is untouched -- this process has served nothing today --
    // but the banner reads the provider's pair in preference to it, so it
    // renders the exhausted copy. Without a reset the copy promises simulated
    // answers with no indication of when real ones return.
    process.env.AI_OPENROUTER_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: { free_model_daily_requests: { used: 50, limit: 50, remaining: 0 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ));
    const { getAiBudgetSnapshot } = await loadBudget();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-18T12:00:00.000Z"));

      const snapshot = await getAiBudgetSnapshot();

      expect(snapshot.upstream).toEqual({ dailyLimit: 50, dailyRemaining: 0 });
      expect(snapshot.dailyRemaining).toBe(1000);
      expect(snapshot.resetAt).toBe("2026-09-19T00:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays quiet about a reset the banner will not show", async () => {
    // An incomplete upstream reading sends the banner back to the local pair,
    // which is healthy, so nothing is exhausted and there is nothing to date.
    // The gate has to mirror that both-or-neither rule or it dates a message
    // no one sees.
    process.env.AI_OPENROUTER_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: { free_model_daily_requests: { used: 50, remaining: 0 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ));
    const { getAiBudgetSnapshot } = await loadBudget();

    const snapshot = await getAiBudgetSnapshot();

    expect(snapshot.upstream).toEqual({ dailyLimit: null, dailyRemaining: 0 });
    expect(snapshot.resetAt).toBeNull();
  });

  it("calls the deployment degraded when only the provider knows the day is spent", async () => {
    // `/api/ai/budget` is documented, and a response carrying
    // `upstream.dailyRemaining: 0` beside `degraded: false` contradicts
    // itself: this process has local slots left, but every one of them now
    // buys a refusal from the provider. Only the banner's own fallback
    // noticed, so anything else reading the endpoint was told the deployment
    // was healthy.
    process.env.AI_OPENROUTER_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: { free_model_daily_requests: { used: 50, limit: 50, remaining: 0 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ));
    const { getAiBudgetSnapshot } = await loadBudget();

    const snapshot = await getAiBudgetSnapshot();

    // The local counter is untouched, so this is the upstream half alone.
    expect(snapshot.dailyRemaining).toBe(1000);
    expect(snapshot.degraded).toBe(true);
  });

  it("does not call it degraded on a partial reading from the provider", async () => {
    // Same both-or-neither gate the reset uses. A reading with no limit is a
    // reading, not a zero, and degrading on it would tell every consumer the
    // deployment is spent because one field was missing from an answer the
    // provider was under no obligation to give.
    process.env.AI_OPENROUTER_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: { free_model_daily_requests: { used: 50, remaining: 0 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ));
    const { getAiBudgetSnapshot } = await loadBudget();

    const snapshot = await getAiBudgetSnapshot();

    expect(snapshot.upstream).toEqual({ dailyLimit: null, dailyRemaining: 0 });
    expect(snapshot.degraded).toBe(false);
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

describe("the charge contract's own documentation", () => {
  // `chargeAiBudget` is called by the routes rather than mounted as
  // middleware, so the count in its docblock is the only inventory of who
  // charges the shared account -- and it is what a reader consults before
  // adding a route. It had already drifted once, from three to four, when the
  // live probe gained a charge in this PR. A doc claim is a claim.
  const NUMERALS: Record<number, string> = { 2: "two", 3: "three", 4: "four", 5: "five", 6: "six" };
  // Vitest runs from `backend/`, the convention the other source-reading
  // suite (`integration/helm-runtime-contracts.test.ts`) already follows.
  const routesDir = resolve(process.cwd(), "src/routes");

  it("counts the routes that actually charge", () => {
    const callSites = readdirSync(routesDir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .filter((name) =>
        readFileSync(resolve(routesDir, name), "utf8").includes("chargeAiBudget(res)"),
      );

    const source = readFileSync(resolve(process.cwd(), "src/lib/ai-budget.ts"), "utf8");
    const documented = NUMERALS[callSites.length];

    expect(documented, `no numeral for ${callSites.length} call sites`).toBeDefined();
    expect(source).toContain(`of the ${documented} call sites`);
  });

  // The same failure one file over: the runtime doc told operators that
  // `GET /api/ai/budget` is rationed by the per-identity `aiRateLimit`, two
  // lines of code after the route registered a different limiter with a
  // twenty-fold larger cap. Reading the name out of the route is what keeps
  // the claim tied to the registration rather than to whatever was true once.
  it("names the limiter the budget route actually registers", () => {
    const routeSource = readFileSync(resolve(routesDir, "ai.ts"), "utf8");
    const registered = /aiRouter\.get\(\s*"\/budget",\s*(\w+)/.exec(routeSource)?.[1];
    expect(registered, "no middleware registered on GET /budget").toBeDefined();

    const runtimeDoc = readFileSync(
      resolve(process.cwd(), "../docs/AI_RUNTIME.md"),
      "utf8",
    );
    const section = runtimeDoc
      .split("### `GET /api/ai/budget`")[1]
      ?.split("\n### ")[0];
    expect(section, "no GET /api/ai/budget section in docs/AI_RUNTIME.md").toBeDefined();
    expect(section).toContain(`\`${registered}\``);
  });
});
