import { afterEach, describe, expect, it, vi } from "vitest";

interface MockRequestLike {
  ip?: string;
  socket?: {
    remoteAddress?: string;
  };
  headers: Record<string, string | string[] | undefined>;
  originalUrl: string;
  body: {
    sessionToken: string;
  };
}

interface MockResponseLike {
  statusCode: number;
  body: unknown;
  headers: Map<string, string>;
  setHeader: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
}

const originalEnv = { ...process.env };
const RATE_LIMIT_STATUS_HEADER = "x-sresim-rate-limit-status";

function createRequest(
  overrides: Partial<MockRequestLike> = {},
): MockRequestLike {
  return {
    ip: "10.0.0.10",
    socket: { remoteAddress: "10.0.0.20" },
    headers: {
      "content-type": "application/json",
    },
    originalUrl: "/api/chat",
    body: {
      sessionToken: "cafebabe-dead-beef-cafe-babedeadbeef",
    },
    ...overrides,
  };
}

function createResponse(): MockResponseLike {
  const headers = new Map<string, string>();
  const response: MockResponseLike = {
    statusCode: 200,
    body: undefined,
    headers,
    setHeader: vi.fn((name: string, value: unknown) => {
      headers.set(name, String(value));
      return response;
    }),
    status: vi.fn((code: number) => {
      response.statusCode = code;
      return response;
    }),
    json: vi.fn((body: unknown) => {
      response.body = body;
      return response;
    }),
  };

  return response;
}

describe("aiRateLimit Redis store", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.restoreAllMocks();
    vi.doUnmock("redis");
  });

  it("shares Redis-backed rate-limit state across separate middleware instances", async () => {
    process.env.AI_RATE_LIMIT_REDIS_URL = "redis://127.0.0.1:6379/0";
    process.env.AI_RATE_LIMIT_MAX = "1";

    const sharedBuckets = new Map<string, number[]>();
    const redisClient = {
      isOpen: false,
      on: vi.fn(),
      connect: vi.fn(async () => {
        redisClient.isOpen = true;
      }),
      sendCommand: vi.fn(async (args: string[]) => {
        const redisKey = args[3]!;
        const nowMs = Number(args[4]);
        const windowMs = Number(args[5]);
        const limit = Number(args[6]);
        const cutoff = nowMs - windowMs;
        const bucket = (sharedBuckets.get(redisKey) ?? []).filter((timestamp) => timestamp > cutoff);

        if (bucket.length >= limit) {
          return ["0", String(bucket.length), String((bucket[0] ?? nowMs) + windowMs)];
        }

        bucket.push(nowMs);
        sharedBuckets.set(redisKey, bucket);
        return ["1", String(bucket.length), String(nowMs + windowMs)];
      }),
    };
    const createClient = vi.fn(() => redisClient);
    vi.doMock("redis", () => ({ createClient }));

    const { aiRateLimit: firstLimiter } = await import("./rate-limit");
    const firstRequest = createRequest();
    const firstResponse = createResponse();
    const firstNext = vi.fn();

    await firstLimiter(firstRequest as never, firstResponse as never, firstNext);

    vi.resetModules();
    vi.doMock("redis", () => ({ createClient }));

    const { aiRateLimit: secondLimiter } = await import("./rate-limit");
    const secondRequest = createRequest();
    const secondResponse = createResponse();
    const secondNext = vi.fn();

    await secondLimiter(secondRequest as never, secondResponse as never, secondNext);

    expect(createClient).toHaveBeenCalledWith({ url: "redis://127.0.0.1:6379/0" });
    expect(redisClient.connect).toHaveBeenCalledTimes(2);
    expect(redisClient.sendCommand).toHaveBeenCalledTimes(2);
    expect(redisClient.sendCommand.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        "EVAL",
        "1",
        expect.stringContaining("sresim:rate-limit:session:"),
      ]),
    );
    expect(firstNext).toHaveBeenCalledTimes(1);
    expect(firstResponse.status).not.toHaveBeenCalled();
    expect(secondNext).not.toHaveBeenCalled();
    expect(secondResponse.status).toHaveBeenCalledWith(429);
  });

  it("fails open explicitly when configured Redis is unavailable", async () => {
    process.env.AI_RATE_LIMIT_REDIS_URL = "redis://127.0.0.1:6379/0";
    process.env.AI_RATE_LIMIT_MAX = "1";

    const redisClient = {
      isOpen: false,
      on: vi.fn(),
      connect: vi.fn(async () => {
        redisClient.isOpen = true;
      }),
      sendCommand: vi.fn(async () => {
        throw new Error("redis unavailable");
      }),
    };
    const createClient = vi.fn(() => redisClient);
    vi.doMock("redis", () => ({ createClient }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { aiRateLimit } = await import("./rate-limit");

    const firstResponse = createResponse();
    const firstNext = vi.fn();
    await aiRateLimit(createRequest() as never, firstResponse as never, firstNext);

    expect(firstNext).toHaveBeenCalledTimes(1);
    expect(firstResponse.status).not.toHaveBeenCalled();
    expect(firstResponse.headers.get(RATE_LIMIT_STATUS_HEADER)).toBe("fail-open");

    const secondResponse = createResponse();
    const secondNext = vi.fn();
    await aiRateLimit(createRequest() as never, secondResponse as never, secondNext);

    expect(redisClient.sendCommand).toHaveBeenCalledTimes(2);
    expect(secondNext).toHaveBeenCalledTimes(1);
    expect(secondResponse.status).not.toHaveBeenCalled();
    expect(secondResponse.headers.get(RATE_LIMIT_STATUS_HEADER)).toBe("fail-open");
    expect(secondResponse.headers.has("RateLimit-Limit")).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
