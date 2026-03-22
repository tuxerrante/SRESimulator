import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AZURE_MODEL,
  DEFAULT_CLAUDE_MODEL,
  getAiReadiness,
  getConfiguredModel,
  getConfiguredProvider,
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
  });
});
