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

async function createStoredSessionToken(label: string): Promise<string> {
  const storageModule = await import("./storage");
  await storageModule.initStorage();
  return storageModule.getSessionStore().create("easy", label);
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

  it("uses the configured Redis window and max values for sliding-window enforcement", async () => {
    process.env.AI_RATE_LIMIT_REDIS_URL = "redis://127.0.0.1:6379/0";
    process.env.AI_RATE_LIMIT_MAX = "2";
    process.env.AI_RATE_LIMIT_WINDOW_MS = "15000";
    const sessionToken = await createStoredSessionToken("Redis limiter window");

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
    vi.doMock("redis", () => ({
      createClient: vi.fn(() => redisClient),
    }));

    const { aiRateLimit } = await import("./rate-limit");
    const allowedResponseA = createResponse();
    const allowedResponseB = createResponse();
    const deniedResponse = createResponse();

    await aiRateLimit(
      createRequest({ body: { sessionToken } }) as never,
      allowedResponseA as never,
      vi.fn(),
    );
    await aiRateLimit(
      createRequest({ body: { sessionToken } }) as never,
      allowedResponseB as never,
      vi.fn(),
    );
    await aiRateLimit(
      createRequest({ body: { sessionToken } }) as never,
      deniedResponse as never,
      vi.fn(),
    );

    expect(redisClient.sendCommand).toHaveBeenCalledTimes(3);
    expect(redisClient.sendCommand.mock.calls[0]?.[0]?.[5]).toBe("15000");
    expect(redisClient.sendCommand.mock.calls[0]?.[0]?.[6]).toBe("2");
    expect(allowedResponseA.headers.get("RateLimit-Policy")).toBe("2;w=15");
    expect(allowedResponseB.headers.get("RateLimit-Remaining")).toBe("0");
    expect(deniedResponse.status).toHaveBeenCalledWith(429);
    expect(deniedResponse.headers.get("Retry-After")).toBe("15");
  });

  it("reuses a single Redis client across requests", async () => {
    process.env.AI_RATE_LIMIT_REDIS_URL = "redis://127.0.0.1:6379/0";
    process.env.AI_RATE_LIMIT_MAX = "1";
    const sessionToken = await createStoredSessionToken("Redis limiter reuse");

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

    const { aiRateLimit } = await import("./rate-limit");
    const firstRequest = createRequest({
      body: { sessionToken },
    });
    const firstResponse = createResponse();
    const firstNext = vi.fn();
    const secondRequest = createRequest({
      body: { sessionToken },
    });
    const secondResponse = createResponse();
    const secondNext = vi.fn();

    await aiRateLimit(firstRequest as never, firstResponse as never, firstNext);
    await aiRateLimit(secondRequest as never, secondResponse as never, secondNext);

    expect(createClient).toHaveBeenCalledWith({ url: "redis://127.0.0.1:6379/0" });
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(redisClient.connect).toHaveBeenCalledTimes(1);
    expect(redisClient.sendCommand).toHaveBeenCalledTimes(2);
    expect(redisClient.sendCommand.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        "EVAL",
        "1",
        expect.stringContaining("sresim:rate-limit:session:"),
      ]),
    );
    expect(firstNext).toHaveBeenCalledTimes(1);
    expect(firstResponse.headers.get("RateLimit-Policy")).toBe("1;w=60");
    expect(firstResponse.status).not.toHaveBeenCalled();
    expect(secondNext).not.toHaveBeenCalled();
    expect(secondResponse.headers.get("RateLimit-Policy")).toBe("1;w=60");
    expect(secondResponse.status).toHaveBeenCalledWith(429);
  });

  it("reconnects with the same Redis client after a transient failure", async () => {
    process.env.AI_RATE_LIMIT_REDIS_URL = "redis://127.0.0.1:6379/0";
    process.env.AI_RATE_LIMIT_MAX = "1";

    let calls = 0;
    const redisClient = {
      isOpen: false,
      on: vi.fn(),
      connect: vi.fn(async () => {
        redisClient.isOpen = true;
      }),
      sendCommand: vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          redisClient.isOpen = false;
          throw new Error("redis connection dropped");
        }
        return ["1", "1", String(Date.now() + 60_000)];
      }),
    };
    const createClient = vi.fn(() => redisClient);
    vi.doMock("redis", () => ({ createClient }));

    const { aiRateLimit } = await import("./rate-limit");

    const firstResponse = createResponse();
    const firstNext = vi.fn();
    await aiRateLimit(createRequest() as never, firstResponse as never, firstNext);
    expect(firstResponse.headers.get(RATE_LIMIT_STATUS_HEADER)).toBe("fail-open");

    const secondResponse = createResponse();
    const secondNext = vi.fn();
    await aiRateLimit(createRequest() as never, secondResponse as never, secondNext);

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(redisClient.connect).toHaveBeenCalledTimes(2);
    expect(secondNext).toHaveBeenCalledTimes(1);
    expect(secondResponse.status).not.toHaveBeenCalled();
  });

  it("fails open explicitly when configured Redis is unavailable and warns again after recovery", async () => {
    process.env.AI_RATE_LIMIT_REDIS_URL = "redis://127.0.0.1:6379/0";
    process.env.AI_RATE_LIMIT_MAX = "1";

    let calls = 0;
    const redisClient = {
      isOpen: false,
      on: vi.fn(),
      connect: vi.fn(async () => {
        redisClient.isOpen = true;
      }),
      sendCommand: vi.fn(async () => {
        calls += 1;
        if (calls === 2) {
          return ["1", "1", String(Date.now() + 60_000)];
        }
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
    expect(secondNext).toHaveBeenCalledTimes(1);
    expect(secondResponse.headers.get(RATE_LIMIT_STATUS_HEADER)).toBe(undefined);
    expect(secondResponse.headers.get("RateLimit-Policy")).toBe("1;w=60");

    const thirdResponse = createResponse();
    const thirdNext = vi.fn();
    await aiRateLimit(createRequest() as never, thirdResponse as never, thirdNext);

    expect(redisClient.sendCommand).toHaveBeenCalledTimes(3);
    expect(thirdNext).toHaveBeenCalledTimes(1);
    expect(thirdResponse.status).not.toHaveBeenCalled();
    expect(thirdResponse.headers.get(RATE_LIMIT_STATUS_HEADER)).toBe("fail-open");
    expect(thirdResponse.headers.has("RateLimit-Limit")).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("fails open when Redis script returns malformed result values", async () => {
    process.env.AI_RATE_LIMIT_REDIS_URL = "redis://127.0.0.1:6379/0";
    process.env.AI_RATE_LIMIT_MAX = "1";

    const redisClient = {
      isOpen: false,
      on: vi.fn(),
      connect: vi.fn(async () => {
        redisClient.isOpen = true;
      }),
      sendCommand: vi.fn(async () => ["invalid", "shape"]),
    };
    const createClient = vi.fn(() => redisClient);
    vi.doMock("redis", () => ({ createClient }));

    const { aiRateLimit } = await import("./rate-limit");

    const response = createResponse();
    const next = vi.fn();
    await aiRateLimit(createRequest() as never, response as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.status).not.toHaveBeenCalled();
    expect(response.headers.get(RATE_LIMIT_STATUS_HEADER)).toBe("fail-open");
  });
});
