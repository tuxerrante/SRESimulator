import * as Sentry from "@sentry/nextjs";
import { getOrCreateActorRef } from "@/lib/telemetry/actor-ref";
import {
  type FrontendSentryRuntimeConfig,
  readInjectedFrontendSentryRuntimeConfig,
} from "@/lib/telemetry/bootstrap-config";

declare global {
  var __SRESIM_SENTRY_BROWSER_CONFIG__:
    | FrontendSentryRuntimeConfig
    | undefined;
}

const RUNTIME_CONFIG_RETRY_MS = 50;
const RUNTIME_CONFIG_MAX_ATTEMPTS = 40;
let sentryInitialized = false;

function initBrowserSentry(config: FrontendSentryRuntimeConfig): void {
  if (!config.enabled || sentryInitialized) {
    return;
  }
  sentryInitialized = true;
  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    sendDefaultPii: false,
    integrations: [
      Sentry.replayIntegration({
        maskAllText: true,
        maskAllInputs: true,
        blockAllMedia: true,
      }),
    ],
    replaysSessionSampleRate: config.replaySessionSampleRate,
    replaysOnErrorSampleRate: config.replayOnErrorSampleRate,
    initialScope: {
      tags: {
        actorRef: getOrCreateActorRef(),
      },
    },
  });
}

function tryInitFromInjectedConfig(): boolean {
  const runtimeConfig = readInjectedFrontendSentryRuntimeConfig(
    globalThis as Record<string, unknown>,
  );
  if (!runtimeConfig) {
    return false;
  }
  initBrowserSentry(runtimeConfig);
  return sentryInitialized;
}

function scheduleRuntimeConfigInit(attempt = 0): void {
  if (sentryInitialized || attempt >= RUNTIME_CONFIG_MAX_ATTEMPTS) {
    return;
  }
  if (tryInitFromInjectedConfig()) {
    return;
  }
  setTimeout(() => scheduleRuntimeConfigInit(attempt + 1), RUNTIME_CONFIG_RETRY_MS);
}

if (!tryInitFromInjectedConfig()) {
  scheduleRuntimeConfigInit();
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
