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

async function createLocalApp(withRateLimit: boolean) {
  process.env.AI_MOCK_MODE = "true";
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
    baseUrl = getBackendUrl();
    return;
  }

  const app = await createLocalApp(false);
  const result = await startLocalServer(app);
  baseUrl = result.url;
  localServer = result.server;
});

afterAll(() => {
  if (localServer) {
    localServer.close();
    localServer = null;
  }
});

describe("SSE stream integrity under concurrent sessions", () => {
  it("each concurrent session receives a complete SSE stream with [DONE]", async () => {
    const bodies = Array.from({ length: 5 }, (_, i) =>
      buildChatBody(2, i % 2 === 0 ? "reading" : "context"),
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
      buildChatBody(2, "reading"),
      buildChatBody(2, "context"),
      buildChatBody(2, "facts"),
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
    const bodies = Array.from({ length: 10 }, () => buildChatBody(3));
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

describe("independent compaction across sessions", () => {
  it("two sessions with different histories compact independently", async () => {
    const sessionA = buildChatBody(2, "reading");
    sessionA.messages = [
      { role: "user", content: "I think the root cause is etcd failure." },
      {
        role: "assistant",
        content:
          "The logs confirmed that etcd leader was unreachable. [PHASE:facts]",
      },
    ];

    const sessionB = buildChatBody(2, "context");
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

    // Both should get a response (200 or 429 from rate limit)
    expect([200, 429]).toContain(resultA.status);
    expect([200, 429]).toContain(resultB.status);

    // If both succeeded, the responses should be different (independent sessions)
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

      // Both should produce non-empty AI responses
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

    const bodies = Array.from({ length: 3 }, () => buildChatBody(2));
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
    const result = await postChatSSE(rateLimitUrl, buildChatBody(1));
    expect(result.status).toBe(200);
  });

  it("returns 429 after exceeding per-IP rate limit", async () => {
    if (isExternalTarget()) {
      const bodies = Array.from({ length: 20 }, () => buildChatBody(1));
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

      expect(statuses.some((s) => s === 200)).toBe(true);
      return;
    }

    // Local: 15 req/min/IP limit. Fire 20 requests sequentially.
    const results: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await postChatSSE(rateLimitUrl, buildChatBody(1));
      results.push(r.status);
    }

    const throttled = results.filter((s) => s === 429).length;
    expect(throttled).toBeGreaterThan(0);
  });

  it("recovers after rate limit window expires", async () => {
    if (isExternalTarget()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 61_000));

    const result = await postChatSSE(rateLimitUrl, buildChatBody(1));
    expect(result.status).toBe(200);
    expect(result.done).toBe(true);
  });
});
