import { accessSync, constants } from "fs";

export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4@20250514";
// Stable GA fallback used ONLY when AI_AZURE_OPENAI_API_VERSION is unset. Kept
// on a widely-available GA version so an unconfigured dev/tenant does not break
// on a preview that may not be enabled. Deployments that run reasoning-capable
// gpt-5.x models set AI_AZURE_OPENAI_API_VERSION=2025-04-01-preview explicitly
// (infra/outputs.tf, helm values, backend/.env.local.example) — that preview is
// the newest available on the ARO SRE tenant (2025-05-01-preview and later
// return HTTP 404), validated
// with a live chat/completions probe, and accepts `reasoning_effort` /
// `max_completion_tokens` (see docs/AI_RUNTIME.md).
export const DEFAULT_AZURE_OPENAI_API_VERSION = "2024-10-21";
// Fallback model when AI_MODEL is unset. Aligned with the provisioned Azure
// deployment default in infra/variables.tf (aoai_model_name). gpt-4o was stale.
export const DEFAULT_AZURE_MODEL = "gpt-5.6-terra";

// Display fallback when AI_OPENROUTER_MODEL is unset. It is never used for a
// live call: getAiReadiness() refuses to be ready without AI_OPENROUTER_MODEL,
// and getOpenRouterModelForRoute() throws rather than guessing. It exists so
// readiness/probe/token-metrics report a slug-shaped string in mock mode
// instead of an empty one. The free catalogue churns, so treat this as
// documentation of the shape, not as a supported default.
export const DEFAULT_OPENROUTER_MODEL = "z-ai/glm-5.2:free";
// OpenRouter speaks the OpenAI chat/completions dialect at this prefix; the
// transport appends "/chat/completions".
export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export type AiProvider = "vertex" | "azure-openai" | "openrouter";

