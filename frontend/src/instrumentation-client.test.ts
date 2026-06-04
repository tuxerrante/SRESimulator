import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({
  init: vi.fn(),
  replayIntegration: vi.fn((options: unknown) => options),
  captureRouterTransitionStart: vi.fn(),
}));

vi.mock("@/lib/telemetry/actor-ref", () => ({
  getOrCreateActorRef: vi.fn(() => "actor-123"),
}));

describe("instrumentation-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.useRealTimers();
    delete (
      globalThis as typeof globalThis & {
        __SRESIM_SENTRY_BROWSER_CONFIG__?: unknown;
      }
    ).__SRESIM_SENTRY_BROWSER_CONFIG__;
    process.env.NEXT_PUBLIC_SENTRY_ENABLED = "true";
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://public@example.ingest.sentry.io/1";
  });

  it("initializes browser sentry immediately from injected runtime config", async () => {
    const sentry = await import("@sentry/nextjs");

    (
      globalThis as typeof globalThis & {
        __SRESIM_SENTRY_BROWSER_CONFIG__?: unknown;
      }
    ).__SRESIM_SENTRY_BROWSER_CONFIG__ = {
      enabled: true,
      dsn: "https://public@example.ingest.sentry.io/1",
      environment: "production",
      replaySessionSampleRate: 0.25,
      replayOnErrorSampleRate: 1,
    };

    await import("../instrumentation-client");

    expect(sentry.replayIntegration).toHaveBeenCalledWith({
      maskAllText: true,
      maskAllInputs: true,
      blockAllMedia: true,
    });
    expect(sentry.init).toHaveBeenCalledWith({
      dsn: "https://public@example.ingest.sentry.io/1",
      environment: "production",
      sendDefaultPii: false,
      integrations: [
        {
          maskAllText: true,
          maskAllInputs: true,
          blockAllMedia: true,
        },
      ],
      replaysSessionSampleRate: 0.25,
      replaysOnErrorSampleRate: 1,
      initialScope: {
        tags: {
          actorRef: "actor-123",
        },
      },
    });
  });

  it("does not initialize browser sentry directly from build-time env", async () => {
    const sentry = await import("@sentry/nextjs");

    await import("../instrumentation-client");

    expect(sentry.init).not.toHaveBeenCalled();
  });

  it("initializes browser sentry after runtime config becomes available", async () => {
    vi.useFakeTimers();
    const sentry = await import("@sentry/nextjs");
    await import("../instrumentation-client");

    expect(sentry.init).not.toHaveBeenCalled();

    (
      globalThis as typeof globalThis & {
        __SRESIM_SENTRY_BROWSER_CONFIG__?: unknown;
      }
    ).__SRESIM_SENTRY_BROWSER_CONFIG__ = {
      enabled: true,
      dsn: "https://public@example.ingest.sentry.io/1",
      environment: "production",
      replaySessionSampleRate: 0.25,
      replayOnErrorSampleRate: 1,
    };

    await vi.advanceTimersByTimeAsync(100);

    expect(sentry.init).toHaveBeenCalledTimes(1);
  });

  it("re-exports the router transition hook for navigation instrumentation", async () => {
    const sentry = await import("@sentry/nextjs");
    const instrumentationClient = await import("../instrumentation-client");

    expect(instrumentationClient.onRouterTransitionStart).toBe(
      sentry.captureRouterTransitionStart,
    );
  });
});
