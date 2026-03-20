import { existsSync } from "fs";

export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4@20250514";

export interface AiReadiness {
  ready: boolean;
  provider: "vertex";
  mockMode: boolean;
  model: string;
  strictStartup: boolean;
  checks: {
    cloudMlRegionConfigured: boolean;
    anthropicProjectConfigured: boolean;
    credentialsPathConfigured: boolean;
    credentialsFileReadable: boolean | null;
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
  const model = process.env.CLAUDE_MODEL?.trim();
  return model && model.length > 0 ? model : DEFAULT_CLAUDE_MODEL;
}

export function getAiReadiness(): AiReadiness {
  const provider = "vertex";
  const mockMode = parseBoolean(process.env.AI_MOCK_MODE, false);
  const strictStartup = parseBoolean(process.env.AI_STRICT_STARTUP, true);
  const cloudMlRegion = process.env.CLOUD_ML_REGION?.trim() ?? "";
  const anthropicProject = process.env.ANTHROPIC_VERTEX_PROJECT_ID?.trim() ?? "";
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim() ?? "";

  const checks = {
    cloudMlRegionConfigured: cloudMlRegion.length > 0,
    anthropicProjectConfigured: anthropicProject.length > 0,
    credentialsPathConfigured: credentialsPath.length > 0,
    credentialsFileReadable:
      credentialsPath.length > 0 ? existsSync(credentialsPath) : null,
  };

  const reasons: string[] = [];
  if (!mockMode && !checks.cloudMlRegionConfigured) {
    reasons.push("CLOUD_ML_REGION is not configured");
  }
  if (!mockMode && !checks.anthropicProjectConfigured) {
    reasons.push("ANTHROPIC_VERTEX_PROJECT_ID is not configured");
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
