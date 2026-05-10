import * as Sentry from "@sentry/nextjs";

export interface FrontendTelemetryContext {
  feature: string;
  phase?: string;
  difficulty?: string;
  requestId?: string;
  actorRef?: string;
  gameSessionRef?: string;
}

type ErrorWithCause = Error & { cause?: unknown };

function defaultFrontendSentryMessage(feature: string): string {
  switch (feature) {
    case "command":
      return "Command proxy request failed";
    case "chat":
      return "Chat request failed";
    default:
      return "Frontend request failed";
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

function buildSafeFrontendError(
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
    ? buildSafeFrontendError(originalCause, safeMessage, seen)
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

export function captureFrontendError(
  error: unknown,
  context: FrontendTelemetryContext,
  safeMessage?: string,
): void {
  Sentry.withScope((scope) => {
    scope.setTag("feature", context.feature);
    if (context.phase) scope.setTag("phase", context.phase);
    if (context.difficulty) scope.setTag("difficulty", context.difficulty);
    if (context.requestId) scope.setTag("requestId", context.requestId);
    if (context.actorRef) scope.setTag("actorRef", context.actorRef);
    if (context.gameSessionRef) scope.setTag("gameSessionRef", context.gameSessionRef);

    Sentry.captureException(
      buildSafeFrontendError(
        error,
        safeMessage ?? defaultFrontendSentryMessage(context.feature),
      ),
    );
  });
}
