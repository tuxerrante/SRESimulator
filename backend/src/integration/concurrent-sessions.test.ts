import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { Server } from "http";
import {
  postChatSSE,
  fireParallelChats,
  getTokenMetrics,
  buildChatBody,
  getBackendUrl,
  isExternalTarget,
  startLocalServer,
} from "./helpers";

let baseUrl: string;
let localServer: Server | null = null;
const externalSessionToken = process.env.E2E_SESSION_TOKEN?.trim();
const externalSessionTokens = (process.env.E2E_SESSION_TOKENS ?? "")
  .split(",")
  .map((token) => token.trim())
  .filter((token) => token.length > 0);
let chatSessionTokens: string[] = [];

function sessionTokenFor(index: number): string {
  return chatSessionTokens[index]
    ?? chatSessionTokens[0]
    ?? "00000000-0000-4000-8000-000000000001";
}

async function createLocalApp(withRateLimit: boolean) {
  process.env.AI_MOCK_MODE = "true";
  const { initStorage } = await import("../lib/storage");
  await initStorage();
  const { default: express } = await import("express");
  const { default: cors } = await import("cors");
  const { chatRouter } = await import("../routes/chat");
  const { aiRouter } = await import("../routes/ai");
  const { healthRouter } = await import("../routes/health");

  const app = express();
  app.use(cors());
  app.use(express.json());

  if (withRateLimit) {
    const { aiRateLimit } = await import("../lib/rate-limit");
    app.use("/api/chat", aiRateLimit, chatRouter);
  } else {
    app.use("/api/chat", chatRouter);
  }

  app.use("/api/ai", aiRouter);
  app.use("/", healthRouter);
  return app;
}

beforeAll(async () => {
  if (isExternalTarget()) {
    if (externalSessionTokens.length > 0) {
      chatSessionTokens = externalSessionTokens;
    } else if (externalSessionToken) {
      chatSessionTokens = [externalSessionToken];
    } else {
      throw new Error(
        "E2E_SESSION_TOKEN or E2E_SESSION_TOKENS is required when E2E_BACKEND_URL is set.",
      );
    }
    baseUrl = getBackendUrl();
    return;
  }

  const app = await createLocalApp(false);
  const result = await startLocalServer(app);
  baseUrl = result.url;
  localServer = result.server;
  const { getSessionStore } = await import("../lib/storage");
  const sessionStore = getSessionStore();
  chatSessionTokens = await Promise.all(
    Array.from({ length: 24 }, (_, index) =>
      sessionStore.create("easy", `Concurrent Chat ${index + 1}`),
    ),
  );
}, 120000);

afterAll(() => {
  if (localServer) {
    localServer.close();
    localServer = null;
  }
});

describe("SSE stream integrity under concurrent sessions", () => {
  it("each concurrent session receives a complete SSE stream with [DONE]", async () => {
    const bodies = Array.from({ length: 5 }, (_, i) =>
      buildChatBody(2, i % 2 === 0 ? "reading" : "context", sessionTokenFor(i)),
    );

    const results = await fireParallelChats(baseUrl, bodies);

    if (isExternalTarget()) {
      const okResults = results.filter((r) => r.status === 200);
      expect(okResults.length).toBeGreaterThanOrEqual(1);

      for (const result of okResults) {
        expect(result.done).toBe(true);
        expect(result.chunks.length).toBeGreaterThan(0);
      }

      for (const result of results) {
        if (result.status !== 200) {
          expect([429, 502, 503]).toContain(result.status);
        }
      }
    } else {
      for (const result of results) {
        expect(result.status).toBe(200);
        expect(result.done).toBe(true);
        expect(result.chunks.length).toBeGreaterThan(0);

        for (const chunk of result.chunks) {
          const parsed = JSON.parse(chunk);
          expect(
            "text" in parsed || "reasoning" in parsed || "error" in parsed,
          ).toBe(true);
        }
      }
    }
  });

  it("concurrent sessions do not interleave SSE data", async () => {
    const bodies = [
      buildChatBody(2, "reading", sessionTokenFor(0)),
      buildChatBody(2, "context", sessionTokenFor(1)),
      buildChatBody(2, "facts", sessionTokenFor(2)),
    ];

    const results = await fireParallelChats(baseUrl, bodies);

    if (isExternalTarget()) {
      const successfulResults = results.filter((r) => r.status === 200);
      expect(successfulResults.length).toBeGreaterThanOrEqual(1);

      for (const result of successfulResults) {
        const lines = result.rawBody.split("\n").filter((l) => l.length > 0);
        for (const line of lines) {
          expect(line).toMatch(/^data: /);
        }
      }
    } else {
      for (const result of results) {
        expect(result.status).toBe(200);
        const lines = result.rawBody.split("\n").filter((l) => l.length > 0);
        for (const line of lines) {
          expect(line).toMatch(/^data: /);
        }
      }
    }
  });

  it("10 concurrent sessions all complete or are throttled gracefully", async () => {
    const bodies = Array.from({ length: 10 }, (_, i) =>
      buildChatBody(3, "reading", sessionTokenFor(i)),
    );
    const results = await fireParallelChats(baseUrl, bodies);

    if (isExternalTarget()) {
      const successful = results.filter((r) => r.status === 200 && r.done);
      expect(successful.length).toBeGreaterThanOrEqual(1);
      for (const r of results) {
        expect([200, 429, 502, 503]).toContain(r.status);
      }
    } else {
      for (const r of results) {
        expect(r.status).toBe(200);
        expect(r.done).toBe(true);
      }
    }
  });
});

