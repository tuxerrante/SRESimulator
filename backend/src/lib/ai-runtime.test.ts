import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateAiText } from "./ai-runtime";

const TEST_ENV_KEYS = [
  "AI_PROVIDER",
  "AI_MODEL",
  "AI_REASONING_EFFORT",
  "AI_AZURE_OPENAI_ENDPOINT",
  "AI_AZURE_OPENAI_API_KEY",
  "AI_AZURE_OPENAI_DEPLOYMENT",
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

describe("ai-runtime reasoning_effort compatibility", () => {
  beforeEach(() => {
    clearTestEnv();
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

    expect(firstBody.reasoning_effort).toBe("medium");
    expect(secondBody.reasoning_effort).toBeUndefined();
    expect(thirdBody.reasoning_effort).toBeUndefined();
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
  });
});
