import { createHash } from "node:crypto";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { createClient, type RedisClientType } from "redis";
import { VIEWER_SESSION_COOKIE } from "../../../shared/auth/constants";
import { verifySignedClientIp } from "../../../shared/auth/client-ip";
import { getSessionStore, type GameSession } from "./storage";
import { readAnonymousProofFromCookieHeader, readViewerFromCookieHeader } from "./viewer-auth";

interface RateLimitRequestLike {
  ip?: string;
  socket?: {
    remoteAddress?: string;
  };
  headers: Record<string, string | string[] | undefined>;
  originalUrl?: string;
  body?: unknown;
}

interface CachedSessionLookup {
  token: string;
  session: GameSession | null;
}

export interface SlidingWindowDecision {
  allowed: boolean;
  remaining: number;
  resetAtMs: number;
  retryAfterSeconds: number;
  /**
   * Identifies the entry this call added, for `release` to hand back. Set only
   * when the slot was granted -- a refusal added nothing to give back.
   */
  releaseToken?: string;
}

/** What a window holds after an entry was added to it. */
export interface SlidingWindowRecord {
  remaining: number;
  resetAtMs: number;
}

interface SlidingWindowStore {
  readonly distributed: boolean;
  consume(
    key: string,
    nowMs: number,
    windowMs: number,
    limit: number,
  ): Promise<SlidingWindowDecision>;
  /**
   * Add an entry to the window and report what it now holds, without ever
   * refusing. `consume` adds nothing once the window is full, which is right
   * for a caller asking permission and wrong for one reporting a request that
   * is already in flight: the entry the refusal declined to write is exactly
   * the one that would have kept the window accurate.
   *
   * `remaining` floors at zero and `resetAtMs` is the oldest entry's expiry,
   * so an over-capacity window answers the same shape as an empty one.
   */
  record(
    key: string,
    nowMs: number,
    windowMs: number,
    limit: number,
  ): Promise<SlidingWindowRecord>;
  /**
   * Best-effort compensation for a multi-window charge that failed partway.
   * Not a general refund: the only caller is a failure path that has already
   * decided to refuse the request, so a release that itself fails must leave
   * the caller no worse off than doing nothing.
   */
  release(key: string, releaseToken: string): Promise<void>;
}

const DEFAULT_AI_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const DEFAULT_AI_RATE_LIMIT_MAX = 15;
const DEFAULT_GAMEPLAY_TELEMETRY_RATE_LIMIT_MAX = 60;
/**
 * The budget read is a public GET with no per-visitor identity to key on, so
 * this is a front-door flood guard for a whole deployment rather than a
 * per-player allowance -- see `aiBudgetReadRateLimit`.
 */
const DEFAULT_AI_BUDGET_READ_RATE_LIMIT_MAX = 120;
/**
 * Deliberately small. The live probe is an operator check run by hand or by a
 * monitor every few minutes, not a player action -- see `aiLiveProbeRateLimit`.
 */
const DEFAULT_AI_LIVE_PROBE_RATE_LIMIT_MAX = 5;
const MIN_RATE_LIMIT_WINDOW_SECONDS = 1;
const REDIS_KEY_PREFIX = "sresim:rate-limit";
const RATE_LIMIT_STATUS_HEADER = "x-sresim-rate-limit-status";
const IN_MEMORY_SWEEP_INTERVAL = 256;
const REDIS_MEMBER_PREFIX = `${process.pid.toString(36)}-${Date.now().toString(36)}`;
const REDIS_SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
local cutoff = now - windowMs

redis.call("ZREMRANGEBYSCORE", key, "-inf", cutoff)

local current = redis.call("ZCARD", key)
if current >= limit then
  local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
  local resetAt = now + windowMs
  if oldest[2] then
    resetAt = tonumber(oldest[2]) + windowMs
  end
  return {0, current, resetAt}
end

redis.call("ZADD", key, now, member)
redis.call("PEXPIRE", key, windowMs)

