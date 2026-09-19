import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AZURE_MODEL,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  getAiReadiness,
  getConfiguredModel,
  getConfiguredProvider,
  getOpenRouterBaseUrl,
  shouldDegradeOnQuotaExhausted,
} from "./ai-config";

const TEST_ENV_KEYS = [
  "AI_PROVIDER",
  "AI_MOCK_MODE",
  "AI_MODEL",
  "CLAUDE_MODEL",
  "CLOUD_ML_REGION",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "AI_AZURE_OPENAI_ENDPOINT",
  "AI_AZURE_OPENAI_API_KEY",
  "AI_AZURE_OPENAI_DEPLOYMENT",
  "AI_OPENROUTER_API_KEY",
  "AI_OPENROUTER_BASE_URL",
  "AI_OPENROUTER_MODEL",
  "AI_DEGRADE_ON_QUOTA_EXHAUSTED",
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

function clearTestEnv(): void {
  for (const key of TEST_ENV_KEYS) {
    delete process.env[key];
  }
}

describe("ai-config readiness", () => {
  beforeEach(() => {
    clearTestEnv();
  });

  afterAll(() => {
    restoreTestEnv();
  });

  it("defaults to vertex and reports missing vertex runtime vars", () => {
    const readiness = getAiReadiness();

    expect(getConfiguredProvider()).toBe("vertex");
    expect(readiness.ready).toBe(false);
    expect(readiness.reasons).toContain("CLOUD_ML_REGION is not configured");
    expect(readiness.reasons).toContain(
      "ANTHROPIC_VERTEX_PROJECT_ID is not configured"
    );
  });

  it("treats mock mode as ready even without provider variables", () => {
    process.env.AI_MOCK_MODE = "true";

    const readiness = getAiReadiness();

    expect(readiness.ready).toBe(true);
    expect(readiness.reasons).toEqual([]);
  });

  it("normalizes azure provider and requires azure settings", () => {
    process.env.AI_PROVIDER = "azure";

    const readiness = getAiReadiness();

    expect(getConfiguredProvider()).toBe("azure-openai");
    expect(readiness.ready).toBe(false);
    expect(readiness.reasons).toContain(
      "AI_AZURE_OPENAI_ENDPOINT is not configured"
    );
    expect(readiness.reasons).toContain(
      "AI_AZURE_OPENAI_API_KEY is not configured"
    );
    expect(readiness.reasons).toContain(
      "AI_AZURE_OPENAI_DEPLOYMENT is not configured"
    );
  });

  it("normalizes the openrouter aliases and requires its key and model", () => {
    for (const alias of ["openrouter", "open-router", "open_router"]) {
      process.env.AI_PROVIDER = alias;
      expect(getConfiguredProvider()).toBe("openrouter");
    }

    const readiness = getAiReadiness();

    expect(readiness.ready).toBe(false);
    expect(readiness.reasons).toContain("AI_OPENROUTER_API_KEY is not configured");
    // Required even though AI_OPENROUTER_MODEL_<ROUTE> can override it: it is
    // the fallback every route without an override resolves to, so a missing
    // one would be a runtime throw rather than a startup refusal.
    expect(readiness.reasons).toContain("AI_OPENROUTER_MODEL is not configured");
  });

  it("is ready once the openrouter key and model are set", () => {
    process.env.AI_PROVIDER = "openrouter";
    process.env.AI_OPENROUTER_API_KEY = "test-key";
    process.env.AI_OPENROUTER_MODEL = "vendor/model:free";

    const readiness = getAiReadiness();

    expect(readiness.ready).toBe(true);
    expect(readiness.checks.openRouterApiKeyConfigured).toBe(true);
    expect(readiness.checks.openRouterModelConfigured).toBe(true);
    expect(readiness.model).toBe("vendor/model:free");
  });
});

describe("ai-config model selection", () => {
  beforeEach(() => {
    clearTestEnv();
  });

  afterAll(() => {
    restoreTestEnv();
  });

  it("uses provider defaults when no model is configured", () => {
    expect(getConfiguredModel()).toBe(DEFAULT_CLAUDE_MODEL);

    process.env.AI_PROVIDER = "azure-openai";
    expect(getConfiguredModel()).toBe(DEFAULT_AZURE_MODEL);

    process.env.AI_PROVIDER = "openrouter";
    expect(getConfiguredModel()).toBe(DEFAULT_OPENROUTER_MODEL);
  });

  it("prefers AI_OPENROUTER_MODEL over an AI_MODEL left behind by another provider", () => {
    // A deployment switched over from Azure normally still carries its AI_MODEL.
    // Reporting that here would make /api/ai/token-metrics and /api/ai/probe
    // name a model nothing ever called.
    process.env.AI_PROVIDER = "openrouter";
    process.env.AI_MODEL = "gpt-5.2";
    process.env.AI_OPENROUTER_MODEL = "vendor/model:free";

    expect(getConfiguredModel()).toBe("vendor/model:free");
  });

  it("keeps AI_MODEL authoritative for every other provider", () => {
    process.env.AI_PROVIDER = "azure-openai";
    process.env.AI_MODEL = "gpt-5.2";
    process.env.AI_OPENROUTER_MODEL = "vendor/model:free";

    expect(getConfiguredModel()).toBe("gpt-5.2");
  });
});

describe("ai-config openrouter knobs", () => {
  beforeEach(() => {
    clearTestEnv();
  });

  afterAll(() => {
    restoreTestEnv();
  });

  it("defaults the base URL and strips trailing slashes from an override", () => {
    expect(getOpenRouterBaseUrl()).toBe("https://openrouter.ai/api/v1");

    process.env.AI_OPENROUTER_BASE_URL = "https://proxy.test/v1//";
    expect(getOpenRouterBaseUrl()).toBe("https://proxy.test/v1");
  });

  it("degrades on an exhausted budget unless explicitly switched off", () => {
    expect(shouldDegradeOnQuotaExhausted()).toBe(true);

    process.env.AI_DEGRADE_ON_QUOTA_EXHAUSTED = "false";
    expect(shouldDegradeOnQuotaExhausted()).toBe(false);

    process.env.AI_DEGRADE_ON_QUOTA_EXHAUSTED = "nonsense";
    expect(shouldDegradeOnQuotaExhausted()).toBe(true);
  });
});
