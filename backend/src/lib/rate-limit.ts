import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { verifySignedClientIp } from "../../../shared/auth/client-ip";

interface RateLimitRequestLike {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

function readPositiveLimitFromEnv(
  rawValue: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getRateLimitKey(
  req: RateLimitRequestLike,
  antiAbuseSecret = process.env.ANTI_ABUSE_HMAC_SECRET,
): string {
  const signedIpHeader = req.headers["x-sresim-client-ip"];
  const signatureHeader = req.headers["x-sresim-client-ip-signature"];
  const signedIp = Array.isArray(signedIpHeader) ? signedIpHeader[0] : signedIpHeader;
  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;

  if (
    antiAbuseSecret &&
    signedIp &&
    signature &&
    verifySignedClientIp(signedIp, signature, antiAbuseSecret)
  ) {
    return ipKeyGenerator(signedIp);
  }

  if (req.ip) {
    return ipKeyGenerator(req.ip);
  }

  return "unknown";
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
  keyGenerator: (req) => getRateLimitKey(req),
});

export const gameplayAdminRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: () => readPositiveLimitFromEnv(process.env.GAMEPLAY_ADMIN_RATE_LIMIT_MAX, 15),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: "Too many gameplay admin requests. Please retry in a moment.",
  },
  keyGenerator: (req) => getRateLimitKey(req),
});
