import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AZURE_MODEL,
  DEFAULT_CLAUDE_MODEL,
  getAiReadiness,
  getConfiguredModel,
  getConfiguredProvider,
} from "./ai-config";

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.AI_PROVIDER;
  delete process.env.AI_MOCK_MODE;
  delete process.env.AI_MODEL;
  delete process.env.CLAUDE_MODEL;
  delete process.env.CLOUD_ML_REGION;
  delete process.env.ANTHROPIC_VERTEX_PROJECT_ID;
  delete process.env.AI_AZURE_OPENAI_ENDPOINT;
  delete process.env.AI_AZURE_OPENAI_API_KEY;
  delete process.env.AI_AZURE_OPENAI_DEPLOYMENT;
}

describe("ai-config readiness", () => {
  beforeEach(() => {
    resetEnv();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
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
    resetEnv();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("uses provider defaults when no model is configured", () => {
    expect(getConfiguredModel()).toBe(DEFAULT_CLAUDE_MODEL);

    process.env.AI_PROVIDER = "azure-openai";
    expect(getConfiguredModel()).toBe(DEFAULT_AZURE_MODEL);
  });
});
