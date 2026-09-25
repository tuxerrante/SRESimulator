import express from "express";
import { get, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ENV_KEYS = [
  "AI_PROVIDER",
  "AI_GLOBAL_BUDGET_ENABLED",
  "AI_GLOBAL_DAILY_MAX",
  "AI_GLOBAL_MINUTE_MAX",
  "AI_LIVE_PROBE_TOKEN",
  "AI_MOCK_MODE",
  "AI_OPENROUTER_API_KEY",
  "AI_OPENROUTER_MODEL",
  "AI_BUDGET_READ_RATE_LIMIT_MAX",
  "AI_LIVE_PROBE_RATE_LIMIT_MAX",
  "AI_RATE_LIMIT_MAX",
  "AI_RATE_LIMIT_REDIS_URL",
  "NODE_ENV",
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

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

/**
 * Fresh module graph per server: the budget's window memory and the cached
 * provider key lookup are both module singletons by design.
 */
async function loadAiRouter() {
  vi.resetModules();
  return (await import("./ai")).aiRouter;
}

async function withAiServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use("/api/ai", await loadAiRouter());

  const server = await new Promise<Server>((resolve) => {
    const listeningServer = app.listen(0, "127.0.0.1", () => resolve(listeningServer));
  });

  try {
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}/api/ai`);
  } finally {
    await close(server);
  }
}

describe("GET /api/ai/budget", () => {
  beforeEach(() => {
    restoreTestEnv();
    vi.unstubAllGlobals();
    process.env.AI_PROVIDER = "openrouter";
    delete process.env.AI_RATE_LIMIT_REDIS_URL;
  });

  afterEach(() => {
    restoreTestEnv();
    vi.unstubAllGlobals();
  });

  it("answers an unauthenticated caller with the budget the banner needs", async () => {
    process.env.AI_GLOBAL_DAILY_MAX = "50";
    process.env.AI_GLOBAL_MINUTE_MAX = "20";

    await withAiServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/budget`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        enabled: true,
        dailyLimit: 50,
        minuteLimit: 20,
        degraded: false,
      });
    });
  });

  it("carries no key material, because every visitor can read it", async () => {
    process.env.AI_OPENROUTER_API_KEY = "sk-or-secret-value";
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: { free_model_daily_requests: { used: 0, limit: 1000, remaining: 1000 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ));

    const app = express();
    app.use("/api/ai", await loadAiRouter());
    const server = await new Promise<Server>((resolve) => {
      const listeningServer = app.listen(0, "127.0.0.1", () => resolve(listeningServer));
    });

    try {
      const { port } = server.address() as AddressInfo;
      // The stubbed fetch is what the endpoint uses upstream, so the real
      // request here has to go through node:http rather than global fetch.
      const body = await new Promise<string>((resolve, reject) => {
        const request = get(`http://127.0.0.1:${port}/api/ai/budget`, (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => (data += chunk));
          res.on("end", () => resolve(data));
        });
        request.on("error", reject);
      });

      expect(body).not.toContain("sk-or-secret-value");
      expect(JSON.parse(body)).toMatchObject({
        upstream: { dailyLimit: 1000 },
      });
    } finally {
      await close(server);
    }
  });

  it("is rate-limited, unlike the rest of /api/ai", async () => {
    await withAiServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/budget`);

      // The banner reads this endpoint from every visitor, and /api/ai/* is
      // otherwise unlimited.
      expect(response.headers.get("ratelimit-limit")).not.toBeNull();
    });
  });

  it("does not ration the banner at one player's gameplay allowance", async () => {
    // Behind the Next.js proxy every anonymous visitor resolves to the same
    // identity, so a per-player cap would answer the sixteenth home page 429
    // and hide the banner precisely when traffic makes a spent budget likely.
    process.env.AI_RATE_LIMIT_MAX = "1";

    await withAiServer(async (baseUrl) => {
      const first = await fetch(`${baseUrl}/budget`);
      const second = await fetch(`${baseUrl}/budget`);
      const third = await fetch(`${baseUrl}/budget`);

      expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
      expect(first.headers.get("ratelimit-limit")).toBe("120");
    });
  });

  it("refuses a flood once its own cap is reached", async () => {
    // The cap is generous, not absent: /api/ai/* has no limiter of its own.
    process.env.AI_BUDGET_READ_RATE_LIMIT_MAX = "2";

    await withAiServer(async (baseUrl) => {
      await fetch(`${baseUrl}/budget`);
      await fetch(`${baseUrl}/budget`);
      const third = await fetch(`${baseUrl}/budget`);

      expect(third.status).toBe(429);
    });
  });

  it("reading the budget does not spend a player's gameplay allowance", async () => {
    // Both limiters resolve the same identity, and the store is keyed by that
    // identity alone. Without a namespace they share one bucket of timestamps:
    // checking the banner would consume gameplay slots, and a player at their
    // cap would lose the banner that explains why.
    process.env.AI_RATE_LIMIT_MAX = "1";

    vi.resetModules();
    const { aiBudgetReadRateLimit, aiRateLimit } = await import("../lib/rate-limit");
    const app = express();
    app.get("/budget", aiBudgetReadRateLimit, (_req, res) => {
      res.json({ ok: true });
    });
    app.get("/gameplay", aiRateLimit, (_req, res) => {
      res.json({ ok: true });
    });

    const server = await new Promise<Server>((resolve) => {
      const listeningServer = app.listen(0, "127.0.0.1", () => resolve(listeningServer));
    });

    try {
      const { port } = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${port}`;

      await fetch(`${baseUrl}/budget`);
      await fetch(`${baseUrl}/budget`);
      await fetch(`${baseUrl}/budget`);
      const gameplay = await fetch(`${baseUrl}/gameplay`);

      expect(gameplay.status).toBe(200);
    } finally {
      await close(server);
    }
  });

  it("does not spend the budget it reports", async () => {
    process.env.AI_GLOBAL_DAILY_MAX = "1";

    await withAiServer(async (baseUrl) => {
      await fetch(`${baseUrl}/budget`);
      await fetch(`${baseUrl}/budget`);
      const response = await fetch(`${baseUrl}/budget`);

      await expect(response.json()).resolves.toMatchObject({
        dailyRemaining: 1,
        degraded: false,
      });
    });
  });
});

