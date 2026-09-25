import type { Response } from "express";
import {
  getAiReadiness,
  getConfiguredProvider,
  shouldDegradeOnQuotaExhausted,
} from "./ai-config";
import {
  fetchOpenRouterKeyStatus,
  readLastKnownOpenRouterDailyLimit,
} from "./ai-providers/openrouter";
import { consumeSharedWindow, recordSharedWindow, releaseSharedWindow } from "./rate-limit";

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
const DAY_KEY_PREFIX = "global:ai:day";
const AI_BUDGET_HEADER = "x-sresim-ai-budget";

type BudgetScope = "minute" | "daily";

/**
 * The daily cap is a **UTC calendar day**, not a 24-hour sliding window.
 *
 * OpenRouter resets the free-model allowance at midnight UTC, and a sliding
 * window is wrong in both directions against that: a burst at 23:50 keeps the
 * deployment degraded well into the next UTC day, when the provider would
 * already be serving again, and a request at 00:10 is still charged for
 * yesterday's spend that the provider has already forgiven. The enforced
 * figure is local (see `DEFAULT_GLOBAL_DAILY_MAX`), so the least it can do is
 * roll over when the thing it is modelling does.
 *
 * Implemented by the key rather than by the window: one sorted set per UTC
 * date, so the count starts empty at midnight with nothing to prune. The
 * window duration handed to the store stays 24 hours, which is what expires
 * the key -- a day-old set is dropped by Redis's PEXPIRE and by the in-memory
 * sweep, so yesterday's keys do not accumulate. Shortening the window to
 * "time since midnight" would look tidier and would be a bug: early in the
 * day it sets a TTL of seconds, and a quiet minute would silently reset the
 * count.
 */
function dayKeyForUtcDate(nowMs: number): string {
  return `${DAY_KEY_PREFIX}:${new Date(nowMs).toISOString().slice(0, 10)}`;
}