export interface AiReadiness {
  ready: boolean;
  provider: AiProvider;
  mockMode: boolean;
  model: string;
  strictStartup: boolean;
  checks: {
    cloudMlRegionConfigured: boolean;
    anthropicProjectConfigured: boolean;
    credentialsPathConfigured: boolean;
    credentialsFileReadable: boolean | null;
    azureOpenAiEndpointConfigured: boolean;
    azureOpenAiApiKeyConfigured: boolean;
    azureOpenAiDeploymentConfigured: boolean;
    openRouterApiKeyConfigured: boolean;
    openRouterModelConfigured: boolean;
  };
  reasons: string[];
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function isReadableFile(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function getConfiguredModel(): string {
  const provider = getConfiguredProvider();
  // On OpenRouter the slug *is* the model, so AI_OPENROUTER_MODEL wins over the
  // generic AI_MODEL: a deployment switched over from Azure normally still
  // carries an AI_MODEL left from that provider, and reporting it here would
  // make /api/ai/token-metrics and /api/ai/probe name a model nothing called.
  if (provider === "openrouter") {
    const openRouterModel = process.env.AI_OPENROUTER_MODEL?.trim();
    if (openRouterModel && openRouterModel.length > 0) return openRouterModel;
  }

  const model = process.env.AI_MODEL?.trim() ?? process.env.CLAUDE_MODEL?.trim();
  if (model && model.length > 0) return model;

  if (provider === "azure-openai") return DEFAULT_AZURE_MODEL;
  if (provider === "openrouter") return DEFAULT_OPENROUTER_MODEL;
  return DEFAULT_CLAUDE_MODEL;
}

export function getConfiguredProvider(): AiProvider {
  const rawProvider = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (!rawProvider || rawProvider === "vertex") return "vertex";
  if (
    rawProvider === "azure-openai" ||
    rawProvider === "azure_openai" ||
    rawProvider === "azureopenai" ||
    rawProvider === "azure"
  ) {
    return "azure-openai";
  }
  if (rawProvider === "openrouter" || rawProvider === "open-router" || rawProvider === "open_router") {
    return "openrouter";
  }
  return "vertex";
}

/**
 * Degrading to simulated output keeps a spent free-tier budget playable, where a
 * hard error response reads as an outage. Setting this to false restores the
 * pre-OpenRouter behaviour exactly: a quota failure is an AiThrottledError like
 * any other, and every route answers it the way it always has.
 */
export function shouldDegradeOnQuotaExhausted(): boolean {
  return parseBoolean(process.env.AI_DEGRADE_ON_QUOTA_EXHAUSTED, true);
}

export function getOpenRouterBaseUrl(): string {
  const base = process.env.AI_OPENROUTER_BASE_URL?.trim();
  const resolved = base && base.length > 0 ? base : DEFAULT_OPENROUTER_BASE_URL;
  return resolved.replace(/\/+$/, "");
}

export function getAiReadiness(): AiReadiness {
  const provider = getConfiguredProvider();
  const mockMode = parseBoolean(process.env.AI_MOCK_MODE, false);
  const strictStartup = parseBoolean(process.env.AI_STRICT_STARTUP, true);
  const cloudMlRegion = process.env.CLOUD_ML_REGION?.trim() ?? "";
  const anthropicProject = process.env.ANTHROPIC_VERTEX_PROJECT_ID?.trim() ?? "";
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim() ?? "";
  const azureEndpoint = process.env.AI_AZURE_OPENAI_ENDPOINT?.trim() ?? "";
  const azureApiKey = process.env.AI_AZURE_OPENAI_API_KEY?.trim() ?? "";
  const azureDeployment = process.env.AI_AZURE_OPENAI_DEPLOYMENT?.trim() ?? "";
  const openRouterApiKey = process.env.AI_OPENROUTER_API_KEY?.trim() ?? "";
  const openRouterModel = process.env.AI_OPENROUTER_MODEL?.trim() ?? "";

  const checks = {
    cloudMlRegionConfigured: cloudMlRegion.length > 0,
    anthropicProjectConfigured: anthropicProject.length > 0,
    credentialsPathConfigured: credentialsPath.length > 0,
    credentialsFileReadable:
      credentialsPath.length > 0 ? isReadableFile(credentialsPath) : null,
    azureOpenAiEndpointConfigured: azureEndpoint.length > 0,
    azureOpenAiApiKeyConfigured: azureApiKey.length > 0,
    azureOpenAiDeploymentConfigured: azureDeployment.length > 0,
    openRouterApiKeyConfigured: openRouterApiKey.length > 0,
    openRouterModelConfigured: openRouterModel.length > 0,
  };

  const reasons: string[] = [];
  if (!mockMode && provider === "vertex" && !checks.cloudMlRegionConfigured) {
    reasons.push("CLOUD_ML_REGION is not configured");
  }
  if (!mockMode && provider === "vertex" && !checks.anthropicProjectConfigured) {
    reasons.push("ANTHROPIC_VERTEX_PROJECT_ID is not configured");
  }
  if (
    !mockMode &&
    provider === "azure-openai" &&
    !checks.azureOpenAiEndpointConfigured
  ) {
    reasons.push("AI_AZURE_OPENAI_ENDPOINT is not configured");
  }
  if (
    !mockMode &&
    provider === "azure-openai" &&
    !checks.azureOpenAiApiKeyConfigured
  ) {
    reasons.push("AI_AZURE_OPENAI_API_KEY is not configured");
  }
  if (
    !mockMode &&
    provider === "azure-openai" &&
    !checks.azureOpenAiDeploymentConfigured
  ) {
    reasons.push("AI_AZURE_OPENAI_DEPLOYMENT is not configured");
  }
  if (
    !mockMode &&
    provider === "openrouter" &&
    !checks.openRouterApiKeyConfigured
  ) {
    reasons.push("AI_OPENROUTER_API_KEY is not configured");
  }
  // Required even though AI_OPENROUTER_MODEL_<ROUTE> can override it per route:
  // it is the fallback every route without an override resolves to, so without
  // it a single missing override is a runtime throw rather than a startup one.
  if (
    !mockMode &&
    provider === "openrouter" &&
    !checks.openRouterModelConfigured
  ) {
    reasons.push("AI_OPENROUTER_MODEL is not configured");
  }
  if (
    !mockMode &&
    provider === "vertex" &&
    checks.credentialsPathConfigured &&
    !checks.credentialsFileReadable
  ) {
    reasons.push("GOOGLE_APPLICATION_CREDENTIALS points to a missing or unreadable file");
  }

  return {
    ready: reasons.length === 0,
    provider,
    mockMode,
    model: getConfiguredModel(),
    strictStartup,
    checks,
    reasons,
  };
}

export function assertAiReadyForRuntime(): AiReadiness {
  const readiness = getAiReadiness();
  if (!readiness.ready) {
    throw new Error(`AI runtime misconfigured: ${readiness.reasons.join("; ")}`);
  }
  return readiness;
}

export function getAzureOpenAiApiVersion(): string {
  const version = process.env.AI_AZURE_OPENAI_API_VERSION?.trim();
  return version && version.length > 0
    ? version
    : DEFAULT_AZURE_OPENAI_API_VERSION;
}
