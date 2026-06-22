import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { createHash, randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { createClient, type RedisClientType } from "redis";
import { VIEWER_SESSION_COOKIE } from "../../../shared/auth/constants";
import { verifySignedClientIp } from "../../../shared/auth/client-ip";
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

interface SlidingWindowDecision {
  allowed: boolean;
  remaining: number;
  resetAtMs: number;
  retryAfterSeconds: number;
}

interface SlidingWindowStore {
  consume(
    key: string,
    nowMs: number,
    windowMs: number,
    limit: number,
  ): Promise<SlidingWindowDecision>;
}

const DEFAULT_AI_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const DEFAULT_AI_RATE_LIMIT_MAX = 15;
const DEFAULT_GAMEPLAY_TELEMETRY_RATE_LIMIT_MAX = 60;
const REDIS_KEY_PREFIX = "sresim:rate-limit";
const RATE_LIMIT_STATUS_HEADER = "x-sresim-rate-limit-status";
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

function readPositiveLimitFromEnv(
  rawValue: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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

const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function getSessionTokenIdentity(req: RateLimitRequestLike): string | null {
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

export function getRateLimitKey(
  req: RateLimitRequestLike,
  antiAbuseSecret = process.env.ANTI_ABUSE_HMAC_SECRET,
  authSessionSecret = process.env.AUTH_SESSION_SECRET,
): string {
  return getSessionTokenIdentity(req) ??
    getScenarioCookieIdentity(req, antiAbuseSecret, authSessionSecret) ??
    getIpFallbackIdentity(req, antiAbuseSecret);
}

export class InMemorySlidingWindowStore implements SlidingWindowStore {
  private readonly buckets = new Map<string, number[]>();

  private pruneExpiredBuckets(cutoff: number): void {
    for (const [bucketKey, timestamps] of this.buckets.entries()) {
      const activeTimestamps = timestamps.filter((timestamp) => timestamp > cutoff);
      if (activeTimestamps.length === 0) {
        this.buckets.delete(bucketKey);
        continue;
      }
      this.buckets.set(bucketKey, activeTimestamps);
    }
  }

  async consume(
    key: string,
    nowMs: number,
    windowMs: number,
    limit: number,
  ): Promise<SlidingWindowDecision> {
    const cutoff = nowMs - windowMs;
    this.pruneExpiredBuckets(cutoff);
    const existing = [...(this.buckets.get(key) ?? [])];

    if (existing.length >= limit) {
      const resetAtMs = (existing[0] ?? nowMs) + windowMs;
      this.buckets.set(key, existing);
      return {
        allowed: false,
        remaining: 0,
        resetAtMs,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000)),
      };
    }

    existing.push(nowMs);
    this.buckets.set(key, existing);

    return {
      allowed: true,
      remaining: Math.max(limit - existing.length, 0),
      resetAtMs: nowMs + windowMs,
      retryAfterSeconds: Math.max(1, Math.ceil(windowMs / 1000)),
    };
  }
}

class RedisSlidingWindowStore implements SlidingWindowStore {
  private client: RedisClientType | null = null;
  private connectPromise: Promise<RedisClientType> | null = null;

  constructor(private readonly url: string) {}

  private async getClient(): Promise<RedisClientType> {
    if (this.client?.isOpen) {
      return this.client;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    const client = createClient({ url: this.url });
    client.on("error", (error) => {
      console.warn("[rate-limit] redis client error", error);
    });

    this.connectPromise = client.connect()
      .then(() => {
        this.client = client;
        this.connectPromise = null;
        return client;
      })
      .catch((error) => {
        this.connectPromise = null;
        throw error;
      });

    return this.connectPromise;
  }

  async consume(
    key: string,
    nowMs: number,
    windowMs: number,
    limit: number,
  ): Promise<SlidingWindowDecision> {
    const client = await this.getClient();
    const redisKey = `${REDIS_KEY_PREFIX}:${key}`;
    const result = await client.sendCommand<string[]>([
      "EVAL",
      REDIS_SLIDING_WINDOW_SCRIPT,
      "1",
      redisKey,
      String(nowMs),
      String(windowMs),
      String(limit),
      `${nowMs}:${randomUUID()}`,
    ]);

    const [allowedRaw, countRaw, resetAtRaw] = result.map((value) => Number(value));
    const allowed = allowedRaw === 1;
    const count = Number.isFinite(countRaw) ? countRaw : 0;
    const resetAtMs = Number.isFinite(resetAtRaw) ? resetAtRaw : nowMs + windowMs;

    return {
      allowed,
      remaining: allowed ? Math.max(limit - count, 0) : 0,
      resetAtMs,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000)),
    };
  }
}

let inMemoryStore: InMemorySlidingWindowStore | null = null;
let redisStore: RedisSlidingWindowStore | null = null;
let loggedRedisFailOpen = false;

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

function getAiRateLimitWindowMs(): number {
  return readPositiveLimitFromEnv(
    process.env.AI_RATE_LIMIT_WINDOW_MS,
    DEFAULT_AI_RATE_LIMIT_WINDOW_MS,
  );
}

function getAiRateLimitMax(): number {
  return readPositiveLimitFromEnv(
    process.env.AI_RATE_LIMIT_MAX,
    DEFAULT_AI_RATE_LIMIT_MAX,
  );
}

function applyRateLimitHeaders(
  res: Response,
  limit: number,
  remaining: number,
  resetAtMs: number,
): void {
  res.setHeader("RateLimit-Limit", String(limit));
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
}): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const limit = options.max();
    const windowMs = options.windowMs();
    const key = getRateLimitKey(req);
    const nowMs = Date.now();

    try {
      const store = getSlidingWindowStore();
      let decision: SlidingWindowDecision;

      try {
        decision = await store.consume(key, nowMs, windowMs, limit);
      } catch (error) {
        if (store instanceof RedisSlidingWindowStore) {
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

      applyRateLimitHeaders(res, limit, decision.remaining, decision.resetAtMs);

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

export const aiRateLimit = createSlidingWindowRateLimit({
  windowMs: getAiRateLimitWindowMs,
  max: getAiRateLimitMax,
  message: {
    error: "Too many requests. Please slow down and try again in a moment.",
  },
});

export const gameplayTelemetryRateLimit = rateLimit({
  windowMs: DEFAULT_AI_RATE_LIMIT_WINDOW_MS,
  limit: () => readPositiveLimitFromEnv(
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
