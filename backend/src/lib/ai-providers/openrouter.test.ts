import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateAiText, streamAiText } from "../ai-runtime";
import { AiQuotaExhaustedError, AiThrottledError } from "./types";
import { _resetForTests } from "../token-logger";

const TEST_ENV_KEYS = [
  "AI_PROVIDER",
  "AI_MODEL",
  "AI_REASONING_EFFORT",
  "AI_OPENROUTER_API_KEY",
  "AI_OPENROUTER_BASE_URL",
  "AI_OPENROUTER_MODEL",
  "AI_OPENROUTER_MODEL_CHAT",
  "AI_OPENROUTER_MODEL_COMMAND",
  "AI_OPENROUTER_MODEL_SCENARIO",
  "AI_OPENROUTER_MODEL_PROBE",
  "AI_OPENROUTER_SITE_URL",
  "AI_OPENROUTER_APP_TITLE",
  "AI_AZURE_OPENAI_ENDPOINT",
  "AI_AZURE_OPENAI_API_KEY",
  "AI_AZURE_OPENAI_DEPLOYMENT",
  "AI_GLOBAL_BUDGET_ENABLED",
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
    } else {
      process.env[key] = originalValue;
    }
  }
}

function clearTestEnv(): void {
  for (const key of TEST_ENV_KEYS) {
    delete process.env[key];
  }
}

function okResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function errorResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function streamResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

// Every per-minute retry in these tests honours this header, so the backoff
// costs a millisecond instead of the 1-8s the jittered exponential would.
const IMMEDIATE_RETRY = { "retry-after": "0.001" };

const BASIC_REQUEST = {
  system: "You are helpful.",
  messages: [{ role: "user" as const, content: "hello" }],
  maxTokens: 64,
};