local count = redis.call("ZCARD", key)
return {1, count, now + windowMs}
`;
/**
 * The unconditional sibling of the script above: no capacity branch, so the
 * entry always lands. The reset comes from the oldest surviving member rather
 * than from `now`, because over capacity the window drains from its front.
 */
const REDIS_RECORD_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local member = ARGV[4]
local cutoff = now - windowMs

redis.call("ZREMRANGEBYSCORE", key, "-inf", cutoff)
redis.call("ZADD", key, now, member)
redis.call("PEXPIRE", key, windowMs)

local count = redis.call("ZCARD", key)
local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
local resetAt = now + windowMs
if oldest[2] then
  resetAt = tonumber(oldest[2]) + windowMs
end
return {1, count, resetAt}
`;

function readPositiveLimitFromEnv(
  rawValue: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

interface CachedLimitValue {
  raw: string | undefined;
  parsed: number;
  initialized: boolean;
}

function readCachedPositiveLimit(
  cache: CachedLimitValue,
  rawValue: string | undefined,
  fallback: number,
): number {
  if (cache.initialized && cache.raw === rawValue) {
    return cache.parsed;
  }

  cache.raw = rawValue;
  cache.parsed = readPositiveLimitFromEnv(rawValue, fallback);
  cache.initialized = true;
  return cache.parsed;
}

const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const RATE_LIMIT_SESSION_LOOKUP = Symbol("rate-limit-session-lookup");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function shouldTreatReqIpAsTrustedFallback(): boolean {
  return process.env.TRUST_PROXY_HEADERS !== "true";
}

function hasCookie(cookieHeader: string, name: string): boolean {
  return cookieHeader
    .split(";")
    .some((value) => value.trim().startsWith(`${name}=`));
}

function supportsSessionTokenIdentity(originalUrl: string | undefined): boolean {
  const pathname = originalUrl?.split("?", 1)[0] ?? "";
  return pathname === "/api/chat" ||
    pathname === "/api/command" ||
    pathname === "/api/ai" ||
    pathname.startsWith("/api/ai/");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function readCachedSessionLookup(
  req: RateLimitRequestLike,
  token: string,
): GameSession | null | undefined {
  const cached = (req as RateLimitRequestLike & {
    [RATE_LIMIT_SESSION_LOOKUP]?: CachedSessionLookup;
  })[RATE_LIMIT_SESSION_LOOKUP];
  return cached?.token === token ? cached.session : undefined;
}

function writeCachedSessionLookup(
  req: RateLimitRequestLike,
  token: string,
  session: GameSession | null,
): void {
  (req as RateLimitRequestLike & {
    [RATE_LIMIT_SESSION_LOOKUP]?: CachedSessionLookup;
  })[RATE_LIMIT_SESSION_LOOKUP] = { token, session };
}

async function getStoredSession(
  req: RateLimitRequestLike,
  token: string,
): Promise<GameSession | null> {
  const cachedSession = readCachedSessionLookup(req, token);
  if (cachedSession !== undefined) {
    return cachedSession;
  }

  const session = await getSessionStore().get(token);
  writeCachedSessionLookup(req, token, session);
  return session;
}

export async function getRequestSession(
  req: Request | RateLimitRequestLike,
  sessionToken: string,
): Promise<GameSession | null> {
  const trimmed = sessionToken.trim();
  if (trimmed === "") {
    return null;
  }

  return getStoredSession(req, trimmed);
}

async function getSessionTokenIdentity(req: RateLimitRequestLike): Promise<string | null> {
  if (!supportsSessionTokenIdentity(req.originalUrl)) {
    return null;
  }

  if (!isRecord(req.body)) {
    return null;
  }

  const sessionToken = req.body.sessionToken;
  if (typeof sessionToken !== "string" || sessionToken.trim() === "") {
    return null;
  }

  const trimmed = sessionToken.trim();
  if (!UUID_RE.test(trimmed)) {
    return null;
  }

  try {
    const session = await getStoredSession(req, trimmed);
    if (!session || session.used) {
      return null;
    }
  } catch {
    return null;
  }

  return `session:${hashToken(trimmed)}`;
}

let loggedMissingAuthSessionSecret = false;

function getScenarioCookieIdentity(
  req: RateLimitRequestLike,
  antiAbuseSecret: string | undefined,
  authSessionSecret: string | undefined,
): string | null {
  const cookieHeader = readHeader(req.headers.cookie);
  if (!cookieHeader) {
    return null;
  }

  const hasViewerSessionCookie = hasCookie(cookieHeader, VIEWER_SESSION_COOKIE);
  if (hasViewerSessionCookie && !authSessionSecret && !loggedMissingAuthSessionSecret) {
    console.warn(
      "[rate-limit] AUTH_SESSION_SECRET missing; viewer session cookies cannot be used for limiter identity",
    );
    loggedMissingAuthSessionSecret = true;
  }

  if (authSessionSecret) {
    const viewer = readViewerFromCookieHeader(cookieHeader, authSessionSecret);
    if (viewer?.githubUserId) {
      return `viewer:${viewer.githubUserId}`;
    }
  }

  if (!antiAbuseSecret) {
    return null;
  }

  const userAgent = readHeader(req.headers["user-agent"]) ?? "unknown";
  const anonymousProof = readAnonymousProofFromCookieHeader(
    cookieHeader,
    antiAbuseSecret,
    userAgent,
  );

  return anonymousProof?.fingerprintHash
    ? `anonymous:${anonymousProof.fingerprintHash}`
    : null;
}

function getSignedClientIp(
  req: RateLimitRequestLike,
  antiAbuseSecret: string | undefined,
): string | null {
  const signedIp = readHeader(req.headers["x-sresim-client-ip"])?.trim();
  const signature = readHeader(req.headers["x-sresim-client-ip-signature"])?.trim();

  if (
    antiAbuseSecret &&
    signedIp &&
    signature &&
    verifySignedClientIp(signedIp, signature, antiAbuseSecret)
  ) {
    return signedIp;
  }

  return null;
}

function getIpFallbackIdentity(
  req: RateLimitRequestLike,
  antiAbuseSecret: string | undefined,
): string {
  const signedClientIp = getSignedClientIp(req, antiAbuseSecret);
  if (signedClientIp) {
    return `ip:${ipKeyGenerator(signedClientIp)}`;
  }

  if (shouldTreatReqIpAsTrustedFallback()) {
    if (req.ip) {
      return `ip:${ipKeyGenerator(req.ip)}`;
    }
    const socketIp = req.socket?.remoteAddress;
    if (socketIp) {
      return `ip:${ipKeyGenerator(socketIp)}`;
    }
  } else {
    const socketIp = req.socket?.remoteAddress;
    if (socketIp) {
      return `ip:${ipKeyGenerator(socketIp)}`;
    }
  }

  return "unknown";
}

export function getIpRateLimitKey(
  req: RateLimitRequestLike,
  antiAbuseSecret = process.env.ANTI_ABUSE_HMAC_SECRET,
): string {
  return getIpFallbackIdentity(req, antiAbuseSecret);
}

export function getScenarioRateLimitKey(
  req: RateLimitRequestLike,
  antiAbuseSecret = process.env.ANTI_ABUSE_HMAC_SECRET,
  authSessionSecret = process.env.AUTH_SESSION_SECRET,
): string {
  return getScenarioCookieIdentity(req, antiAbuseSecret, authSessionSecret) ??
    getIpFallbackIdentity(req, antiAbuseSecret);
}
export async function getRateLimitKey(
  req: RateLimitRequestLike,
  antiAbuseSecret = process.env.ANTI_ABUSE_HMAC_SECRET,
  authSessionSecret = process.env.AUTH_SESSION_SECRET,
): Promise<string> {
  const sessionIdentity = await getSessionTokenIdentity(req);
  return sessionIdentity ??
    getScenarioCookieIdentity(req, antiAbuseSecret, authSessionSecret) ??
    getIpFallbackIdentity(req, antiAbuseSecret);
}

/**
 * Each entry carries an id of its own, so a release removes the charge it was
 * handed rather than whichever charge happens to share its millisecond. The
 * Redis store has always identified entries this way -- its sorted-set members
 * carry a process prefix and a sequence, and `release` issues `ZREM` on the
 * member it returned -- and matching that here stops the two stores from
 * disagreeing about what a release token means.
 */
interface SlidingWindowEntry {
  id: string;
  timestampMs: number;
}

/**
 * A bucket remembers the window it was written under. The periodic sweep
 * visits every key, and until the global AI budget arrived that was harmless
 * because every key in this store was a per-identity window of the same
 * duration -- one cutoff fitted all of them. The budget puts a 24-hour key
 * and a 60-second key in the same map, so a cutoff borrowed from whichever
 * request happened to trip the sweep would delete the other one's history.
 */
interface SlidingWindowBucket {
  windowMs: number;
  entries: SlidingWindowEntry[];
}

export class InMemorySlidingWindowStore implements SlidingWindowStore {
  readonly distributed = false;
  private readonly buckets = new Map<string, SlidingWindowBucket>();
  private operationsSinceSweep = 0;
  private entrySequence = 0;

  /**
   * Unique for the lifetime of the store, which is all this needs: the
   * in-memory store is per process by construction, so unlike the Redis
   * member there is nothing to disambiguate it from.
   */
  private nextEntryId(nowMs: number): string {
    this.entrySequence += 1;
    return `${nowMs.toString(36)}-${this.entrySequence.toString(36)}`;
  }

  /**
   * Each bucket is pruned against its own window, never the caller's. With a
   * shared cutoff a minute-window request would evict every daily timestamp
   * older than a minute, so the account-wide daily cap would silently reset
   * under ordinary traffic and the limiter would allow an unbounded number of
   * provider calls per day -- the exact failure the budget exists to prevent,
   * reintroduced one layer down.
   */
  private pruneExpiredBuckets(nowMs: number): void {
    for (const [bucketKey, bucket] of this.buckets.entries()) {
      const activeEntries = bucket.entries
        .filter((entry) => entry.timestampMs > nowMs - bucket.windowMs);
      if (activeEntries.length === 0) {
        this.buckets.delete(bucketKey);
        continue;
      }
      this.buckets.set(bucketKey, { windowMs: bucket.windowMs, entries: activeEntries });
    }
  }

  private readActiveBucket(key: string, cutoff: number): SlidingWindowEntry[] {
    const activeEntries = (this.buckets.get(key)?.entries ?? [])
      .filter((entry) => entry.timestampMs > cutoff);
    if (activeEntries.length === 0) {
      this.buckets.delete(key);
      return [];
    }
    return activeEntries;
  }

  async consume(
    key: string,
    nowMs: number,
    windowMs: number,
    limit: number,
  ): Promise<SlidingWindowDecision> {
    const cutoff = nowMs - windowMs;
    this.operationsSinceSweep += 1;
    if (this.operationsSinceSweep >= IN_MEMORY_SWEEP_INTERVAL) {
      this.pruneExpiredBuckets(nowMs);
      this.operationsSinceSweep = 0;
    }

    const existing = this.readActiveBucket(key, cutoff);

    if (existing.length >= limit) {
      const resetAtMs = (existing[0]?.timestampMs ?? nowMs) + windowMs;
      this.buckets.set(key, { windowMs, entries: existing });
      return {
        allowed: false,
        remaining: 0,
        resetAtMs,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000)),
      };
    }

    const entry: SlidingWindowEntry = { id: this.nextEntryId(nowMs), timestampMs: nowMs };
    existing.push(entry);
    this.buckets.set(key, { windowMs, entries: existing });

    return {
      allowed: true,
      remaining: Math.max(limit - existing.length, 0),
      resetAtMs: nowMs + windowMs,
      retryAfterSeconds: Math.max(1, Math.ceil(windowMs / 1000)),
      releaseToken: entry.id,
    };
  }

  async record(
    key: string,
    nowMs: number,
    windowMs: number,
    limit: number,
  ): Promise<SlidingWindowRecord> {
    const cutoff = nowMs - windowMs;
    this.operationsSinceSweep += 1;
    if (this.operationsSinceSweep >= IN_MEMORY_SWEEP_INTERVAL) {
      this.pruneExpiredBuckets(nowMs);
      this.operationsSinceSweep = 0;
    }

    const entries = this.readActiveBucket(key, cutoff);
    entries.push({ id: this.nextEntryId(nowMs), timestampMs: nowMs });
    this.buckets.set(key, { windowMs, entries });

    return {
      remaining: Math.max(limit - entries.length, 0),
      resetAtMs: (entries[0]?.timestampMs ?? nowMs) + windowMs,
    };
  }

  /**
   * The token is the entry's own id, so this removes the charge the caller was
   * granted even when several were granted in the same millisecond. An earlier
   * version released by timestamp and removed the first match, which counted
   * correctly -- one release, one entry gone -- but only because entries
   * sharing a millisecond were interchangeable. That is a property of the
   * representation, not of the contract, and the Redis store never had it.
   */
  async release(key: string, releaseToken: string): Promise<void> {
    const bucket = this.buckets.get(key);
    if (!bucket) {
      return;
    }

    const index = bucket.entries.findIndex((entry) => entry.id === releaseToken);
    if (index < 0) {
      return;
    }

    const entries = bucket.entries.slice();
    entries.splice(index, 1);
    if (entries.length === 0) {
      this.buckets.delete(key);
      return;
    }
    this.buckets.set(key, { windowMs: bucket.windowMs, entries });
  }
}

