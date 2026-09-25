import type { NextFunction, Request, RequestHandler, Response } from "express";
import { getAiReadiness, getConfiguredProvider } from "./ai-config";
import { fetchOpenRouterKeyStatus } from "./ai-providers/openrouter";
import { consumeSharedWindow } from "./rate-limit";

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_GLOBAL_MINUTE_MAX = 20;
/**
 * OpenRouter's free-model allowance is tiered: 50 requests/day below 10
 * lifetime credits and 1000/day at or above it. The default matches the
 * post-purchase tier this deployment targets; an account that has not bought
 * credit must set `AI_GLOBAL_DAILY_MAX=50` or it will spend past the real cap
 * and learn about it from provider 429s. Those degrade rather than fail, and
 * `/api/ai/budget` reports the account's own `free_model_daily_requests.limit`
 * alongside this number, so the discrepancy is visible rather than inferred --
 * but the enforced figure is deliberately local, because a limiter that has to
 * reach the network to know its own limit cannot fail closed.
 */
const DEFAULT_GLOBAL_DAILY_MAX = 1000;
const MINUTE_KEY = "global:ai:minute";
const DAY_KEY = "global:ai:day";
const AI_BUDGET_HEADER = "x-sresim-ai-budget";

type BudgetScope = "minute" | "daily";

interface WindowState {
  limit: number;
  remaining: number;
  resetAtMs: number;
}

/**
 * Last decision observed per window, so `GET /api/ai/budget` can report the
 * budget without spending any of it. The store interface only consumes, and an
 * endpoint that charged the budget to describe it would be self-defeating --
 * the banner polls it.
 *
 * Consequence worth knowing: with more than one replica this reflects the pod
 * that answered, not the fleet. That is the same single-replica assumption the
 * in-memory store already makes, and why values-oci.yaml pins replicas to 1.
 */
const lastWindowState = new Map<BudgetScope, WindowState>();

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Off unless OpenRouter is the provider: the budget exists because the free
 * tier is capped per *account*, and a per-identity limiter cannot see that.
 * Azure and Vertex bill per token with no shared daily cliff, so enabling it
 * there would only add a second limiter nobody asked for.
 */
function isAiGlobalBudgetEnabled(): boolean {
  // Mock mode never reaches a provider, so there is no shared account to
  // protect and every charge would be pure leakage -- worst of all in the
  // free-e2e gate, which drives four simulated players through chat and
  // command with `AI_MOCK_MODE=true`.
  if (getAiReadiness().mockMode) return false;
  return parseBoolean(
    process.env.AI_GLOBAL_BUDGET_ENABLED,
    getConfiguredProvider() === "openrouter",
  );
}

function getGlobalMinuteMax(): number {
  return parsePositiveInt(process.env.AI_GLOBAL_MINUTE_MAX, DEFAULT_GLOBAL_MINUTE_MAX);
}

function getGlobalDailyMax(): number {
  return parsePositiveInt(process.env.AI_GLOBAL_DAILY_MAX, DEFAULT_GLOBAL_DAILY_MAX);
}

/** `degrade` answers with simulated output; `reject` answers 429. */
function shouldDegradeOnDailyExhaustion(): boolean {
  return (process.env.AI_GLOBAL_DAILY_EXHAUSTED_MODE ?? "degrade")
    .trim()
    .toLowerCase() !== "reject";
}

/**
 * The per-identity limiter fails *open* when Redis is unavailable, which is
 * right for abuse protection and backwards for a spend budget: failing open
 * there means overspending a real account. Failing closed is affordable only
 * because an exhausted budget is playable -- it degrades to simulated output.
 */
function shouldFailClosed(): boolean {
  return (process.env.AI_GLOBAL_BUDGET_FAIL_MODE ?? "closed")
    .trim()
    .toLowerCase() !== "open";
}

function rememberWindow(scope: BudgetScope, state: WindowState): void {
  lastWindowState.set(scope, state);
}

/**
 * A remembered decision describes the window it was taken in and nothing
 * after it. Once `resetAtMs` passes the window is empty again, so returning
 * the old `remaining: 0` would leave the banner insisting answers are
 * simulated until the next AI request happens to refresh the map -- which on
 * a quiet deployment is exactly the request the banner just discouraged.
 */
function readWindow(scope: BudgetScope, nowMs: number): WindowState | undefined {
  const state = lastWindowState.get(scope);
  if (!state) return undefined;
  if (nowMs >= state.resetAtMs) {
    lastWindowState.delete(scope);
    return undefined;
  }
  return state;
}

/** Set by the middleware when the day budget is spent and the mode is degrade. */
export function isAiBudgetExhausted(res: Response): boolean {
  return res.locals.aiBudgetExhausted === true;
}

/**
 * A store outage is not an exhausted account, and saying so misleads exactly
 * the reader who needs the truth: the operator reading logs during an
 * incident, and a client told to come back tomorrow for a Redis blip. The
 * budget is untouched here -- nothing was observed, let alone spent.
 */
function rejectWithBudgetUnavailable(res: Response, retryAfterSeconds: number): void {
  res.setHeader(AI_BUDGET_HEADER, "store-unavailable");
  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.status(503).json({
    error: "The shared AI budget cannot be checked right now. Please retry shortly.",
    code: "ai_budget_unavailable",
    retryAfterSeconds,
    degraded: false,
  });
}

