import type { NextFunction, Request, RequestHandler, Response } from "express";
import { getConfiguredProvider } from "./ai-config";
import { fetchOpenRouterKeyStatus } from "./ai-providers/openrouter";
import { consumeSharedWindow } from "./rate-limit";

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_GLOBAL_MINUTE_MAX = 20;
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

/** Set by the middleware when the day budget is spent and the mode is degrade. */
export function isAiBudgetExhausted(res: Response): boolean {
  return res.locals.aiBudgetExhausted === true;
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
 * Global spend budget for the shared AI account, composed before the
 * per-identity limiter.
 *
 * The two windows are consumed in order and the daily one is only charged
 * once the minute one allowed the request: a caller refused on the minute
 * window never reached the provider, so charging the day for it would leak
 * budget that was never spent.
 */
export const aiGlobalBudgetLimit: RequestHandler = async (
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (!isAiGlobalBudgetEnabled()) {
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
      rejectWithBudgetExhausted(res, "daily", 60, nowMs + MINUTE_MS);
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
  const day = lastWindowState.get("daily");
  const minute = lastWindowState.get("minute");
  const enabled = isAiGlobalBudgetEnabled();

  const upstream = enabled ? await fetchOpenRouterKeyStatus() : null;
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
