import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureFrontendError } from "./capture";

type ErrorWithCause = Error & { cause?: unknown };

const sentryMocks = vi.hoisted(() => {
  const setTag = vi.fn();
  const setContext = vi.fn();

  return {
    setTag,
    setContext,
    captureException: vi.fn((error: unknown) => {
      void error;
      return "event-id";
    }),
    withScope: vi.fn((callback: (scope: { setTag: typeof setTag; setContext: typeof setContext }) => void) => {
      callback({
        setTag,
        setContext,
      });
    }),
  };
});

vi.mock("@sentry/nextjs", () => ({
  captureException: sentryMocks.captureException,
  withScope: sentryMocks.withScope,
}));

describe("captureFrontendError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captures a sanitized default message while keeping pseudonymous tags", () => {
    const error = new Error("proxy body with provider secret") as ErrorWithCause;
    error.cause = new Error("upstream provider body");
    error.stack = [
      "Error: proxy body with provider secret",
      "    at sendMessage (useChat.ts:100:15)",
      "    at onClick (ChatPanel.tsx:20:5)",
    ].join("\n");

    if (error.cause instanceof Error) {
      error.cause.stack = [
        "Error: upstream provider body",
        "    at providerCall (chat.ts:50:9)",
      ].join("\n");
    }

    captureFrontendError(error, {
      feature: "command",
      phase: "reading",
      difficulty: "easy",
      platform: "aro-classic",
      requestId: "req-123",
      actorRef: "actor-123",
      gameSessionRef: "gsr-123",
    });

    expect(sentryMocks.setTag.mock.calls).toEqual([
      ["feature", "command"],
      ["phase", "reading"],
      ["difficulty", "easy"],
      ["platform", "aro-classic"],
      ["requestId", "req-123"],
      ["actorRef", "actor-123"],
      ["gameSessionRef", "gsr-123"],
    ]);
    expect(sentryMocks.captureException).toHaveBeenCalledTimes(1);
    const captured = sentryMocks.captureException.mock.calls[0]?.[0] as unknown;
    expect(captured).toBeInstanceOf(Error);
    if (!(captured instanceof Error)) {
      return;
    }

    expect(captured.message).toBe("Command proxy request failed");
    expect(captured.stack).toContain("at sendMessage (useChat.ts:100:15)");
    expect(captured.stack).not.toContain("proxy body with provider secret");
    expect(captured.cause).toBeInstanceOf(Error);
    if (!(captured.cause instanceof Error)) {
      return;
    }
    expect(captured.cause.stack).toContain("at providerCall (chat.ts:50:9)");
    expect(captured.cause.stack).not.toContain("upstream provider body");
    expect(sentryMocks.setContext).not.toHaveBeenCalled();
  });

  it("supports explicit safe messages for specialized flows", () => {
    const error = new Error("upstream stream body");
    error.stack = [
      "Error: upstream stream body",
      "    at processBufferedEvents (useChat.ts:194:15)",
    ].join("\n");

    captureFrontendError(error, { feature: "chat" }, "Chat stream failed");

    const captured = sentryMocks.captureException.mock.calls[0]?.[0] as unknown;
    expect(captured).toBeInstanceOf(Error);
    if (!(captured instanceof Error)) {
      return;
    }

    expect(captured.message).toBe("Chat stream failed");
    expect(captured.stack).toContain("at processBufferedEvents (useChat.ts:194:15)");
    expect(captured.stack).not.toContain("upstream stream body");
  });

  it("handles cyclic error causes without stack overflow", () => {
    const error = new Error("cyclic root") as ErrorWithCause;
    error.cause = error;

    expect(() =>
      captureFrontendError(error, { feature: "chat" }),
    ).not.toThrow();

    const captured = sentryMocks.captureException.mock.calls[0]?.[0] as unknown;
    expect(captured).toBeInstanceOf(Error);
    if (!(captured instanceof Error)) {
      return;
    }

    expect(captured.message).toBe("Chat request failed");
    expect(captured.cause).toBeInstanceOf(Error);
    expect(captured.cause).not.toBe(captured);
  });
});