/** Midnight UTC after `nowMs` -- when the provider's own allowance resets. */
function nextUtcMidnightMs(nowMs: number): number {
  const now = new Date(nowMs);
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
}

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
export function isAiGlobalBudgetEnabled(): boolean {
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

/**
 * The configured cap, clamped down to the account's own limit once this
 * process has seen one.
 *
 * `DEFAULT_GLOBAL_DAILY_MAX` is the post-purchase tier, so an account that has
 * not bought credit sits under a 50/day provider cap while the limiter thinks
 * it has 1000 -- the deployment then spends 950 requests learning about 429s
 * it could have predicted. The documented remedy is to set
 * `AI_GLOBAL_DAILY_MAX=50`, which every deployment on an un-credited account
 * has to remember; this makes the common case need no configuration at all.
 *
 * Two properties keep the docblock above honest. It only ever **tightens**:
 * `Math.min` cannot raise a cap past what the operator configured, so a wrong
 * or stale upstream reading can overspend nothing. And it reaches no network
 * -- `readLastKnownOpenRouterDailyLimit` is a cache read, returning `null`
 * until some other caller has already fetched -- so the enforced figure stays
 * local and the limiter still fails closed on its own.
 */
function getGlobalDailyMax(): number {
  const configured = parsePositiveInt(process.env.AI_GLOBAL_DAILY_MAX, DEFAULT_GLOBAL_DAILY_MAX);
  const upstreamLimit = readLastKnownOpenRouterDailyLimit();
  if (upstreamLimit === null || getConfiguredProvider() !== "openrouter") {
    return configured;
  }
  return Math.min(configured, upstreamLimit);
}

/** `degrade` answers with simulated output; `reject` answers 429. */
function shouldDegradeOnDailyExhaustion(): boolean {
  return (process.env.AI_GLOBAL_DAILY_EXHAUSTED_MODE ?? "degrade")
    .trim()
    .toLowerCase() !== "reject";
}

/**
 * What an exhausted budget actually answers with, so the banner can say it
 * rather than assume it.
 *
 * `simulated` requires *both* switches to degrade. The snapshot cannot tell
 * which exhaustion the reader is about to hit -- the local counter answers
 * under `AI_GLOBAL_DAILY_EXHAUSTED_MODE`, a provider 429 under
 * `AI_DEGRADE_ON_QUOTA_EXHAUSTED` -- so promising a playable answer while
 * either path returns 429 is the same confidently-wrong sentence the upstream
 * pairing rule already refuses to render.
 */
function getExhaustedBehaviour(): AiExhaustedBehaviour {
  return shouldDegradeOnDailyExhaustion() && shouldDegradeOnQuotaExhausted()
    ? "simulated"
    : "rejected";
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

/**
 * What the caller must do next.
 *
 * - `ok`         the request is charged and may call the provider.
 * - `exhausted`  the day budget is spent (or unverifiable while failing
 *                closed). Nothing was charged and no response was written:
 *                answer the way this route already answers a provider quota
 *                exhaustion. Deliberately *not* named `degraded` -- whether
 *                the answer degrades is `AI_DEGRADE_ON_QUOTA_EXHAUSTED`, and
 *                the routes disagree about what it means. Chat and command
 *                turn it off into a 429; scenario relabels its catalog
 *                fallback `throttled` and still returns a playable session.
 *                Deciding that here would have quietly made scenario 429.
 * - `answered`   a response has already been written (429 or 503). Return.
 */
export type AiBudgetOutcome = "ok" | "exhausted" | "answered";

/**
 * A store outage is not an exhausted account, and saying so misleads exactly
 * the reader who needs the truth: the operator reading logs during an
 * incident, and a client told to come back tomorrow for a Redis blip. The
 * budget is untouched here -- nothing was observed, let alone spent.
 */
/**
 * How long a client should wait out a budget-store outage.
 *
 * A minute, not the daily reset: nothing was observed and nothing was spent,
 * so the account may well be answerable again long before midnight. Exported
 * so the live probe's own 503 quotes the same interval as the middleware's --
 * they describe one outage and a monitor should not get two answers.
 */
export const AI_BUDGET_UNAVAILABLE_RETRY_AFTER_SECONDS = 60;

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
 * The same structured refusal, for the routes that decline to degrade.
 *
 * `chargeAiBudget` answers a spent day by returning `exhausted` and leaving
 * the response to the caller, because most callers degrade. The two that
 * refuse instead -- chat and command under
 * `AI_DEGRADE_ON_QUOTA_EXHAUSTED=false` -- were each writing their own bare
 * `{ error }` body, which drops everything a client can act on: no
 * `Retry-After`, no `code` to branch on, no `resetAt`. A 429 from a spent
 * shared day then reads exactly like a 429 from the per-identity limiter,
 * where the advice is "retry in a moment" rather than "tomorrow", and the
 * `x-sresim-ai-budget` header the frontend watches on streaming responses was
 * not set at all.
 *
 * The reset is derived rather than read from the remembered window: the daily
 * scope *is* the UTC calendar day (see the note above
 * `DEFAULT_GLOBAL_DAILY_MAX`), so midnight UTC is the answer whether or not
 * this process happens to hold window state for it.
 */
export function rejectWithAiDailyBudgetExhausted(res: Response): void {
  const reset = describeAiDailyBudgetReset();
  rejectWithBudgetExhausted(
    res,
    reset.scope,
    reset.retryAfterSeconds,
    reset.resetAtMs,
  );
}

/**
 * When the shared day comes back, in the fields a client can act on.
 *
 * Extracted because two refusals describe the same event in different
 * envelopes and must not disagree about it. `rejectWithAiDailyBudgetExhausted`
 * writes the documented `{ error, code, scope, retryAfterSeconds, resetAt }`
 * body; the live probe answers in its own `{ ok, mode, reason, code }` shape,
 * which its success and 503 siblings already use and an operator's monitor
 * already parses, so it cannot adopt that body -- but it needs the same three
 * fields and the same `Retry-After`. Deriving the reset twice is how they
 * would drift.
 *
 * The derivation is `nextUtcMidnightMs` rather than a remembered window,
 * because the daily scope *is* the UTC calendar day (see the note above
 * `DEFAULT_GLOBAL_DAILY_MAX`) -- so the answer is the same whether or not the
 * refusing process holds window state for it.
 */
export function describeAiDailyBudgetReset(nowMs: number = Date.now()): {
  scope: "daily";
  retryAfterSeconds: number;
  resetAt: string;
  resetAtMs: number;
} {
  const resetAtMs = nextUtcMidnightMs(nowMs);
  return {
    scope: "daily",
    retryAfterSeconds: Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000)),
    resetAt: new Date(resetAtMs).toISOString(),
    resetAtMs,
  };
}

/**
 * Did the budget fail to *observe* the account, rather than find it spent?
 *
 * `chargeAiBudget` returns `exhausted` for both, deliberately: the three
 * gameplay routes answer them the same way -- a simulated answer, because that
 * is the only thing a player can use -- and collapsing them there keeps the
 * degraded-answer contract to one case. The cause is still recorded, in the
 * header, which is also where `markAiBudgetDegraded` reads it.
 *
 * The live probe is the one caller that must tell them apart. It has no
 * simulated answer to give -- "pong" from the mock generator asserts nothing
 * about the provider, which is the single thing the endpoint exists to check
 * -- so it refuses either way, and a refusal has to name its reason. Telling
 * an operator the day is spent when a Redis blip is the truth sends them away
 * until tomorrow over an outage that may already be over.
 */
