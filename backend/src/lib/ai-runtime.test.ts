import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AiReasoningRetryEvent, generateAiText, streamAiText } from "./ai-runtime";
import { _resetForTests, getTokenMetrics } from "./token-logger";

const TEST_ENV_KEYS = [
  "AI_PROVIDER",
  "AI_MODEL",
  "AI_REASONING_EFFORT",
  "AI_REASONING_EFFORT_COMMAND",
  "AI_REASONING_EFFORT_CHAT",
  "AI_REASONING_EFFORT_SCENARIO",
  "AI_AZURE_OPENAI_ENDPOINT",
  "AI_AZURE_OPENAI_API_KEY",
  "AI_AZURE_OPENAI_DEPLOYMENT",
  "AI_AZURE_OPENAI_DEPLOYMENT_CHAT",
  "AI_AZURE_OPENAI_DEPLOYMENT_COMMAND",
  "AI_AZURE_OPENAI_DEPLOYMENT_SCENARIO",
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
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

function azureStreamResponse(events: unknown[]): Response {
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
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

function truncatedAzureStreamResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, label: string, ms = 250): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function controlledAzureStreamResponse(
  initialEvents: unknown[],
  trailingEvents: unknown[],
): { response: Response; complete: () => void; completed: Promise<void> } {
  const encoder = new TextEncoder();
  const release = createDeferred<void>();
  const completed = createDeferred<void>();
  let cancelled = false;

  const response = new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const event of initialEvents) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        await release.promise;
        if (cancelled) {
          completed.resolve();
          return;
        }
        for (const event of trailingEvents) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        completed.resolve();
      },
      cancel() {
        cancelled = true;
        release.resolve();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );

  return {
    response,
    complete: () => release.resolve(),
    completed: completed.promise,
  };
}

