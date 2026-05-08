const MIN_SAMPLE_RATE = 0;
const MAX_SAMPLE_RATE = 1;
export const FRONTEND_SENTRY_RUNTIME_CONFIG_GLOBAL =
  "__SRESIM_SENTRY_BROWSER_CONFIG__";

export interface FrontendSentryRuntimeConfig {
  enabled: boolean;
  dsn: string;
  environment: string;
  replaySessionSampleRate: number;
  replayOnErrorSampleRate: number;
}

export function shouldInitSentry(
  enabled: string | undefined,
  dsn: string | undefined,
): boolean {
  return enabled === "true" && Boolean(dsn);
}

export function parseReplaySampleRate(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.min(MAX_SAMPLE_RATE, Math.max(MIN_SAMPLE_RATE, parsed));
}

export function readFrontendSentryRuntimeConfig(
  env: Record<string, string | undefined>,
): FrontendSentryRuntimeConfig {
  return {
    enabled: shouldInitSentry(
      env.NEXT_PUBLIC_SENTRY_ENABLED,
      env.NEXT_PUBLIC_SENTRY_DSN,
    ),
    dsn: env.NEXT_PUBLIC_SENTRY_DSN ?? "",
    environment: env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? "development",
    replaySessionSampleRate: parseReplaySampleRate(
      env.NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE,
    ),
    replayOnErrorSampleRate: parseReplaySampleRate(
      env.NEXT_PUBLIC_SENTRY_REPLAY_ON_ERROR_SAMPLE_RATE,
    ),
  };
}

function isFrontendSentryRuntimeConfig(
  value: unknown,
): value is FrontendSentryRuntimeConfig {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<FrontendSentryRuntimeConfig>;
  return (
    typeof candidate.enabled === "boolean" &&
    typeof candidate.dsn === "string" &&
    typeof candidate.environment === "string" &&
    typeof candidate.replaySessionSampleRate === "number" &&
    typeof candidate.replayOnErrorSampleRate === "number"
  );
}

export function readInjectedFrontendSentryRuntimeConfig(
  globalObject: Record<string, unknown>,
): FrontendSentryRuntimeConfig | undefined {
  const candidate = globalObject[FRONTEND_SENTRY_RUNTIME_CONFIG_GLOBAL];
  return isFrontendSentryRuntimeConfig(candidate) ? candidate : undefined;
}

export function serializeFrontendSentryRuntimeConfig(
  config: FrontendSentryRuntimeConfig,
): string {
  const serialized = JSON.stringify(config).replace(/</g, "\\u003c");
  return `window.${FRONTEND_SENTRY_RUNTIME_CONFIG_GLOBAL} = ${serialized};`;
}