describe("openrouter provider", () => {
  beforeEach(() => {
    clearTestEnv();
    _resetForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    process.env.AI_PROVIDER = "openrouter";
    process.env.AI_OPENROUTER_API_KEY = "test-key";
    process.env.AI_OPENROUTER_MODEL = "vendor/global:free";
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    restoreTestEnv();
  });

  it("sends an OpenAI-compatible body with the legacy max_tokens spelling", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse("ok"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateAiText({ ...BASIC_REQUEST, route: "command" });

    expect(result).toBe("ok");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("vendor/global:free");
    expect(body.max_tokens).toBe(64);
    expect(body.max_completion_tokens).toBeUndefined();
    // reasoning_effort is not in OpenRouter's request schema, and a prompt cache
    // key is an Azure-only field; sending either risks a 400 on some upstreams.
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.prompt_cache_key).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-key");
  });

  it("does not retry under the other max-tokens spelling when the field is named in an error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      errorResponse(400, { error: { message: "max_tokens is not supported for this model" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateAiText({ ...BASIC_REQUEST, route: "command" })).rejects.toThrow(
      /OpenRouter request failed \(400\)/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves the model slug route-specific first, then command, then global", async () => {
    process.env.AI_OPENROUTER_MODEL_CHAT = "vendor/chat:free";
    process.env.AI_OPENROUTER_MODEL_COMMAND = "vendor/command:free";

    const fetchMock = vi.fn().mockImplementation(() => okResponse("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await generateAiText({ ...BASIC_REQUEST, route: "chat" });
    await generateAiText({ ...BASIC_REQUEST, route: "command" });
    // scenario and probe are one-shot calls shaped like command simulation, so
    // they fall through to the command slug rather than needing their own.
    await generateAiText({ ...BASIC_REQUEST, route: "scenario" });
    await generateAiText({ ...BASIC_REQUEST, route: "probe" });

    delete process.env.AI_OPENROUTER_MODEL_COMMAND;
    await generateAiText({ ...BASIC_REQUEST, route: "scenario" });

    const models = fetchMock.mock.calls.map(
      (call) => JSON.parse(String((call[1] as RequestInit).body)).model,
    );
    expect(models).toEqual([
      "vendor/chat:free",
      "vendor/command:free",
      "vendor/command:free",
      "vendor/command:free",
      "vendor/global:free",
    ]);
  });

  it("sends the attribution headers only when configured, and never with control characters", async () => {
    const fetchMock = vi.fn().mockImplementation(() => okResponse("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await generateAiText({ ...BASIC_REQUEST, route: "command" });
    const bare = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(bare["http-referer"]).toBeUndefined();
    expect(bare["x-title"]).toBeUndefined();

    process.env.AI_OPENROUTER_SITE_URL = "https://example.test";
    process.env.AI_OPENROUTER_APP_TITLE = "SRE Simulator";
    await generateAiText({ ...BASIC_REQUEST, route: "command" });
    const configured = (fetchMock.mock.calls[1]?.[1] as RequestInit).headers as Record<string, string>;
    expect(configured["http-referer"]).toBe("https://example.test");
    expect(configured["x-title"]).toBe("SRE Simulator");

    // fetch throws a TypeError on a header value carrying a control character,
    // which would surface as an opaque failure on every AI call.
    process.env.AI_OPENROUTER_APP_TITLE = "SRE\nSimulator";
    await generateAiText({ ...BASIC_REQUEST, route: "command" });
    const sanitized = (fetchMock.mock.calls[2]?.[1] as RequestInit).headers as Record<string, string>;
    expect(sanitized["x-title"]).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("AI_OPENROUTER_APP_TITLE"));
  });

  it("honours AI_OPENROUTER_BASE_URL and strips its trailing slashes", async () => {
    process.env.AI_OPENROUTER_BASE_URL = "https://proxy.test/v1///";
    const fetchMock = vi.fn().mockResolvedValue(okResponse("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await generateAiText({ ...BASIC_REQUEST, route: "command" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://proxy.test/v1/chat/completions");
  });

  it("classifies HTTP 402 as an exhausted credit budget without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      errorResponse(402, { error: { message: "Insufficient credits" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await generateAiText({ ...BASIC_REQUEST, route: "command" }).catch((e) => e);

    expect(error).toBeInstanceOf(AiQuotaExhaustedError);
    expect((error as AiQuotaExhaustedError).scope).toBe("credits");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies a day-scoped 429 as exhausted and skips the retry budget", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      errorResponse(
        429,
        {
          error: {
            message: "Rate limit exceeded: free-models-per-day",
            metadata: { error_type: "rate_limit_exceeded", headers: {} },
          },
        },
        // A Retry-After the length of a day is exactly what the retry loop must
        // not sleep through.
        { "retry-after": "86400" },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await generateAiText({ ...BASIC_REQUEST, route: "command" }).catch((e) => e);

    expect(error).toBeInstanceOf(AiQuotaExhaustedError);
    expect((error as AiQuotaExhaustedError).scope).toBe("daily");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the per-minute 429 on the ordinary retry path", async () => {
    const perMinute = () =>
      errorResponse(
        429,
        {
          error: {
            message: "Rate limit exceeded: 20 requests per minute",
            metadata: { error_type: "rate_limit_exceeded" },
          },
        },
        IMMEDIATE_RETRY,
      );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(perMinute())
      .mockResolvedValue(okResponse("ok"));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await generateAiText({ ...BASIC_REQUEST, route: "command" });

    expect(result).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("exhausts the retry budget on a repeated per-minute 429 without calling it a quota failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      errorResponse(
        429,
        { error: { message: "Rate limit exceeded: 20 requests per minute" } },
        IMMEDIATE_RETRY,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const error = await generateAiText({ ...BASIC_REQUEST, route: "command" }).catch((e) => e);

    expect(error).toBeInstanceOf(AiThrottledError);
    expect(error).not.toBeInstanceOf(AiQuotaExhaustedError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("classifies an in-band mid-stream error, which arrives after HTTP 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      streamResponse([
        {
          error: {
            code: 429,
            message: "Rate limit exceeded: free-models-per-day",
            metadata: { error_type: "rate_limit_exceeded" },
          },
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const stream = streamAiText({ ...BASIC_REQUEST, route: "chat" });
    const error = await (async () => {
      try {
        for await (const _chunk of stream) {
          void _chunk;
        }
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(AiQuotaExhaustedError);
    expect((error as AiQuotaExhaustedError).scope).toBe("daily");
  });

  it("yields the partial answer and then throws, so the route can mark it degraded", async () => {
    // Swallowing this error would end a capped stream with a bare `[DONE]`,
    // which on the wire is indistinguishable from a complete answer: the chat
    // route writes the `quota_exhausted` marker from its catch, and it already
    // declines to substitute a mock over text the model really produced.
    const fetchMock = vi.fn().mockImplementation(() =>
      streamResponse([
        { choices: [{ delta: { content: "partial" } }] },
        { error: { code: 429, message: "free-models-per-day limit reached" } },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const chunks: string[] = [];
    const error = await (async () => {
      try {
        for await (const chunk of streamAiText({ ...BASIC_REQUEST, route: "chat" })) {
          if (typeof chunk === "string") chunks.push(chunk);
        }
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(chunks.join("")).toBe("partial");
    expect(error).toBeInstanceOf(AiQuotaExhaustedError);
    expect((error as AiQuotaExhaustedError).scope).toBe("daily");
  });

  it("still ends a non-quota truncation quietly, keeping the partial answer", async () => {
    // The quiet return is the right answer for a truncation the player can do
    // nothing about, and it is the only behaviour the Azure path has -- Azure
    // classifies nothing but DeploymentNotFound, so nothing it sees mid-stream
    // can reach the throw above.
    const fetchMock = vi.fn().mockImplementation(() =>
      streamResponse([
        { choices: [{ delta: { content: "partial" } }] },
        { error: { code: 500, message: "upstream provider hung up" } },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const chunks: string[] = [];
    for await (const chunk of streamAiText({ ...BASIC_REQUEST, route: "chat" })) {
      if (typeof chunk === "string") chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("partial");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("OpenRouter"));
  });
});

describe("azure openai is unaffected by the openrouter throttle classifier", () => {
  beforeEach(() => {
    clearTestEnv();
    _resetForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    process.env.AI_PROVIDER = "azure-openai";
    process.env.AI_MODEL = "gpt-5.2";
    process.env.AI_AZURE_OPENAI_ENDPOINT = "https://example.openai.azure.com";
    process.env.AI_AZURE_OPENAI_API_KEY = "test-key";
    process.env.AI_AZURE_OPENAI_DEPLOYMENT = "gpt-5.2";
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    restoreTestEnv();
  });

  it("retries a 429 whose body reads like a daily cap instead of classifying it", async () => {
    // Azure does not set inspectThrottleBody, so the 429 body is never read and
    // the retry path stays byte-identical to its pre-OpenRouter behaviour.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        errorResponse(
          429,
          { error: { message: "free-models-per-day", metadata: { error_type: "rate_limit_exceeded" } } },
          IMMEDIATE_RETRY,
        ),
      )
      .mockResolvedValue(okResponse("ok"));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await generateAiText({ ...BASIC_REQUEST, route: "command" });

    expect(result).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("keep-alive warmups and a shared account-wide budget", () => {
  // `warmupAiModel` keeps a module-level cooldown timestamp, so each case gets
  // a fresh module graph rather than a reset seam exported only for tests.
  async function freshWarmup(): Promise<(route?: "chat" | "command") => void> {
    vi.resetModules();
    const runtime = await import("../ai-runtime");
    return runtime.warmupAiModel;
  }

  beforeEach(() => {
    clearTestEnv();
    _resetForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    restoreTestEnv();
  });

  it("does not warm up OpenRouter, whose quota is account-wide and daily", async () => {
    // `/api/scenario` fires a warmup on every catalog-served scenario -- the
    // one path that needs no model at all. On a 50/day free tier that is the
    // whole budget spent on requests no player ever sees, and it happens
    // outside the Express middleware that accounts for the budget.
    process.env.AI_PROVIDER = "openrouter";
    process.env.AI_OPENROUTER_API_KEY = "test-key";
    process.env.AI_OPENROUTER_MODEL = "vendor/global:free";
    const fetchMock = vi.fn().mockImplementation(() => okResponse("ping"));
    vi.stubGlobal("fetch", fetchMock);

    (await freshWarmup())("chat");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still warms up Azure, where the request buys latency and spends nothing shared", async () => {
    process.env.AI_PROVIDER = "azure-openai";
    process.env.AI_MODEL = "gpt-5.2";
    process.env.AI_AZURE_OPENAI_ENDPOINT = "https://example.openai.azure.com";
    process.env.AI_AZURE_OPENAI_API_KEY = "test-key";
    process.env.AI_AZURE_OPENAI_DEPLOYMENT = "gpt-5.2";
    const fetchMock = vi.fn().mockImplementation(() => okResponse("ping"));
    vi.stubGlobal("fetch", fetchMock);

    (await freshWarmup())("chat");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops warming up Azure once the operator says the account is capped", async () => {
    // `warmupCostsSharedQuota` is a property of the provider; this is the
    // operator saying the same thing about their own account, and it is
    // accepted on every provider. A warmup is fire-and-forget by design --
    // nothing in it can be refused -- so it cannot be routed through the
    // budget the way a route is, and charging it would let a keep-alive ping
    // spend the slot a player's next request needed.
    process.env.AI_PROVIDER = "azure-openai";
    process.env.AI_MODEL = "gpt-5.2";
    process.env.AI_AZURE_OPENAI_ENDPOINT = "https://example.openai.azure.com";
    process.env.AI_AZURE_OPENAI_API_KEY = "test-key";
    process.env.AI_AZURE_OPENAI_DEPLOYMENT = "gpt-5.2";
    process.env.AI_GLOBAL_BUDGET_ENABLED = "true";
    const fetchMock = vi.fn().mockImplementation(() => okResponse("ping"));
    vi.stubGlobal("fetch", fetchMock);

    (await freshWarmup())("chat");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the account's own free-tier counter", () => {
  // The result is cached in a module-level variable, so each case needs a
  // fresh module graph rather than a reset seam exported only for tests.
  async function freshKeyStatus(): Promise<
    typeof import("./openrouter")["fetchOpenRouterKeyStatus"]
  > {
    vi.resetModules();
    return (await import("./openrouter")).fetchOpenRouterKeyStatus;
  }

  function keyResponse(data: unknown): Response {
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  beforeEach(() => {
    clearTestEnv();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env.AI_OPENROUTER_API_KEY = "test-key";
  });

  afterAll(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    restoreTestEnv();
  });

  it("reads the nested counter object the endpoint actually returns", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() =>
      keyResponse({
        label: "sk-or-v1-...",
        limit_remaining: 18.42,
        free_model_daily_requests: { used: 60, limit: 1000, remaining: 940 },
      }),
    ));

    await expect((await freshKeyStatus())()).resolves.toEqual({
      dailyLimit: 1000,
      dailyRemaining: 940,
    });
  });

  it("stays quiet rather than reporting a credit balance as a request count", async () => {
    // `limit_remaining` is the nearest-looking field and it is currency. A
    // banner reading "18.42 requests left today" is worse than no banner.
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() =>
      keyResponse({ limit_remaining: 18.42, usage: 1.58 }),
    ));

    await expect((await freshKeyStatus())()).resolves.toEqual({
      dailyLimit: null,
      dailyRemaining: null,
    });
  });

  it("bounds the lookup, because a banner is not worth a hung request", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      keyResponse({ free_model_daily_requests: { limit: 1000, remaining: 940 } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await (await freshKeyStatus())();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  it("shares one refresh between callers that arrive together", async () => {
    // `/api/ai/budget` is public and the banner polls it, so the instant the
    // TTL expires every concurrent visitor would otherwise open its own
    // `GET /key` -- a self-inflicted herd against the rate limit this lookup
    // exists to report on.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn().mockImplementation(async () => {
      await gate;
      return keyResponse({ free_model_daily_requests: { limit: 1000, remaining: 940 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const fetchKeyStatus = await freshKeyStatus();

    const inFlight = [fetchKeyStatus(), fetchKeyStatus(), fetchKeyStatus()];
    release?.();
    const results = await Promise.all(inFlight);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result).toEqual({ dailyLimit: 1000, dailyRemaining: 940 });
    }
  });

  it("never throws, whatever the lookup does", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unreachable")));

    await expect((await freshKeyStatus())()).resolves.toBeNull();
  });
});
