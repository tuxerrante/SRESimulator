import * as Sentry from "@sentry/node";
import type { Request } from "express";
import { buildSentryRequestContext } from "./request-context";
import { isSentryEnabled } from "./sentry";

type ErrorWithCause = Error & { cause?: unknown };

function defaultBackendSentryMessage(feature: string): string {
  switch (feature) {
    case "scenario":
      return "Scenario request failed";
    case "command":
      return "Command request failed";
    case "chat":
      return "Chat request failed";
    case "scores":
      return "Score request failed";
    case "gameplay":
      return "Gameplay request failed";
    default:
      return "Backend request failed";
  }
}

function sanitizeErrorStack(
  stack: string | undefined,
  name: string,
  safeMessage: string,
): string | undefined {
  if (!stack) {
    return undefined;
  }

  const [, ...frames] = stack.split("\n");
  return [`${name}: ${safeMessage}`, ...frames].join("\n");
}

function buildSafeBackendError(
  error: unknown,
  safeMessage: string,
  seen = new WeakSet<Error>(),
): Error {
  if (error instanceof Error) {
    if (seen.has(error)) {
      const cycleSafeError = new Error(safeMessage);
      cycleSafeError.name = error.name;
      return cycleSafeError;
    }
    seen.add(error);
  }

  const originalCause = error instanceof Error
    ? (error as ErrorWithCause).cause
    : undefined;
  const safeCause = originalCause instanceof Error
    ? buildSafeBackendError(originalCause, safeMessage, seen)
    : undefined;

  const safeError = new Error(safeMessage) as ErrorWithCause;
  safeError.name = error instanceof Error ? error.name : "Error";
  if (safeCause) {
    safeError.cause = safeCause;
  }
  const sanitizedStack = error instanceof Error
    ? sanitizeErrorStack(error.stack, safeError.name, safeMessage)
    : undefined;
  if (sanitizedStack) {
    safeError.stack = sanitizedStack;
  }
  return safeError;
}

export function captureBackendRouteError(
  req: Request,
  error: unknown,
  safeMessage?: string,
): void {
  if (!isSentryEnabled()) {
    return;
  }

  const context = buildSentryRequestContext(req);
  try {
    Sentry.withScope((scope) => {
      Object.entries(context.tags).forEach(([key, value]) => {
        scope.setTag(key, value);
      });
      scope.setContext("request", context.extra.request as Record<string, unknown>);
      Sentry.captureException(
        buildSafeBackendError(
          error,
          safeMessage ?? defaultBackendSentryMessage(context.tags.feature ?? "unknown"),
        ),
      );
    });
  } catch {
    // Telemetry failures must never break request error handling paths.
  }
}