export function isAiBudgetStoreUnavailable(res: Response): boolean {
  return res.getHeader(AI_BUDGET_HEADER) === "store-unavailable";
}

/**
 * Record that the route answered this request with simulated output.
 *
 * `chargeAiBudget` sets the *cause* -- what the budget observed -- and cannot
 * set the *outcome*, because the outcome is the route's decision and the three
 * routes disagree: with `AI_DEGRADE_ON_QUOTA_EXHAUSTED=false`, chat and command
 * answer a spent budget with a 429 while scenario still returns a playable
 * catalog session. So the route says so once it has chosen, and a streaming
 * client reading only headers can tell a refusal from a simulated answer.
 *
 * It refuses to overwrite `store-unavailable`: that value is the one signal an
 * operator has that the window store, not the account, is what degraded the
 * deployment, and the response is equally simulated either way.
 */
export function markAiBudgetDegraded(res: Response): void {
  if (res.getHeader(AI_BUDGET_HEADER) !== "daily-exhausted") {
    return;
  }
  res.setHeader(AI_BUDGET_HEADER, "degraded");
}

/**
 * Charge the shared AI account for one provider call.
 *
 * **Called by the route, immediately before the provider call -- not as
 * middleware.** It was middleware, and that was wrong in a way worth writing
 * down: Express runs middleware before the handler validates anything, so a
 * request with an expired session, a malformed payload, or one that goes on
 * to return the readiness 503 still burned a daily slot. The day budget is
 * the scarce shared resource (50 requests on an un-credited account), so a
 * caller could drain it without a single request reaching OpenRouter, and
 * every real player would be pushed onto simulated answers by traffic the
 * provider never saw. Three of the four call sites -- chat, command and
 * scenario -- are the points those routes had already chosen as their
 * provider boundary. The fourth is `/api/ai/probe?live=true`, which reaches
 * `generateAiText` directly rather than through a gameplay route and so had
 * no such boundary to reuse; its charge sits below the branches that answer
 * from configuration alone, for the same reason.
 *
 * The two windows are consumed in order and the daily one is only charged
 * once the minute one allowed the request: a caller refused on the minute
 * window never reached the provider, so charging the day for it would leak
 * budget that was never spent.
 *
 * The same rule running the other way is `releaseChargedMinute`: once the day
 * refuses, the minute slot already taken is handed back, because that request
 * reaches no provider either.
 *
 * The same rule covers the routes that can answer without a provider at all.
 * `AI_MOCK_MODE` and `SCENARIO_SOURCE=catalog` both return from their routes
 * above every call site here, so neither can charge -- structurally, rather
 * than through a predicate the caller has to remember to pass. That matters
 * for the free-e2e gate, which drives four simulated players through chat and
 * command with mock AI.
 */
/**
 * Give back the minute slot a request took on its way to being refused.
 *
 * The minute window is charged before the day window, so every path that
 * refuses below that point is holding a slot for a request that reaches no
 * provider: a day consume that throws, a spent day answered with a 429, and a
 * spent day answered with simulated output. The last one is the expensive
 * case -- it is every request for the rest of the day -- and it is also the
 * one that makes the minute window lie across the UTC reset, because a caller
 * arriving just after midnight can be refused on a window filled entirely by
 * requests that never left this process.
 *
 * Deliberately swallows its own failure: on the outage path the caller is
 * already refusing the request because the store is unreachable, so a release
 * that fails for the same reason must not mask the original error. When it
 * fails the entry ages out of its own window anyway, which is what happens
 * today.
 *
 * Rejected alternatives, both of which would be worse than best-effort here:
 * an atomic two-key Lua script breaks Redis Cluster with CROSSSLOT, because
 * these keys carry no hash tags; and merging both windows into one sorted set
 * regresses the minute guard across the UTC midnight boundary, since the day
 * key is calendar-scoped while the minute window rolls.
 */
