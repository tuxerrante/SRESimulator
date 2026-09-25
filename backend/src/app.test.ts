import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

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

async function listen(app: Express): Promise<Server> {
  return new Promise<Server>((resolve) => {
    const listeningServer = app.listen(0, "127.0.0.1", () => resolve(listeningServer));
  });
}

describe("createApp", { timeout: 15000 }, () => {
  const originalTrustProxyHeaders = process.env.TRUST_PROXY_HEADERS;
  const originalAntiAbuseSecret = process.env.ANTI_ABUSE_HMAC_SECRET;
  const originalSentryEnabled = process.env.SENTRY_ENABLED;
  const originalSentryDsn = process.env.SENTRY_DSN;

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@sentry/node");
    vi.doUnmock("./lib/storage");

    if (originalTrustProxyHeaders === undefined) {
      delete process.env.TRUST_PROXY_HEADERS;
    } else {
      process.env.TRUST_PROXY_HEADERS = originalTrustProxyHeaders;
    }

    if (originalAntiAbuseSecret === undefined) {
      delete process.env.ANTI_ABUSE_HMAC_SECRET;
    } else {
      process.env.ANTI_ABUSE_HMAC_SECRET = originalAntiAbuseSecret;
    }

    if (originalSentryEnabled === undefined) {
      delete process.env.SENTRY_ENABLED;
    } else {
      process.env.SENTRY_ENABLED = originalSentryEnabled;
    }

    if (originalSentryDsn === undefined) {
      delete process.env.SENTRY_DSN;
    } else {
      process.env.SENTRY_DSN = originalSentryDsn;
    }
  });

  it("does not trust proxy headers by default", async () => {
    delete process.env.TRUST_PROXY_HEADERS;

    const { createApp } = await import("./app");
    const app = createApp();

    expect(app.get("trust proxy")).toBe(false);
  }, 180000);

  it("trusts proxy headers only when explicitly enabled", async () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    process.env.ANTI_ABUSE_HMAC_SECRET = "test-hmac";

    const { createApp } = await import("./app");
    const app = createApp();

    expect(app.get("trust proxy")).toBe(true);
  }, 120000);

  it("rejects trust proxy mode without anti-abuse signing secret", async () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    delete process.env.ANTI_ABUSE_HMAC_SECRET;

    const { createApp } = await import("./app");
    expect(() => createApp()).toThrow(
      "TRUST_PROXY_HEADERS=true requires ANTI_ABUSE_HMAC_SECRET",
    );
  }, 60000);

  it("builds the express app without requiring Sentry env vars", async () => {
    delete process.env.SENTRY_ENABLED;
    delete process.env.SENTRY_DSN;

    const { createApp } = await import("./app");

    const app = createApp();
    expect(app).toBeDefined();
  });

  it("wires Sentry error handling without initializing in createApp", async () => {
    process.env.SENTRY_ENABLED = "true";
    process.env.SENTRY_DSN = "https://examplePublicKey@o0.ingest.sentry.io/0";

    const init = vi.fn();
    const setupExpressErrorHandler = vi.fn();

    vi.doMock("@sentry/node", () => ({
      init,
      setupExpressErrorHandler,
    }));

    const { createApp } = await import("./app");
    const app = createApp();

    expect(app).toBeDefined();
    expect(init).not.toHaveBeenCalled();
    expect(setupExpressErrorHandler).toHaveBeenCalledWith(app);
  });

  it("applies security headers and hides express fingerprinting", async () => {
    const { createApp } = await import("./app");
    const app = createApp();
    const server = await listen(app);

    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);

      expect(response.status).toBe(200);
      expect(response.headers.get("x-powered-by")).toBeNull();
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-dns-prefetch-control")).toBe("off");
    } finally {
      await close(server);
    }
  });

  it("enforces tighter JSON limits per route", async () => {
    const sessionGet = vi.fn().mockResolvedValue(null);
    vi.doMock("./lib/storage", () => ({
      getSessionStore: () => ({
        get: sessionGet,
      }),
    }));

    const { createApp } = await import("./app");
    const app = createApp();
    const server = await listen(app);

    try {
      const { port } = server.address() as AddressInfo;
      const payload = JSON.stringify({
        sessionToken: "invalid-session-token",
        messages: [{ role: "user", content: "x".repeat(80 * 1024) }],
        scenario: null,
        currentPhase: "facts",
      });

      const acceptedByChat = await fetch(`http://127.0.0.1:${port}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      });
      const rejectedByScenario = await fetch(`http://127.0.0.1:${port}/api/scenario`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      });
      const rejectedByScenarioBody = await rejectedByScenario.json() as { error: string };

      expect(acceptedByChat.status).toBe(403);
      expect(rejectedByScenario.status).toBe(413);
      expect(rejectedByScenario.headers.get("content-type")).toContain("application/json");
      expect(rejectedByScenarioBody).toEqual({ error: "JSON payload too large" });
    } finally {
      await close(server);
    }
  });

  it("keeps malformed JSON handling independent from sentry scope mutation", async () => {
    process.env.SENTRY_ENABLED = "true";
    process.env.SENTRY_DSN = "https://examplePublicKey@o0.ingest.sentry.io/0";

    const init = vi.fn();
    const setTags = vi.fn();
    const setExtras = vi.fn();
    const setupExpressErrorHandler = vi.fn();

    vi.doMock("@sentry/node", () => ({
      init,
      setTags,
      setExtras,
      setupExpressErrorHandler,
    }));

    const { createApp } = await import("./app");
    const app = createApp();
    const server = await listen(app);

    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/api/scenario`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      const responseBody = await response.json() as { error: string };

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(responseBody).toEqual({ error: "Malformed JSON request body" });
      expect(setTags).not.toHaveBeenCalled();
      expect(setExtras).not.toHaveBeenCalled();
      expect(init).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });
});

describe("AI shared-budget charging", { timeout: 15000 }, () => {
  const ENV_KEYS = [
    "AI_PROVIDER",
    "AI_MOCK_MODE",
    "SCENARIO_SOURCE",
    "AI_GLOBAL_BUDGET_ENABLED",
  ] as const;
  const originalEnv: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];

  afterEach(() => {
    vi.doUnmock("./lib/rate-limit");
    vi.resetModules();
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /**
   * Mounts the real app with the per-identity limiter replaced by one whose
   * verdict the test controls, and the shared-window store replaced by one
   * that records which keys were charged. What the budget *reports* is written
   * only on the path it takes, so only the store can say whether a request
   * that never reached a provider cost anything.
   */
  async function loadAppWithRecordingBudget(
    identityVerdict: "allow" | "refuse",
  ): Promise<{
    app: Express;
    consumedKeys: string[];
    chargeAiBudget: typeof import("./lib/ai-budget").chargeAiBudget;
  }> {
    vi.resetModules();
    const consumedKeys: string[] = [];
    const actual = await vi.importActual<typeof import("./lib/rate-limit")>("./lib/rate-limit");
    vi.doMock("./lib/rate-limit", () => ({
      ...actual,
      aiRateLimit:
        identityVerdict === "allow"
          ? (_req: unknown, _res: unknown, next: () => void) => next()
          : (_req: unknown, res: { status: (c: number) => { json: (b: unknown) => void } }) => {
              res.status(429).json({ error: "Rate limit exceeded" });
            },
      consumeSharedWindow: async (
        key: string,
        windowMs: number,
        limit: number,
        nowMs: number,
      ) => {
        consumedKeys.push(key);
        return {
          decision: {
            allowed: true,
            remaining: limit - 1,
            resetAtMs: nowMs + windowMs,
            retryAfterSeconds: Math.ceil(windowMs / 1000),
          },
          distributed: false,
        };
      },
    }));
    const { createApp } = await import("./app");
    const { chargeAiBudget } = await import("./lib/ai-budget");
    return { app: createApp(), consumedKeys, chargeAiBudget };
  }

  async function postJson(app: Express, path: string): Promise<number> {
    const server = await listen(app);
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      await response.text();
      return response.status;
    } finally {
      await close(server);
    }
  }

  /**
   * Proves the recorder is wired into the app's own module graph before any
   * test reads an empty list as an exemption. Without it every assertion below
   * would pass just as well against a limiter that was never loaded.
   */
  async function assertRecorderIsLive(
    chargeAiBudget: typeof import("./lib/ai-budget").chargeAiBudget,
    consumedKeys: string[],
  ): Promise<void> {
    const headers: Record<string, string> = {};
    const res = {
      setHeader(name: string, value: string | number) {
        headers[name] = String(value);
      },
    } as unknown as Response;
    await expect(chargeAiBudget(res)).resolves.toBe("ok");
    expect(consumedKeys).toEqual([
      "global:ai:minute",
      `global:ai:day:${new Date().toISOString().slice(0, 10)}`,
    ]);
    consumedKeys.length = 0;
  }

  it("does not charge the shared account for a request the per-identity limiter refused", async () => {
    process.env.AI_PROVIDER = "openrouter";
    delete process.env.AI_MOCK_MODE;
    const { app, consumedKeys, chargeAiBudget } = await loadAppWithRecordingBudget("refuse");
    await assertRecorderIsLive(chargeAiBudget, consumedKeys);

    const status = await postJson(app, "/api/chat");

    // One player must not be able to drain a shared day's budget on requests
    // their own limiter already stopped -- the same rule that stops the daily
    // window being charged for a minute-window refusal, one layer out.
    expect(status).toBe(429);
    expect(consumedKeys).toEqual([]);
  });

  it("charges nothing for a request no route would have sent to a provider", async () => {
    // The reason the budget is charged inside the routes and not as
    // middleware. An empty body is refused by all three routes' own
    // validation, long before a prompt exists -- but middleware runs first,
    // so mounted there it charged the shared day for every one of them. On an
    // un-credited account that is 50 requests a day one caller can spend
    // without OpenRouter seeing a single request, and every real player is
    // pushed onto simulated answers by traffic that never happened.
    process.env.AI_PROVIDER = "openrouter";
    delete process.env.AI_MOCK_MODE;
    const { app, consumedKeys, chargeAiBudget } = await loadAppWithRecordingBudget("allow");
    await assertRecorderIsLive(chargeAiBudget, consumedKeys);

    const statuses = [
      await postJson(app, "/api/chat"),
      await postJson(app, "/api/command"),
    ];

    expect(statuses).toEqual([400, 400]);
    expect(consumedKeys).toEqual([]);
  });

  it("charges nothing on /api/scenario when the catalog serves it without a model", async () => {
    // Under SCENARIO_SOURCE=catalog the route answers from the curated
    // catalog and returns above the charge, so the exemption the middleware
    // needed a predicate for is now a property of where the call sits.
    process.env.AI_PROVIDER = "openrouter";
    process.env.SCENARIO_SOURCE = "catalog";
    delete process.env.AI_MOCK_MODE;
    const { app, consumedKeys, chargeAiBudget } = await loadAppWithRecordingBudget("allow");
    await assertRecorderIsLive(chargeAiBudget, consumedKeys);

    await postJson(app, "/api/scenario");

    expect(consumedKeys).toEqual([]);
  });
});