describe("GET /api/ai/probe", () => {
  let chargedKeys: string[] = [];
  let generateAiText: ReturnType<typeof vi.fn>;
  /**
   * Set by a test that needs the window store to be unreachable. It is a flag
   * rather than a second `vi.doMock` of `../lib/rate-limit`: two registrations
   * for one specifier race, and the loser is silent -- the store answers
   * normally, the probe returns 200, and the test fails roughly a third of the
   * time for a reason that looks nothing like its subject.
   */
  let storeFailure: Error | null = null;

  /**
   * Records what the *window store* was charged, not what the endpoint says it
   * charged. A probe that reports a spent day while spending nothing, and one
   * that spends a slot while reporting success, are both failures this suite
   * exists to catch, and only the store can tell them apart.
   */
  function mockBudgetStoreAndRuntime(): void {
    chargedKeys = [];
    storeFailure = null;
    generateAiText = vi.fn(async () => "pong");

    vi.doMock("../lib/ai-runtime", () => ({ generateAiText }));
    vi.doMock("../lib/rate-limit", async () => {
      const actual = await vi.importActual<typeof import("../lib/rate-limit")>(
        "../lib/rate-limit",
      );
      return {
        ...actual,
        consumeSharedWindow: (key: string, ...rest: unknown[]) => {
          // Throws before recording: an unreachable store observes nothing and
          // therefore charges nothing.
          if (storeFailure) {
            throw storeFailure;
          }
          chargedKeys.push(key);
          return (actual.consumeSharedWindow as never as (
            ...args: unknown[]
          ) => unknown)(key, ...rest);
        },
      };
    });
  }

  beforeEach(() => {
    restoreTestEnv();
    vi.unstubAllGlobals();
    process.env.AI_PROVIDER = "openrouter";
    process.env.AI_OPENROUTER_API_KEY = "sk-or-test-key";
    process.env.AI_OPENROUTER_MODEL = "vendor/free-model";
    delete process.env.AI_MOCK_MODE;
    delete process.env.AI_RATE_LIMIT_REDIS_URL;
    mockBudgetStoreAndRuntime();
  });

  afterEach(() => {
    vi.doUnmock("../lib/ai-runtime");
    vi.doUnmock("../lib/rate-limit");
    vi.resetModules();
    restoreTestEnv();
    vi.unstubAllGlobals();
  });

  it("charges the shared budget for a live probe, which reaches the provider", async () => {
    await withAiServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/probe?live=true`);

      expect(response.status).toBe(200);
      expect(generateAiText).toHaveBeenCalledTimes(1);
      // Minute first, then the day -- the same ordering the gameplay routes
      // get, so a probe refused on the minute window costs no daily slot.
      expect(chargedKeys).toEqual([
        "global:ai:minute",
        expect.stringMatching(/^global:ai:day:\d{4}-\d{2}-\d{2}$/),
      ]);
      expect(response.headers.get("x-sresim-ai-budget")).toBe("ok");
    });
  });

  it("refuses a live probe once the day is spent, and sends nothing", async () => {
    process.env.AI_GLOBAL_DAILY_MAX = "1";

    await withAiServer(async (baseUrl) => {
      await fetch(`${baseUrl}/probe?live=true`);
      const response = await fetch(`${baseUrl}/probe?live=true`);

      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        mode: "live",
        code: "ai_budget_exhausted",
      });
      expect(response.headers.get("x-sresim-ai-budget")).toBe("daily-exhausted");
      // The whole point: the second probe never reached the provider, so the
      // account-wide cap was not spent past the limiter.
      expect(generateAiText).toHaveBeenCalledTimes(1);
    });
  });

  it("charges nothing for a probe that answers from configuration alone", async () => {
    await withAiServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/probe`);

      expect(response.status).toBe(200);
      expect(generateAiText).not.toHaveBeenCalled();
      expect(chargedKeys).toEqual([]);
    });
  });

  // Holds at the budget layer rather than at the call site -- `chargeAiBudget`
  // is inert in mock mode -- so unlike the two above it does not lock where the
  // charge sits. It is here because the free-e2e gate probes with
  // `AI_MOCK_MODE=true`, and a charged mock probe would be pure leakage.
  it("charges nothing in mock mode, where no provider is reached", async () => {
    process.env.AI_MOCK_MODE = "true";

    await withAiServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/probe?live=true`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ mode: "mock" });
      expect(generateAiText).not.toHaveBeenCalled();
      expect(chargedKeys).toEqual([]);
    });
  });

  it("says the budget could not be read, not that the day is spent, on a store outage", async () => {
    // Failing closed and finding the day spent both come back as `exhausted`,
    // and answering an outage with 429 "come back tomorrow" is a wrong answer
    // to the operator most likely to be running this probe during one:
    // nothing was observed, nothing was spent, and the blip may already be
    // over. Driven through a throwing store rather than a stubbed outcome,
    // because the two cases are indistinguishable at the return value.
    storeFailure = new Error("redis unreachable");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await withAiServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/probe?live=true`);

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        mode: "live",
        code: "ai_budget_unavailable",
      });
      expect(response.headers.get("x-sresim-ai-budget")).toBe("store-unavailable");
      // Failing closed still means failing closed: the provider is not asked.
      expect(generateAiText).not.toHaveBeenCalled();
    });
  });

  it("refuses a flood of live probes before the provider is reached", async () => {
    // `app.ts` mounts the gameplay routes behind `aiRateLimit` and mounts
    // `/api/ai` behind nothing. That was defensible while the probe spent only
    // the deployer's own account; it stopped being defensible when the probe
    // was wired into the shared budget, because a looped probe now degrades
    // every player to simulated answers -- from an endpoint that needs no
    // session, no scenario and no credential outside production.
    process.env.AI_LIVE_PROBE_RATE_LIMIT_MAX = "2";

    await withAiServer(async (baseUrl) => {
      await fetch(`${baseUrl}/probe?live=true`);
      await fetch(`${baseUrl}/probe?live=true`);
      const chargedBeforeRefusal = [...chargedKeys];
      const third = await fetch(`${baseUrl}/probe?live=true`);

      expect(third.status).toBe(429);
      expect(generateAiText).toHaveBeenCalledTimes(2);
      // Asserted against the store rather than against the response: the
      // guard is only worth having if it sits *ahead* of the charge, so a
      // refused probe must leave the shared day exactly where it was.
      expect(chargedKeys).toEqual(chargedBeforeRefusal);
    });
  });

  it("does not ration the probe that answers from configuration alone", async () => {
    // Without `?live=true` the handler answers out of `getAiReadiness()` -- a
    // synchronous config read that reaches no provider and charges nothing.
    // Rationing it would ration a config echo, and would make the guard look
    // like it covers the probe generally when the live call is the only thing
    // worth covering.
    process.env.AI_LIVE_PROBE_RATE_LIMIT_MAX = "1";

    await withAiServer(async (baseUrl) => {
      const first = await fetch(`${baseUrl}/probe`);
      const second = await fetch(`${baseUrl}/probe`);
      const third = await fetch(`${baseUrl}/probe`);

      expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
      expect(generateAiText).not.toHaveBeenCalled();
    });
  });

  it("probing does not spend a player's gameplay allowance", async () => {
    // The store is keyed by identity alone, so two limiters without distinct
    // namespaces share one bucket of timestamps and then read it against
    // different caps. Behind the Next.js proxy both resolve the same identity,
    // so an operator's monitor would quietly consume the players' slots.
    process.env.AI_RATE_LIMIT_MAX = "2";
    process.env.AI_LIVE_PROBE_RATE_LIMIT_MAX = "5";

    vi.resetModules();
    const { aiLiveProbeRateLimit, aiRateLimit } = await import("../lib/rate-limit");
    const app = express();
    app.get("/probe", aiLiveProbeRateLimit, (_req, res) => {
      res.json({ ok: true });
    });
    app.get("/gameplay", aiRateLimit, (_req, res) => {
      res.json({ ok: true });
    });

    const server = await new Promise<Server>((resolve) => {
      const listeningServer = app.listen(0, "127.0.0.1", () => resolve(listeningServer));
    });

    try {
      const { port } = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${port}`;

      await fetch(`${baseUrl}/probe`);
      await fetch(`${baseUrl}/probe`);
      await fetch(`${baseUrl}/probe`);
      const gameplay = await fetch(`${baseUrl}/gameplay`);

      expect(gameplay.status).toBe(200);
    } finally {
      await close(server);
    }
  });

  it("charges nothing for a production probe it then rejects as unauthorized", async () => {
    process.env.NODE_ENV = "production";
    process.env.AI_LIVE_PROBE_TOKEN = "expected-token";

    await withAiServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/probe?live=true`, {
        headers: { "x-ai-probe-token": "wrong-token" },
      });

      expect(response.status).toBe(403);
      expect(generateAiText).not.toHaveBeenCalled();
      expect(chargedKeys).toEqual([]);
    });
  });
});
