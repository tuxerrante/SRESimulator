import type { Request } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureBackendRouteError } from "./capture";

type ErrorWithCause = Error & { cause?: unknown };

const sentryMocks = vi.hoisted(() => {
  const setTag = vi.fn();
  const setContext = vi.fn();

  return {
    setTag,
    setContext,
    captureException: vi.fn(),
    withScope: vi.fn((callback: (scope: { setTag: typeof setTag; setContext: typeof setContext }) => void) => {
      callback({
        setTag,
        setContext,
      });
    }),
  };
});

vi.mock("@sentry/node", () => ({
  captureException: sentryMocks.captureException,
  withScope: sentryMocks.withScope,
}));

describe("captureBackendRouteError", () => {
  const originalSentryEnabled = process.env.SENTRY_ENABLED;
  const originalSentryDsn = process.env.SENTRY_DSN;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SENTRY_ENABLED = "true";
    process.env.SENTRY_DSN = "https://public@example.ingest.sentry.io/1";
  });

  afterEach(() => {
    if (originalSentryEnabled === undefined) {
      delete process.env.SENTRY_ENABLED;
    } else {
      process.env.SENTRY_ENABLED = originalSentryEnabled;
    }
    if (originalSentryDsn === undefined) {
      delete process.env.SENTRY_DSN;
    } else {
      process.env.SENTRY_DSN = originalSentryDsn;
    }
  });

  it("captures only safe route tags and request context", () => {
    const error = new Error("provider payload leaked") as ErrorWithCause;
    error.cause = new Error("proxy raw body");
    error.stack = [
      "Error: provider payload leaked",
      "    at postChat (chat.ts:115:7)",
      "    at router (express.js:10:2)",
    ].join("\n");

    if (error.cause instanceof Error) {
      error.cause.stack = [
        "Error: proxy raw body",
        "    at upstreamProxy (ai-runtime.ts:200:3)",
      ].join("\n");
    }
    const request = {
      method: "POST",
      path: "/",
      baseUrl: "/api/chat",
      get(name: string) {
        const headers: Record<string, string> = {
          "x-sresim-request-id": "3a8f6d6e-32ef-4a97-8891-0bc5987888f1",
          "x-sresim-actor-ref": "2c9374a5-94f3-4c58-aab5-413f28643f03",
          "x-sresim-game-session-ref": "4d2c91fa8e7b6a10",
          authorization: "Bearer secret",
          cookie: "session=secret",
        };
        return headers[name.toLowerCase()];
      },
    } as unknown as Request;

    captureBackendRouteError(request, error);

    expect(sentryMocks.setTag.mock.calls).toEqual([
      ["feature", "chat"],
      ["requestId", "3a8f6d6e-32ef-4a97-8891-0bc5987888f1"],
      ["actorRef", "2c9374a5-94f3-4c58-aab5-413f28643f03"],
      ["gameSessionRef", "4d2c91fa8e7b6a10"],
    ]);
    expect(sentryMocks.setContext).toHaveBeenCalledWith("request", {
      method: "POST",
      route: "/api/chat",
    });
    expect(sentryMocks.captureException).toHaveBeenCalledTimes(1);
    const captured = sentryMocks.captureException.mock.calls[0]?.[0] as ErrorWithCause | undefined;
    expect(captured).toBeInstanceOf(Error);
    if (!(captured instanceof Error)) {
      return;
    }
    expect(captured.message).toBe("Chat request failed");
    expect(captured.stack).toContain("at postChat (chat.ts:115:7)");
    expect(captured.stack).not.toContain("provider payload leaked");
    const capturedCause = captured.cause;
    expect(capturedCause).toBeInstanceOf(Error);
    if (!(capturedCause instanceof Error)) {
      return;
    }
    expect(capturedCause.stack).toContain("at upstreamProxy (ai-runtime.ts:200:3)");
    expect(capturedCause.stack).not.toContain("proxy raw body");
  });

  it("supports explicit safe route messages for specialized flows", () => {
    const request = {
      method: "POST",
      path: "/",
      baseUrl: "/api/chat",
      get() {
        return undefined;
      },
    } as unknown as Request;

    const error = new Error("provider leaked body");
    error.stack = [
      "Error: provider leaked body",
      "    at streamLoop (chat.ts:104:7)",
    ].join("\n");

    captureBackendRouteError(request, error, "Chat stream failed");

    const captured = sentryMocks.captureException.mock.calls[0]?.[0];
    expect(captured).toBeInstanceOf(Error);
    if (!(captured instanceof Error)) {
      return;
    }
    expect(captured.message).toBe("Chat stream failed");
    expect(captured.stack).toContain("at streamLoop (chat.ts:104:7)");
    expect(captured.stack).not.toContain("provider leaked body");
  });

  it("does nothing when sentry is disabled", () => {
    process.env.SENTRY_ENABLED = "false";

    const request = {
      method: "POST",
      path: "/",
      baseUrl: "/api/chat",
      get() {
        return undefined;
      },
    } as unknown as Request;

    captureBackendRouteError(request, new Error("boom"));

    expect(sentryMocks.withScope).not.toHaveBeenCalled();
    expect(sentryMocks.captureException).not.toHaveBeenCalled();
  });

  it("swallows sentry capture failures", () => {
    sentryMocks.withScope.mockImplementationOnce(() => {
      throw new Error("sentry unavailable");
    });
    const request = {
      method: "POST",
      path: "/",
      baseUrl: "/api/chat",
      get() {
        return undefined;
      },
    } as unknown as Request;

    expect(() =>
      captureBackendRouteError(request, new Error("provider leaked body")),
    ).not.toThrow();
  });
});
