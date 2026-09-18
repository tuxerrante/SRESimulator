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

  it("keeps a partial streamed answer when the error arrives after text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      streamResponse([
        { choices: [{ delta: { content: "partial" } }] },
        { error: { code: 429, message: "free-models-per-day limit reached" } },
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
