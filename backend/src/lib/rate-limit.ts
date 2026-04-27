import rateLimit, { ipKeyGenerator } from "express-rate-limit";

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
  keyGenerator: (req) => {
    const clientIp =
      req.ip ??
      req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ??
      "";
    if (!clientIp) {
      return "unknown";
    }
    return ipKeyGenerator(clientIp);
  },
});

export const gameplayTelemetryRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: () => {
    const parsed = Number.parseInt(process.env.GAMEPLAY_TELEMETRY_RATE_LIMIT_MAX ?? "60", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
  },
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: "Too many gameplay telemetry events. Please slow down and try again shortly.",
  },
  keyGenerator: (req) => {
    const clientIp =
      req.ip ??
      req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ??
      "";
    if (!clientIp) {
      return "unknown";
    }
    return ipKeyGenerator(clientIp);
  },
});
