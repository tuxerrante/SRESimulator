import * as Sentry from "@sentry/node";

let sentryInitialized = false;

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
    release: process.env.SENTRY_RELEASE,
    sendDefaultPii: false,
  });

  sentryInitialized = true;
}

export { Sentry };
