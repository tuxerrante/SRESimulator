import { getAzureOpenAiApiVersion, getConfiguredModel } from "../ai-config";
import type { AiRoute } from "../token-logger";
import type { AiTextRequest, OpenAiCompatibleTarget } from "./types";

const deploymentReasoningEffortSupport = new Map<string, boolean>();

/**
 * Resolve the Azure OpenAI deployment for a given route.
 * Falls back to the global AI_AZURE_OPENAI_DEPLOYMENT if no
 * route-specific override is configured. Throws with clear
 * diagnostics when neither is set.
 */
function getDeploymentForRoute(route?: AiRoute): string {
  let routeEnvKey: string | undefined;

  if (route) {
    routeEnvKey = `AI_AZURE_OPENAI_DEPLOYMENT_${route.toUpperCase()}`;
    const routeDeployment = process.env[routeEnvKey]?.trim();
    if (routeDeployment && routeDeployment.length > 0) return routeDeployment;
  }

  const globalDeployment = process.env.AI_AZURE_OPENAI_DEPLOYMENT?.trim();
  if (globalDeployment && globalDeployment.length > 0) return globalDeployment;

  const missingKeys = routeEnvKey
    ? [routeEnvKey, "AI_AZURE_OPENAI_DEPLOYMENT"]
    : ["AI_AZURE_OPENAI_DEPLOYMENT"];
  throw new Error(
    `Azure OpenAI deployment not configured. Set: ${missingKeys.join(" or ")}`
  );
}

/** Route-only override from `AI_AZURE_OPENAI_DEPLOYMENT_<ROUTE>` when set. */
function getRouteSpecificAzureDeployment(route?: AiRoute): string | null {
  if (!route) return null;
  const routeEnvKey = `AI_AZURE_OPENAI_DEPLOYMENT_${route.toUpperCase()}`;
  const routeDeployment = process.env[routeEnvKey]?.trim();
  return routeDeployment && routeDeployment.length > 0 ? routeDeployment : null;
}

function isAzureDeploymentNotFoundResponse(status: number, details: string): boolean {
  if (status !== 404) return false;
  if (/deploymentnotfound/i.test(details)) return true;
  try {
    const parsed = JSON.parse(details) as { error?: { code?: string } };
    return parsed?.error?.code === "DeploymentNotFound";
  } catch {
    return false;
  }
}

class AzureDeploymentNotFoundError extends Error {
  override readonly name = "AzureDeploymentNotFoundError";
  constructor(message: string) {
    super(message);
  }
}

function isReasoningModelName(value: string): boolean {
  return /^o\d/.test(value) || /^gpt-5/.test(value);
}

function shouldSendReasoningEffort(deployment: string): boolean {
  const deploymentKey = deployment.trim().toLowerCase();
  const cached = deploymentReasoningEffortSupport.get(deploymentKey);
  if (cached !== undefined) return cached;

  const configuredModel = getConfiguredModel().trim().toLowerCase();
  const deploymentLooksNonReasoningModel =
    deploymentKey.includes("gpt-4o") ||
    deploymentKey.includes("gpt-4.1") ||
    deploymentKey.includes("gpt-4.5") ||
    deploymentKey.includes("gpt-35") ||
    deploymentKey.includes("gpt-3.5");

  const supports =
    isReasoningModelName(deploymentKey) ||
    (isReasoningModelName(configuredModel) && !deploymentLooksNonReasoningModel);

  deploymentReasoningEffortSupport.set(deploymentKey, supports);
  return supports;
}

function buildTargetForDeployment(deployment: string): OpenAiCompatibleTarget {
  const endpoint = process.env.AI_AZURE_OPENAI_ENDPOINT!;
  const key = process.env.AI_AZURE_OPENAI_API_KEY!;
  const base = endpoint.replace(/\/+$/, "");
  const apiVersion = getAzureOpenAiApiVersion();
  const deploymentKey = deployment.trim().toLowerCase();

  return {
    providerLabel: "Azure OpenAI",
    url: `${base}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`,
    headers: { "api-key": key },
    modelValue: deployment,
    // Azure names the deployment in the path, so the body must not carry a
    // `model` key.
    modelField: null,
    modelNoun: "deployment",
    maxTokensField: "max_completion_tokens",
    allowMaxTokensFieldFallback: true,
    supportsReasoningEffort: shouldSendReasoningEffort(deployment),
    supportsPromptCacheKey: true,
    onReasoningEffortRejected: () => {
      deploymentReasoningEffortSupport.set(deploymentKey, false);
    },
    classifyFailure: (status, body) =>
      isAzureDeploymentNotFoundResponse(status, body)
        ? new AzureDeploymentNotFoundError(
            `Azure OpenAI request failed (${status}): ${body}`,
          )
        : null,
    isFallbackTrigger: (error) => error instanceof AzureDeploymentNotFoundError,
  };
}

export function buildAzureOpenAiTarget(request: AiTextRequest): OpenAiCompatibleTarget {
  const deployment = getDeploymentForRoute(request.route);
  const routeSpecificDeployment = getRouteSpecificAzureDeployment(request.route);
  const globalDeployment = process.env.AI_AZURE_OPENAI_DEPLOYMENT?.trim() ?? "";
  const canDeploymentFallback =
    Boolean(routeSpecificDeployment) &&
    globalDeployment.length > 0 &&
    routeSpecificDeployment !== globalDeployment &&
    deployment === routeSpecificDeployment;

  const target = buildTargetForDeployment(deployment);
  if (!canDeploymentFallback) return target;
  return { ...target, fallbackTarget: buildTargetForDeployment(globalDeployment) };
}
