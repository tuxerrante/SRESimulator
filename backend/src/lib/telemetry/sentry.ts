import * as Sentry from "@sentry/node";

let sentryInitialized = false;

function normalizeSentryRelease(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function isSentryEnabled(): boolean {
  return process.env.SENTRY_ENABLED === "true" && Boolean(process.env.SENTRY_DSN);
}

export function initBackendSentry(): void {
  if (!isSentryEnabled() || sentryInitialized) {
    return;
  }

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? "development",
    release: normalizeSentryRelease(process.env.SENTRY_RELEASE),
    sendDefaultPii: false,
  });

  sentryInitialized = true;
}

export { Sentry };