async function releaseChargedMinute(
  minute: Awaited<ReturnType<typeof consumeSharedWindow>> | undefined,
  minuteMax: number,
): Promise<void> {
  const releaseToken = minute?.decision.releaseToken;
  if (!minute?.decision.allowed || !releaseToken) {
    return;
  }

  try {
    await releaseSharedWindow(MINUTE_KEY, releaseToken);
  } catch (releaseError) {
    console.warn("[ai-budget] could not release the charged minute slot", releaseError);
    return;
  }

  // The window state was remembered before the release, and `/api/ai/budget`
  // reports that map rather than reading the store, so leaving it would show
  // the banner one slot fewer than the window actually holds. Only after a
  // release that happened: when it failed, the pessimistic figure is the true
  // one.
  rememberWindow("minute", {
    limit: minuteMax,
    remaining: Math.min(minuteMax, minute.decision.remaining + 1),
    resetAtMs: minute.decision.resetAtMs,
  });
}

export async function chargeAiBudget(res: Response): Promise<AiBudgetOutcome> {
  if (!isAiGlobalBudgetEnabled()) {
    return "ok";
  }

  const minuteMax = getGlobalMinuteMax();
  const dailyMax = getGlobalDailyMax();
  const nowMs = Date.now();
  const dayResetAtMs = nextUtcMidnightMs(nowMs);

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
      return "answered";
    }

    day = await consumeSharedWindow(dayKeyForUtcDate(nowMs), DAY_MS, dailyMax, nowMs);
    // The store's own `resetAtMs` is oldest-entry + 24h, which is the sliding
    // window this key deliberately is not. Everything the caller is told about
    // the daily scope -- Retry-After, `resetAt`, the banner -- comes from the
    // calendar instead.
    rememberWindow("daily", {
      limit: dailyMax,
      remaining: day.decision.remaining,
      resetAtMs: dayResetAtMs,
    });
  } catch (error) {
    // The minute slot is charged before the day is, so a day consume that
    // throws leaves a request that never reached a provider holding a minute
    // slot until the window rolls. Hand it back before answering.
    await releaseChargedMinute(minute, minuteMax);

    if (!shouldFailClosed()) {
      console.warn("[ai-budget] budget store unavailable, failing open", error);
      res.setHeader(AI_BUDGET_HEADER, "fail-open");
      return "ok";
    }

    console.warn("[ai-budget] budget store unavailable, failing closed", error);
    if (!shouldDegradeOnDailyExhaustion()) {
      rejectWithBudgetUnavailable(res, AI_BUDGET_UNAVAILABLE_RETRY_AFTER_SECONDS);
      return "answered";
    }
    // The header says `store-unavailable`, not `daily-exhausted`: nothing was
    // observed here, let alone spent, and an operator reading these during an
    // incident needs the outage to be distinguishable from a real cap. The
    // route's own body will still say `quota_exhausted`, because that is the
    // only vocabulary the degraded-answer contract has and it is the one the
    // client can act on -- the cause lives in this header and the log line.
    res.setHeader(AI_BUDGET_HEADER, "store-unavailable");
    return "exhausted";
  }

  if (day.decision.allowed) {
    res.setHeader(AI_BUDGET_HEADER, "ok");
    return "ok";
  }

  // The day is spent, so this request reaches no provider whichever way the
  // route answers it -- the 429 below, or the simulated output the degraded
  // path produces. It charged a minute slot on the way in; hand that back, on
  // the same rule that stops a request refused on the minute window charging
  // the day.
  await releaseChargedMinute(minute, minuteMax);

  if (!shouldDegradeOnDailyExhaustion()) {
    rejectWithBudgetExhausted(
      res,
      "daily",
      Math.max(1, Math.ceil((dayResetAtMs - nowMs) / 1000)),
      dayResetAtMs,
    );
    return "answered";
  }

  // Handing back here rather than at the provider saves a round trip that can
  // only come back 429. The header states what was observed -- the day is
  // spent -- rather than predicting how the route will answer, which is the
  // route's decision and not the same one everywhere. The route that does
  // answer with simulated output calls `markAiBudgetDegraded` and overwrites
  // it, so no client is told `degraded` before the answer exists.
  res.setHeader(AI_BUDGET_HEADER, "daily-exhausted");
  return "exhausted";
}