class RedisSlidingWindowStore implements SlidingWindowStore {
  readonly distributed = true;
  private client: RedisClientType | null = null;
  private connectPromise: Promise<RedisClientType> | null = null;
  private memberSequence = 0;

  constructor(private readonly url: string) {}

  private getOrCreateClient(): RedisClientType {
    if (this.client) {
      return this.client;
    }

    this.client = createClient({ url: this.url });
    this.client.on("error", (error) => {
      console.warn("[rate-limit] redis client error", error);
    });
    return this.client;
  }

  private async getClient(): Promise<RedisClientType> {
    const client = this.getOrCreateClient();
    if (client.isOpen) {
      return client;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = client.connect()
      .then(() => {
        this.connectPromise = null;
        return client;
      })
      .catch((error) => {
        this.connectPromise = null;
        throw error;
      });

    return this.connectPromise;
  }

  private nextMember(nowMs: number): string {
    this.memberSequence += 1;
    return `${REDIS_MEMBER_PREFIX}:${nowMs}:${this.memberSequence}`;
  }

  private parseResult(
    rawResult: unknown,
    nowMs: number,
    windowMs: number,
    limit: number,
  ): SlidingWindowDecision {
    if (!Array.isArray(rawResult) || rawResult.length < 3) {
      throw new Error("redis sliding-window script returned an invalid payload shape");
    }

    const [allowedValue, countValue, resetAtValue] = rawResult;
    const allowedRaw = Number(allowedValue);
    const count = Number(countValue);
    const resetAtMs = Number(resetAtValue);

    if (
      !Number.isFinite(allowedRaw) ||
      !Number.isFinite(count) ||
      !Number.isFinite(resetAtMs) ||
      (allowedRaw !== 0 && allowedRaw !== 1) ||
      count < 0
    ) {
      throw new Error("redis sliding-window script returned non-numeric decision values");
    }

    const normalizedResetAtMs = resetAtMs > nowMs ? resetAtMs : nowMs + windowMs;
    const allowed = allowedRaw === 1;

    return {
      allowed,
      remaining: allowed ? Math.max(limit - count, 0) : 0,
      resetAtMs: normalizedResetAtMs,
      retryAfterSeconds: Math.max(
        MIN_RATE_LIMIT_WINDOW_SECONDS,
        Math.ceil((normalizedResetAtMs - nowMs) / 1000),
      ),
    };
  }

  async consume(
    key: string,
    nowMs: number,
    windowMs: number,
    limit: number,
  ): Promise<SlidingWindowDecision> {
    const client = await this.getClient();
    const redisKey = `${REDIS_KEY_PREFIX}:${key}`;
    const member = this.nextMember(nowMs);
    const result = await client.sendCommand<string[]>([
      "EVAL",
      REDIS_SLIDING_WINDOW_SCRIPT,
      "1",
      redisKey,
      String(nowMs),
      String(windowMs),
      String(limit),
      member,
    ]);
    const decision = this.parseResult(result, nowMs, windowMs, limit);
    return decision.allowed ? { ...decision, releaseToken: member } : decision;
  }

  async record(
    key: string,
    nowMs: number,
    windowMs: number,
    limit: number,
  ): Promise<SlidingWindowRecord> {
    const client = await this.getClient();
    const result = await client.sendCommand<string[]>([
      "EVAL",
      REDIS_RECORD_WINDOW_SCRIPT,
      "1",
      `${REDIS_KEY_PREFIX}:${key}`,
      String(nowMs),
      String(windowMs),
      String(limit),
      this.nextMember(nowMs),
    ]);
    // The script never refuses, so the shared parser's allowed branch is the
    // only one reachable and its `remaining` is the count this needs.
    const decision = this.parseResult(result, nowMs, windowMs, limit);
    return { remaining: decision.remaining, resetAtMs: decision.resetAtMs };
  }

  /**
   * Members are unique per process and per call, so this removes the one entry
   * this process added and nothing else. The key keeps its PEXPIRE from the
   * consume that created it -- a release is never the last word on a window.
   */
  async release(key: string, releaseToken: string): Promise<void> {
    const client = await this.getClient();
    await client.sendCommand(["ZREM", `${REDIS_KEY_PREFIX}:${key}`, releaseToken]);
  }
}

let inMemoryStore: InMemorySlidingWindowStore | null = null;
let redisStore: RedisSlidingWindowStore | null = null;
let loggedRedisFailOpen = false;
const cachedAiRateLimitWindowMs: CachedLimitValue = {
  raw: undefined,
  parsed: DEFAULT_AI_RATE_LIMIT_WINDOW_MS,
  initialized: false,
};
const cachedAiRateLimitMax: CachedLimitValue = {
  raw: undefined,
  parsed: DEFAULT_AI_RATE_LIMIT_MAX,
  initialized: false,
};
const cachedGameplayTelemetryRateLimitMax: CachedLimitValue = {
  raw: undefined,
  parsed: DEFAULT_GAMEPLAY_TELEMETRY_RATE_LIMIT_MAX,
  initialized: false,
};
const cachedAiBudgetReadRateLimitMax: CachedLimitValue = {
  raw: undefined,
  parsed: DEFAULT_AI_BUDGET_READ_RATE_LIMIT_MAX,
  initialized: false,
};
const cachedAiLiveProbeRateLimitMax: CachedLimitValue = {
  raw: undefined,
  parsed: DEFAULT_AI_LIVE_PROBE_RATE_LIMIT_MAX,
  initialized: false,
};

function getInMemoryStore(): InMemorySlidingWindowStore {
  inMemoryStore ??= new InMemorySlidingWindowStore();
  return inMemoryStore;
}

function getSlidingWindowStore(): SlidingWindowStore {
  const redisUrl = process.env.AI_RATE_LIMIT_REDIS_URL?.trim();
  if (!redisUrl) {
    return getInMemoryStore();
  }

  redisStore ??= new RedisSlidingWindowStore(redisUrl);
  return redisStore;
}

/**
 * Consume one slot of a window against whichever store is configured.
 *
 * Shared with the global AI budget limiter, which needs the same Redis/memory
 * selection and the same sliding-window semantics but the opposite failure
 * posture: a per-identity limiter fails open, a shared spend budget must not.
 * So this deliberately neither catches nor reports -- the caller decides what
 * an unavailable store means.
 */
export async function consumeSharedWindow(
  key: string,
  windowMs: number,
  limit: number,
  nowMs: number = Date.now(),
): Promise<{ decision: SlidingWindowDecision; distributed: boolean }> {
  const store = getSlidingWindowStore();
  const decision = await store.consume(key, nowMs, windowMs, limit);
  return { decision, distributed: store.distributed };
}

/**
 * Hand back a slot taken by `consumeSharedWindow`.
 *
 * Only for the caller that charges two windows in sequence and has to refuse
 * the request after the first one was already spent. It is best-effort by
 * design: if the store is unreachable the release fails too, and the entry
 * simply ages out of its window -- the same outcome as not trying. So this
 * cannot make the failure path worse than it is today, and when the store is
 * merely intermittent it stops a refused request from leaking a slot.
 */
/**
 * Add one entry to a window without asking whether there was room.
 *
 * For a caller reporting a provider request that is already on the wire: it
 * cannot be refused, so `consumeSharedWindow` would answer a question nobody
 * asked and, once the window is full, would answer it by recording nothing --
 * leaving the very requests that overran the cap invisible to the window that
 * exists to catch them. Like `consumeSharedWindow` this neither catches nor
 * reports; the caller decides what an unavailable store means.
 */
export async function recordSharedWindow(
  key: string,
  windowMs: number,
  limit: number,
  nowMs: number = Date.now(),
): Promise<{ record: SlidingWindowRecord; distributed: boolean }> {
  const store = getSlidingWindowStore();
  const record = await store.record(key, nowMs, windowMs, limit);
  return { record, distributed: store.distributed };
}

export async function releaseSharedWindow(key: string, releaseToken: string): Promise<void> {
  const store = getSlidingWindowStore();
  await store.release(key, releaseToken);
}

function getAiRateLimitWindowMs(): number {
  return readCachedPositiveLimit(
    cachedAiRateLimitWindowMs,
    process.env.AI_RATE_LIMIT_WINDOW_MS,
    DEFAULT_AI_RATE_LIMIT_WINDOW_MS,
  );
}

function getAiRateLimitMax(): number {
  return readCachedPositiveLimit(
    cachedAiRateLimitMax,
    process.env.AI_RATE_LIMIT_MAX,
    DEFAULT_AI_RATE_LIMIT_MAX,
  );
}

function getAiBudgetReadRateLimitMax(): number {
  return readCachedPositiveLimit(
    cachedAiBudgetReadRateLimitMax,
    process.env.AI_BUDGET_READ_RATE_LIMIT_MAX,
    DEFAULT_AI_BUDGET_READ_RATE_LIMIT_MAX,
  );
}

function getAiLiveProbeRateLimitMax(): number {
  return readCachedPositiveLimit(
    cachedAiLiveProbeRateLimitMax,
    process.env.AI_LIVE_PROBE_RATE_LIMIT_MAX,
    DEFAULT_AI_LIVE_PROBE_RATE_LIMIT_MAX,
  );
}

function applyRateLimitHeaders(
  res: Response,
  limit: number,
  windowMs: number,
  remaining: number,
  resetAtMs: number,
): void {
  const windowSeconds = Math.max(
    MIN_RATE_LIMIT_WINDOW_SECONDS,
    Math.ceil(windowMs / 1000),
  );
  res.setHeader("RateLimit-Limit", String(limit));
  res.setHeader("RateLimit-Policy", `${limit};w=${windowSeconds}`);
  res.setHeader("RateLimit-Remaining", String(Math.max(remaining, 0)));
  res.setHeader(
    "RateLimit-Reset",
    String(Math.max(Math.ceil((resetAtMs - Date.now()) / 1000), 0)),
  );
}

function createSlidingWindowRateLimit(options: {
  max: () => number;
  windowMs: () => number;
  message: { error: string };
  /**
   * Namespaces this limiter's buckets. The store is keyed by the identity
   * string alone, so two limiters that resolve the same identity share one
   * bucket of timestamps and then read it against different caps -- a budget
   * read would spend a player's gameplay allowance, and a player at their cap
   * would lose the banner explaining why. Omitted, the bucket stays exactly
   * where it was, which is what keeps `aiRateLimit` unchanged.
   */
  keyPrefix?: string;
}): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const limit = options.max();
    const windowMs = options.windowMs();
    const identity = await getRateLimitKey(req);
    const key = options.keyPrefix ? `${options.keyPrefix}:${identity}` : identity;
    const nowMs = Date.now();

