import { existsSync } from "fs";

export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4@20250514";
export const DEFAULT_AZURE_OPENAI_API_VERSION = "2024-10-21";
export const DEFAULT_AZURE_MODEL = "gpt-4o";

export type AiProvider = "vertex" | "azure-openai";

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

export function getConfiguredModel(): string {
  const model = process.env.AI_MODEL?.trim() ?? process.env.CLAUDE_MODEL?.trim();
  if (model && model.length > 0) return model;
  return getConfiguredProvider() === "azure-openai"
    ? DEFAULT_AZURE_MODEL
    : DEFAULT_CLAUDE_MODEL;
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
  return "vertex";
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

  const checks = {
    cloudMlRegionConfigured: cloudMlRegion.length > 0,
    anthropicProjectConfigured: anthropicProject.length > 0,
    credentialsPathConfigured: credentialsPath.length > 0,
    credentialsFileReadable:
      credentialsPath.length > 0 ? existsSync(credentialsPath) : null,
    azureOpenAiEndpointConfigured: azureEndpoint.length > 0,
    azureOpenAiApiKeyConfigured: azureApiKey.length > 0,
    azureOpenAiDeploymentConfigured: azureDeployment.length > 0,
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
  if (checks.credentialsPathConfigured && !checks.credentialsFileReadable) {
    reasons.push("GOOGLE_APPLICATION_CREDENTIALS points to a missing file");
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
