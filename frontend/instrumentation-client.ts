import * as Sentry from "@sentry/nextjs";
import { getOrCreateActorRef } from "@/lib/telemetry/actor-ref";
import {
  FRONTEND_SENTRY_RUNTIME_CONFIG_GLOBAL,
  type FrontendSentryRuntimeConfig,
  readInjectedFrontendSentryRuntimeConfig,
} from "@/lib/telemetry/bootstrap-config";

declare global {
  var __SRESIM_SENTRY_BROWSER_CONFIG__:
    | FrontendSentryRuntimeConfig
    | undefined;
}

const runtimeConfig = readInjectedFrontendSentryRuntimeConfig(
  globalThis as Record<string, unknown>,
);

if (runtimeConfig?.enabled) {
  Sentry.init({
    dsn: runtimeConfig.dsn,
    environment: runtimeConfig.environment,
    sendDefaultPii: false,
    integrations: [
      Sentry.replayIntegration({
        maskAllText: true,
        maskAllInputs: true,
        blockAllMedia: true,
      }),
    ],
    replaysSessionSampleRate: runtimeConfig.replaySessionSampleRate,
    replaysOnErrorSampleRate: runtimeConfig.replayOnErrorSampleRate,
    initialScope: {
      tags: {
        actorRef: getOrCreateActorRef(),
      },
    },
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

void FRONTEND_SENTRY_RUNTIME_CONFIG_GLOBAL;
