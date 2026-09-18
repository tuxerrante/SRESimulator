import { getOpenRouterBaseUrl } from "../ai-config";
import type { AiRoute } from "../token-logger";
import { AiQuotaExhaustedError, type AiTextRequest, type OpenAiCompatibleTarget } from "./types";

/**
 * Resolve the OpenRouter model slug for a route, most specific first.
 *
 * Structurally the same as the Azure deployment resolver, with one extra rung:
 * `scenario` and `probe` fall through to the command model. Both are one-shot,
 * non-conversational calls shaped like command simulation, and the free tier is
 * a *shared* budget -- giving them their own slug would mean curating four
 * models out of a catalogue that churns, for no behavioural gain. An explicit
 * AI_OPENROUTER_MODEL_SCENARIO / _PROBE still wins.
 */
function getOpenRouterModelForRoute(route?: AiRoute): string {
  const candidateKeys: string[] = [];
  if (route) {
    candidateKeys.push(`AI_OPENROUTER_MODEL_${route.toUpperCase()}`);
    if (route === "scenario" || route === "probe") {
      candidateKeys.push("AI_OPENROUTER_MODEL_COMMAND");
    }
  }
  candidateKeys.push("AI_OPENROUTER_MODEL");

  for (const key of candidateKeys) {
    const value = process.env[key]?.trim();
    if (value && value.length > 0) return value;
  }

  throw new Error(
    `OpenRouter model not configured. Set: ${candidateKeys.join(" or ")}`
  );
}

/**
 * Header values are env-sourced and go straight into `fetch`, which throws a
 * TypeError on a value carrying a control character -- that would surface as an
 * opaque failure on every AI call rather than as a configuration error.
 */
function readOptionalHeaderValue(name: string): string | null {
  const value = process.env[name]?.trim();
  if (!value || value.length === 0) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) {
    console.warn(`[ai-runtime] ignoring ${name}: header values cannot contain control characters`);
    return null;
  }
  return value;
}

/**
 * A day-scoped cap and the 20-requests-per-minute cap are both HTTP 429, and
 * only the day-scoped one is pointless to retry inside the request. Matching
 * the message is what separates them; OpenRouter also tags the cap kind in
 * `error.metadata`, which is checked but is not sufficient on its own because
 * the per-minute limit carries the same `error_type`.
 */
function isDayScopedRateLimit(body: string): boolean {
  const dayScoped = /free-models-per-day|per[- ]day|\bdaily\b/i;
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; metadata?: Record<string, unknown> };
    };
    const message = parsed?.error?.message ?? "";
    if (dayScoped.test(message)) return true;
    const metadata = parsed?.error?.metadata;
    if (!metadata) return false;
    const errorType = (metadata as { error_type?: string }).error_type;
    return errorType === "rate_limit_exceeded" && dayScoped.test(JSON.stringify(metadata));
  } catch {
    return dayScoped.test(body);
  }
}

function classifyOpenRouterFailure(status: number, body: string): Error | null {
  if (status === 402) {
    return new AiQuotaExhaustedError(
      "credits",
      "The shared OpenRouter account is out of credit. Responses are simulated until it is topped up.",
    );
  }
  if (status === 429 && isDayScopedRateLimit(body)) {
    return new AiQuotaExhaustedError(
      "daily",
      "The shared OpenRouter daily request budget is spent. Responses are simulated until it resets.",
    );
  }
  return null;
}

export function buildOpenRouterTarget(request: AiTextRequest): OpenAiCompatibleTarget {
  const key = process.env.AI_OPENROUTER_API_KEY!;
  const model = getOpenRouterModelForRoute(request.route);

  const headers: Record<string, string> = { authorization: `Bearer ${key}` };
  // OpenRouter attributes traffic on its public leaderboards from these two and
  // ignores them when absent; they carry no credentials.
  const siteUrl = readOptionalHeaderValue("AI_OPENROUTER_SITE_URL");
  if (siteUrl) headers["http-referer"] = siteUrl;
  const appTitle = readOptionalHeaderValue("AI_OPENROUTER_APP_TITLE");
  if (appTitle) headers["x-title"] = appTitle;

  return {
    providerLabel: "OpenRouter",
    url: `${getOpenRouterBaseUrl()}/chat/completions`,
    headers,
    modelValue: model,
    modelField: "model",
    // OpenRouter normalises to the OpenAI legacy spelling across every upstream
    // it proxies, so there is one stable name and no reason to retry under the
    // other -- retrying would turn an unrelated error that happens to mention
    // the field into a second request against a metered budget.
    maxTokensField: "max_tokens",
    allowMaxTokensFieldFallback: false,
    // reasoning_effort is not part of the OpenRouter request schema; it exposes
    // a `reasoning` object instead, which the free models here do not use.
    supportsReasoningEffort: false,
    supportsPromptCacheKey: false,
    classifyFailure: classifyOpenRouterFailure,
    inspectThrottleBody: true,
  };
}

export interface OpenRouterKeyStatus {
  dailyLimit: number | null;
  dailyRemaining: number | null;
}

interface CachedKeyStatus {
  fetchedAtMs: number;
  status: OpenRouterKeyStatus | null;
}

let cachedKeyStatus: CachedKeyStatus | null = null;

function getQuotaTtlMs(): number {
  const parsed = Number.parseInt(process.env.AI_OPENROUTER_QUOTA_TTL_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
}

function readOptionalNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Best-effort live view of the account's free-tier budget, cached for
 * AI_OPENROUTER_QUOTA_TTL_MS.
 *
 * Every field is optional on purpose: this response has gained and renamed
 * keys before, and the banner it feeds must degrade to "no upstream number"
 * rather than break. It never throws and never rejects -- a budget display
 * failing is not a reason for an AI route to fail.
 */
export async function fetchOpenRouterKeyStatus(): Promise<OpenRouterKeyStatus | null> {
  const key = process.env.AI_OPENROUTER_API_KEY?.trim();
  if (!key) return null;

  const nowMs = Date.now();
  if (cachedKeyStatus && nowMs - cachedKeyStatus.fetchedAtMs < getQuotaTtlMs()) {
    return cachedKeyStatus.status;
  }

  let status: OpenRouterKeyStatus | null = null;
  try {
    const response = await fetch(`${getOpenRouterBaseUrl()}/key`, {
      headers: { authorization: `Bearer ${key}` },
    });
    if (response.ok) {
      const payload = (await response.json()) as { data?: Record<string, unknown> };
      const data = payload?.data;
      if (data && typeof data === "object") {
        status = {
          dailyLimit: readOptionalNumber(data, "free_model_daily_requests"),
          dailyRemaining:
            readOptionalNumber(data, "free_model_daily_requests_remaining") ??
            readOptionalNumber(data, "limit_remaining"),
        };
      }
    }
  } catch {
    status = null;
  }

  cachedKeyStatus = { fetchedAtMs: nowMs, status };
  return status;
}