async function collectStream(
  stream: AsyncGenerator<string | AiReasoningRetryEvent, void, void>,
): Promise<Array<string | AiReasoningRetryEvent>> {
  const chunks: Array<string | AiReasoningRetryEvent> = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("ai-runtime reasoning_effort compatibility", () => {
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

  it("does not send reasoning_effort for non-reasoning deployment names", async () => {
    process.env.AI_AZURE_OPENAI_DEPLOYMENT_COMMAND = "gpt-4o-mini-fast";

    const fetchMock = vi.fn().mockResolvedValue(okResponse("ok"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateAiText({
      system: "You are helpful.",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 64,
      route: "command",
    });

    expect(result).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("retries once without reasoning_effort when deployment rejects it", async () => {
    process.env.AI_AZURE_OPENAI_DEPLOYMENT_COMMAND = "command-prod";

    const unsupportedReasoningError = new Response(
      JSON.stringify({
        error: {
          message: "Unrecognized request argument supplied: reasoning_effort",
        },
      }),
      {
        status: 400,
        headers: { "content-type": "application/json" },
      },
    );

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(unsupportedReasoningError)
      .mockResolvedValueOnce(okResponse("first"))
      .mockResolvedValueOnce(okResponse("second"));
    vi.stubGlobal("fetch", fetchMock);

    const first = await generateAiText({
      system: "You are helpful.",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 64,
      route: "command",
    });
    const second = await generateAiText({
      system: "You are helpful.",
      messages: [{ role: "user", content: "hello again" }],
      maxTokens: 64,
      route: "command",
    });

    expect(first).toBe("first");
    expect(second).toBe("second");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    const thirdBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));

    // The command route defaults to "low" reasoning effort (see below).
    expect(firstBody.reasoning_effort).toBe("low");
    expect(secondBody.reasoning_effort).toBeUndefined();
    expect(thirdBody.reasoning_effort).toBeUndefined();
  });

  it("defaults the command route to low reasoning effort", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await generateAiText({
      system: "You are helpful.",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 64,
      route: "command",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.reasoning_effort).toBe("low");
  });

  it("keeps the command route at low even when global AI_REASONING_EFFORT is high", async () => {
    process.env.AI_REASONING_EFFORT = "high";

    const fetchMock = vi.fn().mockResolvedValue(okResponse("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await generateAiText({
      system: "You are helpful.",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 64,
      route: "command",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.reasoning_effort).toBe("low");
  });

  it("lets AI_REASONING_EFFORT_COMMAND override the command-route default", async () => {
    process.env.AI_REASONING_EFFORT_COMMAND = "high";

    const fetchMock = vi.fn().mockResolvedValue(okResponse("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await generateAiText({
      system: "You are helpful.",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 64,
      route: "command",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.reasoning_effort).toBe("high");
  });

  it("uses global AI_REASONING_EFFORT for non-command routes", async () => {
    process.env.AI_REASONING_EFFORT = "high";

    const fetchMock = vi.fn().mockResolvedValue(okResponse("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await generateAiText({
      system: "You are helpful.",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 64,
      route: "chat",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.reasoning_effort).toBe("high");
  });

  it("lets AI_REASONING_EFFORT_CHAT override a conflicting global for the chat route", async () => {
    process.env.AI_REASONING_EFFORT = "high";
    process.env.AI_REASONING_EFFORT_CHAT = "low";

    const fetchMock = vi.fn().mockResolvedValue(okResponse("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await generateAiText({
      system: "You are helpful.",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 64,
      route: "chat",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.reasoning_effort).toBe("low");
  });
});

function deploymentNotFoundResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "DeploymentNotFound",
        message: "The API deployment for this resource does not exist.",
      },
    }),
    { status: 404, headers: { "content-type": "application/json" } },
  );
}

describe("ai-runtime Azure deployment fallback", () => {
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

  it("retries once against global deployment when route-specific returns DeploymentNotFound", async () => {
    process.env.AI_AZURE_OPENAI_DEPLOYMENT_SCENARIO = "gpt-4o-mini";

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(deploymentNotFoundResponse())
      .mockResolvedValueOnce(okResponse("scenario-text"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateAiText({
      system: "You are helpful.",
      messages: [{ role: "user", content: "create scenario" }],
      maxTokens: 64,
      route: "scenario",
    });

    expect(result).toBe("scenario-text");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstUrl = String(fetchMock.mock.calls[0]?.[0]);
    const secondUrl = String(fetchMock.mock.calls[1]?.[0]);
    expect(firstUrl).toContain("/deployments/gpt-4o-mini/");
    expect(secondUrl).toContain("/deployments/gpt-5.2/");

    const warnLine = String(warnSpy.mock.calls[0]?.[0] ?? "");
    expect(warnLine).toContain("[ai-runtime]");
    expect(warnLine).toContain("deployment not found");
    expect(warnLine).toContain("gpt-4o-mini");
    expect(warnLine).toContain("retrying once");
    expect(warnLine).toContain("gpt-5.2");
    expect(getTokenMetrics().perRoute.scenario.errors).toBe(0);
    warnSpy.mockRestore();
  });

  it("does not retry when route-specific deployment succeeds on first request", async () => {
    process.env.AI_AZURE_OPENAI_DEPLOYMENT_SCENARIO = "gpt-4o-mini";

    const fetchMock = vi.fn().mockResolvedValue(okResponse("ok"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateAiText({
      system: "You are helpful.",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 64,
      route: "scenario",
    });

    expect(result).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/deployments/gpt-4o-mini/");
  });

  it("throws after one fallback when global deployment also returns DeploymentNotFound", async () => {
    process.env.AI_AZURE_OPENAI_DEPLOYMENT_SCENARIO = "gpt-4o-mini";

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(deploymentNotFoundResponse())
      .mockResolvedValueOnce(deploymentNotFoundResponse());
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      generateAiText({
        system: "You are helpful.",
        messages: [{ role: "user", content: "x" }],
        maxTokens: 64,
        route: "scenario",
      }),
    ).rejects.toThrow(/Azure OpenAI request failed \(404\): .*DeploymentNotFound/);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getTokenMetrics().perRoute.scenario.errors).toBe(1);
    warnSpy.mockRestore();
  });

  it("does not retry when route override matches global deployment", async () => {
    process.env.AI_AZURE_OPENAI_DEPLOYMENT_SCENARIO = "gpt-5.2";

    const fetchMock = vi.fn().mockResolvedValueOnce(deploymentNotFoundResponse());
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      generateAiText({
        system: "You are helpful.",
        messages: [{ role: "user", content: "x" }],
        maxTokens: 64,
        route: "scenario",
      }),
    ).rejects.toThrow(/Azure OpenAI request failed \(404\): .*DeploymentNotFound/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getTokenMetrics().perRoute.scenario.errors).toBe(1);
  });

  it("forwards AbortSignal to Azure fetch requests", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const abortError = new Error("The operation was aborted.");
          abortError.name = "AbortError";
          reject(abortError);
        });
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const requestPromise = generateAiText({
      system: "You are helpful.",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 64,
      route: "scenario",
      signal: controller.signal,
    });

    controller.abort();

    await expect(requestPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
});

describe("ai-runtime Azure streaming", () => {
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

  it("yields the first Azure chunk before the upstream stream fully completes", async () => {
    const upstream = controlledAzureStreamResponse(
      [{ choices: [{ delta: { content: "Hello" }, finish_reason: null }] }],
      [
        { choices: [{ delta: { content: " world" }, finish_reason: null }] },
        {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 2,
            total_tokens: 3,
          },
        },
      ],
    );
    const fetchMock = vi.fn().mockResolvedValue(upstream.response);
    vi.stubGlobal("fetch", fetchMock);

    const iterator = streamAiText({
      system: "You are helpful.",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 64,
      route: "chat",
    });

    const firstChunk = await withTimeout(iterator.next(), "first Azure stream chunk");
    let upstreamCompleted = false;
    upstream.completed.then(() => {
      upstreamCompleted = true;
    });

    expect(firstChunk).toEqual({ done: false, value: "Hello" });
    expect(upstreamCompleted).toBe(false);

    upstream.complete();

    const secondChunk = await withTimeout(iterator.next(), "second Azure stream chunk");
    const done = await withTimeout(iterator.next(), "Azure stream completion");

    expect(secondChunk).toEqual({ done: false, value: " world" });
    expect(done).toEqual({ done: true, value: undefined });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.stream).toBe(true);
  });

  it("emits a reasoning retry event before retrying the Azure stream with low effort", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        azureStreamResponse([
          {
            choices: [{ delta: {}, finish_reason: "length" }],
            usage: {
              prompt_tokens: 1,
              completion_tokens: 4,
              total_tokens: 5,
              completion_tokens_details: {
                reasoning_tokens: 4,
              },
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        azureStreamResponse([
          { choices: [{ delta: { content: "Recovered" }, finish_reason: null }] },
          { choices: [{ delta: { content: " output" }, finish_reason: null }] },
          {
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 1,
              completion_tokens: 2,
              total_tokens: 3,
            },
          },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const chunks = await collectStream(
      streamAiText({
        system: "You are helpful.",
        messages: [{ role: "user", content: "hello" }],
        maxTokens: 64,
        route: "chat",
      }),
    );

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toBeInstanceOf(AiReasoningRetryEvent);
    expect(chunks.slice(1)).toEqual(["Recovered", " output"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(firstBody.reasoning_effort).toBe("medium");
    expect(secondBody.reasoning_effort).toBe("low");
    expect(firstBody.stream).toBe(true);
    expect(secondBody.stream).toBe(true);
  });

  it("fails an Azure stream that ends before the completion marker even after yielding text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      truncatedAzureStreamResponse([
        { choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const iterator = streamAiText({
      system: "You are helpful.",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 64,
      route: "chat",
    });

    const firstChunk = await withTimeout(iterator.next(), "first truncated Azure chunk");

    expect(firstChunk).toEqual({ done: false, value: "Hello" });
    await expect(iterator.next()).rejects.toThrow(
      "Azure OpenAI stream ended before the completion marker",
    );
  });

  it("aborts while consuming an Azure SSE body", async () => {
    const controller = new AbortController();
    const upstream = controlledAzureStreamResponse(
      [{ choices: [{ delta: { content: "Hello" }, finish_reason: null }] }],
      [{ choices: [{ delta: { content: " world" }, finish_reason: null }] }],
    );
    const fetchMock = vi.fn().mockResolvedValue(upstream.response);
    vi.stubGlobal("fetch", fetchMock);

    const iterator = streamAiText({
      system: "You are helpful.",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 64,
      route: "chat",
      signal: controller.signal,
    });

    const firstChunk = await withTimeout(iterator.next(), "first abortable Azure chunk");
    expect(firstChunk).toEqual({ done: false, value: "Hello" });

    const pendingChunk = iterator.next();
    controller.abort();

    await expect(pendingChunk).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    upstream.complete();
    await upstream.completed;
  });

  it("retries a streamed request against the global deployment when the route-specific deployment is missing", async () => {
    process.env.AI_AZURE_OPENAI_DEPLOYMENT_SCENARIO = "gpt-4o-mini";

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(deploymentNotFoundResponse())
      .mockResolvedValueOnce(
        azureStreamResponse([
          { choices: [{ delta: { content: "scenario-text" }, finish_reason: null }] },
          {
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 1,
              completion_tokens: 1,
              total_tokens: 2,
            },
          },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const chunks = await collectStream(
      streamAiText({
        system: "You are helpful.",
        messages: [{ role: "user", content: "create scenario" }],
        maxTokens: 64,
        route: "scenario",
      }),
    );

    expect(chunks).toEqual(["scenario-text"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/deployments/gpt-4o-mini/");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/deployments/gpt-5.2/");
  });
});
