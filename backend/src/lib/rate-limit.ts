import { createHash } from "node:crypto";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
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

function readPositiveLimitFromEnv(
  rawValue: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function shouldTreatReqIpAsTrustedFallback(): boolean {
  return process.env.TRUST_PROXY_HEADERS !== "true";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
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
  return getSessionTokenIdentity(req)
    ?? getScenarioCookieIdentity(req, antiAbuseSecret, authSessionSecret)
    ?? getIpFallbackIdentity(req, antiAbuseSecret);
}

/**
 * Per-IP rate limiter for AI-backed routes to prevent a single client
 * from exhausting shared Azure OpenAI TPM quota.
 *
 * Limits apply per windowMs. Exceeding the limit returns HTTP 429
 * with a JSON body before the request reaches the AI provider.
 */
export const aiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 15,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: "Too many requests. Please slow down and try again in a moment.",
  },
  keyGenerator: (req) => getRateLimitKey(req),
});

export const gameplayTelemetryRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: () => readPositiveLimitFromEnv(process.env.GAMEPLAY_TELEMETRY_RATE_LIMIT_MAX, 60),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: "Too many gameplay telemetry events. Please slow down and try again shortly.",
  },
  keyGenerator: (req) => getIpRateLimitKey(req),
});