describe("independent session responses", () => {
  it("two sessions with different histories receive independent responses", async () => {
    const sessionA = buildChatBody(2, "reading", sessionTokenFor(0));
    sessionA.messages = [
      { role: "user", content: "I think the root cause is etcd failure." },
      {
        role: "assistant",
        content:
          "The logs confirmed that etcd leader was unreachable. [PHASE:facts]",
      },
    ];

    const sessionB = buildChatBody(2, "context", sessionTokenFor(1));
    sessionB.messages = [
      { role: "user", content: "I suspect DNS is broken." },
      {
        role: "assistant",
        content:
          "The check revealed that coreDNS pods are crashlooping. [PHASE:context]",
      },
    ];

    const [resultA, resultB] = await fireParallelChats(baseUrl, [
      sessionA,
      sessionB,
    ]);

    if (isExternalTarget()) {
      expect([200, 429]).toContain(resultA.status);
      expect([200, 429]).toContain(resultB.status);
    } else {
      expect(resultA.status).toBe(200);
      expect(resultB.status).toBe(200);
    }

    if (resultA.status === 200 && resultB.status === 200) {
      expect(resultA.chunks.length).toBeGreaterThan(0);
      expect(resultB.chunks.length).toBeGreaterThan(0);

      const extractText = (chunks: string[]) =>
        chunks
          .map((c) => {
            const parsed = JSON.parse(c);
            return parsed.text ?? "";
          })
          .join("");

      const textA = extractText(resultA.chunks);
      const textB = extractText(resultB.chunks);

      if (textA.length > 0 && textB.length > 0) {
        expect(textA).not.toBe(textB);
      }
    }
  });
});

describe("token metrics under concurrent load", () => {
  it("records metrics for concurrent requests", async () => {
    const metricsBefore = await getTokenMetrics(baseUrl);

    if (isExternalTarget() && metricsBefore.status === 403) {
      // Production requires AI_LIVE_PROBE_TOKEN; skip if not configured.
      // The test still validates the endpoint exists and auth is enforced.
      expect(metricsBefore.status).toBe(403);
      return;
    }

    expect(metricsBefore.status).toBe(200);

    const bodies = Array.from({ length: 3 }, (_, i) =>
      buildChatBody(2, "reading", sessionTokenFor(i)),
    );
    await fireParallelChats(baseUrl, bodies);

    const metricsAfter = await getTokenMetrics(baseUrl);
    expect(metricsAfter.status).toBe(200);
    expect(metricsAfter.body).toBeDefined();
  });
});

describe("rate-limit behavior", { timeout: 120_000 }, () => {
  let rateLimitUrl: string;
  let rateLimitServer: Server | null = null;

  beforeAll(async () => {
    if (isExternalTarget()) {
      rateLimitUrl = getBackendUrl();
      return;
    }

    const app = await createLocalApp(true);
    const result = await startLocalServer(app);
    rateLimitUrl = result.url;
    rateLimitServer = result.server;
  });

  afterAll(() => {
    if (rateLimitServer) {
      rateLimitServer.close();
      rateLimitServer = null;
    }
  });

  it("allows requests within the rate limit window", async () => {
    const result = await postChatSSE(rateLimitUrl, buildChatBody(1, "reading", sessionTokenFor(0)));
    expect(result.status).toBe(200);
  });

  it("does not throttle distinct sessions that share the same source IP", async () => {
    if (isExternalTarget()) {
      const bodies = Array.from({ length: 20 }, (_, i) =>
        buildChatBody(1, "reading", sessionTokenFor(i)),
      );
      const results = await Promise.allSettled(
        bodies.map((b) => postChatSSE(rateLimitUrl, b)),
      );

      const statuses = results
        .filter(
          (
            r,
          ): r is PromiseFulfilledResult<
            Awaited<ReturnType<typeof postChatSSE>>
          > => r.status === "fulfilled",
        )
        .map((r) => r.value.status);

      expect(statuses.every((status) => status === 200)).toBe(true);
      return;
    }

    // Distinct sessions should not share the same rate-limit bucket.
    const results: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await postChatSSE(rateLimitUrl, buildChatBody(1, "reading", sessionTokenFor(i)));
      results.push(r.status);
    }

    expect(results).toEqual(Array.from({ length: 20 }, () => 200));
  });

  it("returns 429 after exceeding the per-session rate limit", async () => {
    const repeatedSessionToken = sessionTokenFor(0);

    if (isExternalTarget()) {
      const bodies = Array.from({ length: 20 }, () =>
        buildChatBody(1, "reading", repeatedSessionToken),
      );
      const results = await Promise.allSettled(
        bodies.map((body) => postChatSSE(rateLimitUrl, body)),
      );

      const statuses = results
        .filter(
          (
            result,
          ): result is PromiseFulfilledResult<
            Awaited<ReturnType<typeof postChatSSE>>
          > => result.status === "fulfilled",
        )
        .map((result) => result.value.status);

      expect(statuses.some((status) => status === 200)).toBe(true);
      expect(statuses.some((status) => status === 429)).toBe(true);
      return;
    }

    const results: number[] = [];
    for (let i = 0; i < 20; i++) {
      const response = await postChatSSE(
        rateLimitUrl,
        buildChatBody(1, "reading", repeatedSessionToken),
      );
      results.push(response.status);
    }

    expect(results.filter((status) => status === 429).length).toBeGreaterThan(0);
  });

  it("recovers after rate limit window expires", async () => {
    if (isExternalTarget()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 61_000));

    const result = await postChatSSE(rateLimitUrl, buildChatBody(1, "reading", sessionTokenFor(0)));
    expect(result.status).toBe(200);
    expect(result.done).toBe(true);
  });
});
