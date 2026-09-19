import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetForTests } from "../token-logger";

const TEST_ENV_KEYS = [
  "AI_PROVIDER",
  "AI_MOCK_MODE",
  "AI_OPENROUTER_API_KEY",
  "AI_OPENROUTER_BASE_URL",
  "AI_OPENROUTER_MODEL",
  "AI_GLOBAL_BUDGET_ENABLED",
  "AI_GLOBAL_DAILY_MAX",
  "AI_GLOBAL_MINUTE_MAX",
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

function okResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** finish_reason=length with reasoning tokens and no text: the retry ai-runtime owns. */
function reasoningExhaustedResponse(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: "" }, finish_reason: "length" }],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 64,
        total_tokens: 65,
        completion_tokens_details: { reasoning_tokens: 64 },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function throttledResponse(): Response {
  return new Response(JSON.stringify({ error: { message: "slow down" } }), {
    status: 429,
    // Keeps the jittered backoff to a millisecond.
    headers: { "content-type": "application/json", "retry-after": "0.001" },
  });
}

const BASIC_REQUEST = {
  system: "You are helpful.",
  messages: [{ role: "user" as const, content: "hello" }],
  maxTokens: 64,
};

/**
 * The budget's own snapshot reports the last decision a charge *remembered*,
 * which cannot distinguish "charged once" from "charged twice" when both
 * requests belong to the same call. So these cases assert against the shared
 * window store -- the thing the charge actually changes.
 */
async function loadRuntimeWithRecordingStore(): Promise<{
  runtime: typeof import("../ai-runtime");
  consumedKeys: string[];
}> {
  vi.resetModules();
  const consumedKeys: string[] = [];
  vi.doMock("../rate-limit", () => ({
    consumeSharedWindow: vi.fn(
      async (key: string, windowMs: number, limit: number, nowMs: number) => {
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
    ),
  }));
  return { runtime: await import("../ai-runtime"), consumedKeys };
}

function dayKey(): string {
  return `global:ai:day:${new Date().toISOString().slice(0, 10)}`;
}

describe("a provider request beyond the first is charged to the shared budget", () => {
  beforeEach(() => {
    restoreTestEnv();
    _resetForTests();
    process.env.AI_PROVIDER = "openrouter";
    process.env.AI_OPENROUTER_API_KEY = "test-key";
    process.env.AI_OPENROUTER_MODEL = "test/model:free";
    delete process.env.AI_MOCK_MODE;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    restoreTestEnv();
  });

  afterAll(() => {
    restoreTestEnv();
  });

  it("charges nothing when the one request the route paid for is the only one sent", async () => {
    const { runtime, consumedKeys } = await loadRuntimeWithRecordingStore();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse("hi")),
    );

    await expect(runtime.generateAiText({ ...BASIC_REQUEST })).resolves.toBe("hi");

    expect(consumedKeys).toEqual([]);
  });

  it("charges the 429 backoff attempt, which the route never paid for", async () => {
    const { runtime, consumedKeys } = await loadRuntimeWithRecordingStore();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => throttledResponse())
      .mockImplementationOnce(async () => okResponse("hi"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(runtime.generateAiText({ ...BASIC_REQUEST })).resolves.toBe("hi");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(consumedKeys).toEqual(["global:ai:minute", dayKey()]);
  });

  it("charges the reasoning retry, which re-enters the transport from ai-runtime", async () => {
    // This is the one retry that leaves the transport and comes back, so it
    // is the case that proves the count survives the `{ ...request }` spread
    // `generateAiText` retries through. Dropping the count there would make
    // the retry read as a first request and cost the account a free one.
    const { runtime, consumedKeys } = await loadRuntimeWithRecordingStore();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => reasoningExhaustedResponse())
      .mockImplementationOnce(async () => okResponse("hi"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(runtime.generateAiText({ ...BASIC_REQUEST })).resolves.toBe("hi");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(consumedKeys).toEqual(["global:ai:minute", dayKey()]);
  });

  it("charges every extra send, not just the first of them", async () => {
    const { runtime, consumedKeys } = await loadRuntimeWithRecordingStore();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => throttledResponse())
      .mockImplementationOnce(async () => throttledResponse())
      .mockImplementationOnce(async () => okResponse("hi"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(runtime.generateAiText({ ...BASIC_REQUEST })).resolves.toBe("hi");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(consumedKeys).toEqual([
      "global:ai:minute",
      dayKey(),
      "global:ai:minute",
      dayKey(),
    ]);
  });

  it("charges a streamed retry too", async () => {
    const { runtime, consumedKeys } = await loadRuntimeWithRecordingStore();
    const encoder = new TextEncoder();
    const streamOk = (): Response =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`,
              ),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => throttledResponse())
      .mockImplementationOnce(async () => streamOk());
    vi.stubGlobal("fetch", fetchMock);

    let text = "";
    for await (const chunk of runtime.streamAiText({ ...BASIC_REQUEST })) {
      if (typeof chunk === "string") text += chunk;
    }

    expect(text).toBe("hi");
    expect(consumedKeys).toEqual(["global:ai:minute", dayKey()]);
  });

  it("charges nothing on a provider whose budget is not being shared", async () => {
    process.env.AI_PROVIDER = "azure";
    process.env.AI_AZURE_OPENAI_ENDPOINT = "https://example.openai.azure.com";
    process.env.AI_AZURE_OPENAI_API_KEY = "azure-key";
    process.env.AI_AZURE_OPENAI_DEPLOYMENT = "gpt-test";
    const { runtime, consumedKeys } = await loadRuntimeWithRecordingStore();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => throttledResponse())
      .mockImplementationOnce(async () => okResponse("hi"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(runtime.generateAiText({ ...BASIC_REQUEST })).resolves.toBe("hi");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(consumedKeys).toEqual([]);

    delete process.env.AI_AZURE_OPENAI_ENDPOINT;
    delete process.env.AI_AZURE_OPENAI_API_KEY;
    delete process.env.AI_AZURE_OPENAI_DEPLOYMENT;
  });
});