function rejectWithBudgetExhausted(
  res: Response,
  scope: BudgetScope,
  retryAfterSeconds: number,
  resetAtMs: number,
): void {
  res.setHeader(AI_BUDGET_HEADER, `${scope}-exhausted`);
  res.setHeader("Retry-After", String(retryAfterSeconds));
  // `error` stays the first key: the frontend's fetchJsonObject surfaces it
  // verbatim, and every other field here is additive.
  res.status(429).json({
    error:
      scope === "minute"
        ? "The shared AI budget is busy right now. Please retry in a moment."
        : "The shared AI budget for today is spent. Please try again tomorrow.",
    code: "ai_budget_exhausted",
    scope,
    retryAfterSeconds,
    resetAt: new Date(resetAtMs).toISOString(),
    degraded: false,
  });
}

/**
 * Global spend budget for the shared AI account, composed *after* the
 * per-identity limiter.
 *
 * The two windows are consumed in order and the daily one is only charged
 * once the minute one allowed the request: a caller refused on the minute
 * window never reached the provider, so charging the day for it would leak
 * budget that was never spent. `willCallProvider` extends that same rule to
 * routes that can answer without a provider call at all.
 *
 * @param willCallProvider evaluated per request; `false` passes the request
 *   through uncharged. Read at call time, not at mount time, because the
 *   environment it consults is read at call time everywhere else too.
 */
export function createAiGlobalBudgetLimit(
  willCallProvider: () => boolean = () => true,
): RequestHandler {
  return async (_req: Request, res: Response, next: NextFunction) => {
    if (!isAiGlobalBudgetEnabled() || !willCallProvider()) {
      next();
      return;
    }

    const minuteMax = getGlobalMinuteMax();
    const dailyMax = getGlobalDailyMax();
    const nowMs = Date.now();

    let minute;
    let day;
    try {
      minute = await consumeSharedWindow(MINUTE_KEY, MINUTE_MS, minuteMax, nowMs);
      rememberWindow("minute", {
        limit: minuteMax,
        remaining: minute.decision.remaining,
        resetAtMs: minute.decision.resetAtMs,
      });

      if (!minute.decision.allowed) {
        // Transient by construction: the window rolls in under a minute, so a
        // retry genuinely helps and simulated output would be a worse answer.
        rejectWithBudgetExhausted(
          res,
          "minute",
          minute.decision.retryAfterSeconds,
          minute.decision.resetAtMs,
        );
        return;
      }

      day = await consumeSharedWindow(DAY_KEY, DAY_MS, dailyMax, nowMs);
      rememberWindow("daily", {
        limit: dailyMax,
        remaining: day.decision.remaining,
        resetAtMs: day.decision.resetAtMs,
      });
    } catch (error) {
      if (!shouldFailClosed()) {
        console.warn("[ai-budget] budget store unavailable, failing open", error);
        res.setHeader(AI_BUDGET_HEADER, "fail-open");
        next();
        return;
      }

      console.warn("[ai-budget] budget store unavailable, failing closed", error);
      if (!shouldDegradeOnDailyExhaustion()) {
        rejectWithBudgetUnavailable(res, 60);
        return;
      }
      res.setHeader(AI_BUDGET_HEADER, "degraded");
      res.locals.aiBudgetExhausted = true;
      next();
      return;
    }

    if (day.decision.allowed) {
      res.setHeader(AI_BUDGET_HEADER, "ok");
      next();
      return;
    }

    if (!shouldDegradeOnDailyExhaustion()) {
      rejectWithBudgetExhausted(
        res,
        "daily",
        day.decision.retryAfterSeconds,
        day.decision.resetAtMs,
      );
      return;
    }

    // Degrading here rather than at the provider saves a round trip that can
    // only come back 429, and lets the route answer with the same simulated
    // output it already produces for an exhausted provider budget.
    res.setHeader(AI_BUDGET_HEADER, "degraded");
    res.locals.aiBudgetExhausted = true;
    next();
  };
}

export const aiGlobalBudgetLimit: RequestHandler = createAiGlobalBudgetLimit();

export interface AiBudgetSnapshot {
  enabled: boolean;
  dailyLimit: number;
  dailyRemaining: number;
  minuteLimit: number;
  minuteRemaining: number;
  degraded: boolean;
  resetAt: string | null;
  /** Live numbers from the provider, or null when unavailable. */
  upstream: { dailyLimit: number | null; dailyRemaining: number | null } | null;
}

/**
 * Describe the budget without consuming it. Local counters come from the last
 * decision this process saw; the upstream numbers are best-effort and cached,
 * because polling the provider per request would itself spend the rate limit.
 */
export async function getAiBudgetSnapshot(): Promise<AiBudgetSnapshot> {
  const dailyLimit = getGlobalDailyMax();
  const minuteLimit = getGlobalMinuteMax();
  const nowMs = Date.now();
  const day = readWindow("daily", nowMs);
  const minute = readWindow("minute", nowMs);
  const enabled = isAiGlobalBudgetEnabled();

  // Gated on the provider, not on `enabled`: AI_GLOBAL_BUDGET_ENABLED=true is
  // supported on Azure and Vertex, and a deployment that still carries an
  // OpenRouter key from an earlier experiment would otherwise have the banner
  // report an unrelated account's quota.
  const upstream =
    enabled && getConfiguredProvider() === "openrouter"
      ? await fetchOpenRouterKeyStatus()
      : null;
  const dailyRemaining = day?.remaining ?? dailyLimit;

  return {
    enabled,
    dailyLimit,
    dailyRemaining,
    minuteLimit,
    minuteRemaining: minute?.remaining ?? minuteLimit,
    degraded: enabled && dailyRemaining <= 0,
    resetAt: day ? new Date(day.resetAtMs).toISOString() : null,
    upstream,
  };
}