/**
 * Charge the shared account for a provider request the route did not pay for.
 *
 * `chargeAiBudget` charges one slot and the route then makes *one* call --
 * but a call is not a request. The OpenAI-compatible transport re-sends on a
 * 429 with backoff, re-sends once more when a provider rejects the
 * `max_tokens` spelling, re-sends against the fallback deployment when the
 * route-specific one is missing, and `generateAiText` re-sends the whole
 * thing when the provider spent its completion budget on reasoning and
 * returned no text. Each of those is a second request against an account cap
 * counted in requests, so one charged slot could spend several -- and the
 * limiter exists precisely to keep this deployment under that cap.
 *
 * Deliberately charges *both* windows unconditionally, which is the opposite
 * of the ordering rule `chargeAiBudget` follows. That rule exists because a
 * caller refused on the minute window never reached the provider; here the
 * request is already going out, so both windows have to reflect it or they
 * describe a spend that did not happen the way they say.
 *
 * Which is why this records rather than consumes. `consumeSharedWindow` adds
 * no entry once a window is full, so charging a retry through it would leave
 * exactly the requests that overran the cap unrecorded -- and on the minute
 * window, whose entries expire continuously, that under-count opens the next
 * minute's allowance early and walks the deployment past the provider's real
 * per-minute limit.
 *
 * It never refuses and never throws. The first request of this call was
 * already paid for and is in flight, so declining the retry would abandon a
 * slot already spent and hand the caller a 500 where the degraded answer is
 * strictly better. What it does instead is record the overspend, which is
 * what makes the *next* caller get refused on time. A store outage is logged
 * and swallowed for the same reason -- failing closed here would convert a
 * Redis blip into a lost answer rather than into a refusal.
 */
export async function chargeAiProviderRetry(): Promise<void> {
  if (!isAiGlobalBudgetEnabled()) {
    return;
  }

  const nowMs = Date.now();
  const minuteMax = getGlobalMinuteMax();
  const dailyMax = getGlobalDailyMax();

  try {
    const minute = await recordSharedWindow(MINUTE_KEY, MINUTE_MS, minuteMax, nowMs);
    rememberWindow("minute", {
      limit: minuteMax,
      remaining: minute.record.remaining,
      resetAtMs: minute.record.resetAtMs,
    });

    const day = await recordSharedWindow(dayKeyForUtcDate(nowMs), DAY_MS, dailyMax, nowMs);
    rememberWindow("daily", {
      limit: dailyMax,
      remaining: day.record.remaining,
      resetAtMs: nextUtcMidnightMs(nowMs),
    });
  } catch (error) {
    console.warn("[ai-budget] could not charge a provider retry", error);
  }
}

/** Whether a spent budget still answers playably, or answers 429. */
export type AiExhaustedBehaviour = "simulated" | "rejected";

export interface AiBudgetSnapshot {
  enabled: boolean;
  dailyLimit: number;
  dailyRemaining: number;
  minuteLimit: number;
  minuteRemaining: number;
  degraded: boolean;
  /** What this deployment answers with once the budget is spent. */
  exhaustedBehaviour: AiExhaustedBehaviour;
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

  // Read after the lookup, not before: the lookup is what fills the cache the
  // clamp reads, so taking the cap first would report the unclamped figure to
  // whichever visitor happened to load the banner first and the clamped one to
  // everybody after them.
  const dailyLimit = getGlobalDailyMax();
  // A window charged before the clamp learned the account's limit can hold
  // more slots than the cap now allows; reporting `dailyRemaining` above
  // `dailyLimit` would make the documented response contradict itself until
  // the next charge re-counted against the tighter figure.
  const dailyRemaining = Math.min(day?.remaining ?? dailyLimit, dailyLimit);

  // The banner prefers the provider's own pair over the local counter and
  // renders both numbers or neither, so an account the provider reports spent
  // reads as exhausted on screen whether or not this process has charged a
  // local slot yet. Without a local window there was no `resetAt`, which left
  // that copy with no recovery time on precisely the deployment that has one:
  // the daily scope is a UTC calendar day, so the answer is the same midnight
  // a local window would have carried.
  const upstreamExhausted =
    typeof upstream?.dailyLimit === "number" &&
    typeof upstream?.dailyRemaining === "number" &&
    upstream.dailyRemaining <= 0;
  const resetAtMs = day?.resetAtMs ?? (upstreamExhausted ? nextUtcMidnightMs(nowMs) : null);

  return {
    enabled,
    dailyLimit,
    dailyRemaining,
    minuteLimit,
    minuteRemaining: minute?.remaining ?? minuteLimit,
    // Both sources count, because either one alone can make the deployment
    // degraded: this process stops reaching the provider once the local
    // counter is spent, and the provider stops answering once the account is.
    // Reporting the account-wide exhaustion as `degraded: false` while
    // `upstream.dailyRemaining: 0` sits in the same response made the
    // documented endpoint contradict itself, and left the banner's own
    // fallback as the only consumer that noticed. The upstream half keeps its
    // both-fields gate, so a partial reading from the provider degrades
    // nothing.
    degraded: enabled && (dailyRemaining <= 0 || upstreamExhausted),
    exhaustedBehaviour: getExhaustedBehaviour(),
    resetAt: resetAtMs === null ? null : new Date(resetAtMs).toISOString(),
    upstream,
  };
}
