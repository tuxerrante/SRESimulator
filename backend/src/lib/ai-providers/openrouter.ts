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
  /**
   * Which account this reading describes; see {@link readAccountIdentity}.
   * Carries credential material, so this object stays module-private.
   */
  identity: string;
}

let cachedKeyStatus: CachedKeyStatus | null = null;

/**
 * The refresh in flight, shared by every caller that arrives during it.
 * `/api/ai/budget` is public and the banner polls it, so without this the
 * moment the TTL expires turns every concurrent visitor into its own
 * `GET /key` -- a self-inflicted herd against the rate limit this lookup
 * exists to report on.
 *
 * Tagged with the identity it was opened under, so a refresh started before a
 * key rotation is never handed to a caller asking about the new account.
 */
let inFlightKeyStatus:
  | { identity: string; promise: Promise<OpenRouterKeyStatus | null> }
  | null = null;

/**
 * Which account a reading describes: the API key it was read with, through the
 * base URL it was read from.
 *
 * The cache has to carry this because `readLastKnownOpenRouterDailyLimit`
 * deliberately ignores the TTL. Without an identity, rotating the key in a
 * long-lived process leaves the *previous* account's tier standing as a
 * permanent clamp -- and rotating down from a credited 1000/day account to an
 * un-credited one would then authorise twenty times the new account's real cap,
 * with nothing left to expire the reading that allowed it.
 *
 * A reading is therefore only ever usable by the identity it was taken under.
 * That also settles the narrow race where a slow lookup lands after a rotation:
 * the stale write is stamped with the old identity, so the worst it can do is
 * cost a re-warm, never raise a cap.
 *
 * The credential is compared rather than digested. A digest of a credential is
 * what `js/insufficient-password-hash` objects to, and it objects correctly:
 * the honest remedies are a slow KDF, which is absurd on a path every charge
 * runs, or not deriving anything. Nothing is lost by comparing, because
 * `cachedKeyStatus` is module-private and never escapes -- callers receive
 * `.status`, which holds two numbers. Keep it that way: this value must not be
 * logged, returned or folded into anything that is.
 *
 * The NUL separator keeps the two fields unambiguous -- an environment variable
 * cannot contain one, so no key-and-base-URL pair can spell another.
 */
function readAccountIdentity(apiKey: string): string {
  return `${apiKey}\u0000${getOpenRouterBaseUrl()}`;
}

/** Bounds the auxiliary lookup; the banner is not worth a hung request. */
const KEY_STATUS_TIMEOUT_MS = 5000;

function getQuotaTtlMs(): number {
  const parsed = Number.parseInt(process.env.AI_OPENROUTER_QUOTA_TTL_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
}

function readOptionalNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * `free_model_daily_requests` is an object -- `{ used, limit, remaining }` --
 * not a request count, and there is no flat sibling holding either number.
 *
 * There is no fallback on purpose. `limit_remaining` is the nearest-looking
 * field and it is a *credit balance*, a fractional currency amount: reporting
 * 18.42 as "requests left today" is worse than reporting nothing, because the
 * banner would render a confident wrong number instead of staying quiet.
 */
function readFreeModelDailyRequests(data: Record<string, unknown>): OpenRouterKeyStatus {
  const raw = data.free_model_daily_requests;
  if (!raw || typeof raw !== "object") {
    return { dailyLimit: null, dailyRemaining: null };
  }
  const counter = raw as Record<string, unknown>;
  return {
    dailyLimit: readOptionalNumber(counter, "limit"),
    dailyRemaining: readOptionalNumber(counter, "remaining"),
  };
}

/**
 * The last `dailyLimit` this process actually saw, read from the cache with no
 * fetch and no TTL check.
 *
 * Two deliberate departures from `fetchOpenRouterKeyStatus`, both because the
 * caller is the budget limiter rather than the banner:
 *
 * - **It never reaches the network.** A limiter that has to make a request to
 *   learn its own cap cannot fail closed, so this returns `null` and lets the
 *   configured figure stand rather than awaiting anything.
 * - **It ignores the TTL.** The TTL exists to keep a *displayed* remaining
 *   count fresh; the tier limit behind it moves once, when an account buys
 *   credit. Expiring it would make the cap flicker back up between banner
 *   visits, which is the one direction a safety clamp must never move.
 */
export function readLastKnownOpenRouterDailyLimit(): number | null {
  const apiKey = process.env.AI_OPENROUTER_API_KEY?.trim();
  if (!apiKey || !cachedKeyStatus) return null;
  // A reading taken on another account says nothing about this one, and
  // because this read ignores the TTL it would otherwise say it forever.
  if (cachedKeyStatus.identity !== readAccountIdentity(apiKey)) return null;

  const limit = cachedKeyStatus.status?.dailyLimit;
  return typeof limit === "number" && limit > 0 ? limit : null;
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

  const identity = readAccountIdentity(key);
  const nowMs = Date.now();
  if (
    cachedKeyStatus &&
    cachedKeyStatus.identity === identity &&
    nowMs - cachedKeyStatus.fetchedAtMs < getQuotaTtlMs()
  ) {
    return cachedKeyStatus.status;
  }
  if (inFlightKeyStatus?.identity === identity) return inFlightKeyStatus.promise;

  const promise = (async () => {
    let status: OpenRouterKeyStatus | null = null;
    try {
      const response = await fetch(`${getOpenRouterBaseUrl()}/key`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(KEY_STATUS_TIMEOUT_MS),
      });
      if (response.ok) {
        const payload = (await response.json()) as { data?: Record<string, unknown> };
        const data = payload?.data;
        if (data && typeof data === "object") {
          status = readFreeModelDailyRequests(data);
        }
      }
    } catch {
      status = null;
    }
    cachedKeyStatus = { fetchedAtMs: Date.now(), status, identity };
    return status;
  })().finally(() => {
    // Only retire our own entry: a rotation may have opened a newer one while
    // this lookup was still in the air.
    if (inFlightKeyStatus?.promise === promise) inFlightKeyStatus = null;
  });
  inFlightKeyStatus = { identity, promise };

  return promise;
}