    try {
      const store = getSlidingWindowStore();
      let decision: SlidingWindowDecision;

      try {
        decision = await store.consume(key, nowMs, windowMs, limit);
      } catch (error) {
        if (store.distributed) {
          if (!loggedRedisFailOpen) {
            console.warn(
              "[rate-limit] redis unavailable, failing open for AI rate limiting",
              error,
            );
            loggedRedisFailOpen = true;
          }
          // When distributed enforcement is configured but Redis is unavailable,
          // fail open explicitly rather than silently degrading to per-process
          // local throttling that would misrepresent the actual protection level.
          res.setHeader(RATE_LIMIT_STATUS_HEADER, "fail-open");
          next();
          return;
        }
        throw error;
      }

      if (loggedRedisFailOpen) {
        loggedRedisFailOpen = false;
      }

      applyRateLimitHeaders(
        res,
        limit,
        windowMs,
        decision.remaining,
        decision.resetAtMs,
      );

      if (!decision.allowed) {
        res.setHeader("Retry-After", String(decision.retryAfterSeconds));
        res.status(429).json(options.message);
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

export const aiRateLimit: RequestHandler = createSlidingWindowRateLimit({
  windowMs: getAiRateLimitWindowMs,
  max: getAiRateLimitMax,
  message: {
    error: "Too many requests. Please slow down and try again in a moment.",
  },
});

/**
 * Reading the budget is not spending it, so it cannot share `aiRateLimit`.
 *
 * That limiter exists to ration one player's provider calls, and 15 a minute
 * is the right number for an identity. This endpoint has no identity to
 * ration: the Next.js proxy strips every caller-supplied IP header and only
 * re-adds a signed one when the operator sets `TRUST_PROXY_HEADERS`, so by
 * default `getRateLimitKey` falls back to the proxy's own address and every
 * anonymous visitor arrives as the same caller. Under `aiRateLimit` the
 * sixteenth home page in a minute is answered 429 and its banner silently
 * disappears -- hiding the warning exactly when traffic makes it most likely
 * the budget is spent.
 *
 * The cap is therefore sized as a flood guard for a whole deployment's front
 * door. It can be, because a read costs a map lookup plus an upstream figure
 * that is TTL-cached and single-flighted; it is not a proxy for provider
 * spend, which `chargeAiBudget` accounts for separately at the routes that
 * actually reach a provider.
 */
export const aiBudgetReadRateLimit: RequestHandler = createSlidingWindowRateLimit({
  windowMs: getAiRateLimitWindowMs,
  max: getAiBudgetReadRateLimitMax,
  keyPrefix: "ai-budget-read",
  message: {
    error: "Too many budget checks. Please slow down and try again in a moment.",
  },
});

/**
 * A flood guard for `/api/ai/probe?live=true`, the one unauthenticated route
 * that reaches the provider.
 *
 * `app.ts` mounts the gameplay routes behind `aiRateLimit` and mounts
 * `/api/ai` behind nothing, which was defensible while the probe spent only
 * its own account: the token check gates it in production
 * (`NODE_ENV=production` plus `AI_LIVE_PROBE_TOKEN`), and outside production
 * the cost of an abused probe fell on whoever deployed it. It stopped being
 * defensible when the probe was wired into the shared budget, because a
 * looped probe now spends the *players'* day and degrades everyone to
 * simulated answers -- a denial of service against the game from an endpoint
 * that needs no session, no scenario and no credential.
 *
 * Sized for a monitor, not a player: this is an operator check, so five a
 * minute is generous and anything above it is a loop. The cap is
 * deployment-wide for the same reason `aiBudgetReadRateLimit` is -- behind
 * the Next.js proxy every anonymous caller resolves to one identity -- and
 * that is the right shape here, because the thing being rationed is the
 * shared account rather than any one caller's allowance.
 *
 * It does not replace the budget. The budget caps the day; this caps the rate
 * at which one unauthenticated endpoint is allowed to eat it.
 */
export const aiLiveProbeRateLimit: RequestHandler = createSlidingWindowRateLimit({
  windowMs: getAiRateLimitWindowMs,
  max: getAiLiveProbeRateLimitMax,
  keyPrefix: "ai-live-probe",
  message: {
    error: "Too many live AI probes. Please slow down and try again in a moment.",
  },
});

export const gameplayTelemetryRateLimit = rateLimit({
  windowMs: DEFAULT_AI_RATE_LIMIT_WINDOW_MS,
  limit: () => readCachedPositiveLimit(
    cachedGameplayTelemetryRateLimitMax,
    process.env.GAMEPLAY_TELEMETRY_RATE_LIMIT_MAX,
    DEFAULT_GAMEPLAY_TELEMETRY_RATE_LIMIT_MAX,
  ),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: "Too many gameplay telemetry events. Please slow down and try again shortly.",
  },
  keyGenerator: (req) => getIpRateLimitKey(req),
});
