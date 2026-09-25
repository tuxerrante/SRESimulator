import express from "express";
import { get, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ENV_KEYS = [
  "AI_PROVIDER",
  "AI_GLOBAL_BUDGET_ENABLED",
  "AI_GLOBAL_DAILY_MAX",
  "AI_GLOBAL_MINUTE_MAX",
  "AI_OPENROUTER_API_KEY",
  "AI_RATE_LIMIT_REDIS_URL",
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

      // The banner polls this endpoint from every visitor, and /api/ai/* is
      // otherwise unlimited.
      expect(response.headers.get("ratelimit-limit")).not.toBeNull();
    });
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
