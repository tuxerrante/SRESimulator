import { afterEach, describe, expect, it, vi } from "vitest";

describe("instrument", () => {
  const originalSentryEnabled = process.env.SENTRY_ENABLED;
  const originalSentryDsn = process.env.SENTRY_DSN;
  const originalSentryEnvironment = process.env.SENTRY_ENVIRONMENT;
  const originalSentryRelease = process.env.SENTRY_RELEASE;

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@sentry/node");

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

    if (originalSentryEnvironment === undefined) {
      delete process.env.SENTRY_ENVIRONMENT;
    } else {
      process.env.SENTRY_ENVIRONMENT = originalSentryEnvironment;
    }

    if (originalSentryRelease === undefined) {
      delete process.env.SENTRY_RELEASE;
    } else {
      process.env.SENTRY_RELEASE = originalSentryRelease;
    }
  });

  it("initializes Sentry during instrument import when enabled", async () => {
    process.env.SENTRY_ENABLED = "true";
    process.env.SENTRY_DSN = "https://examplePublicKey@o0.ingest.sentry.io/0";
    process.env.SENTRY_ENVIRONMENT = "test";
    process.env.SENTRY_RELEASE = "backend-sha";

    const init = vi.fn();

    vi.doMock("@sentry/node", () => ({ init }));

    await import("./instrument");

    expect(init).toHaveBeenCalledOnce();
    expect(init).toHaveBeenCalledWith({
      dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
      environment: "test",
      release: "backend-sha",
      sendDefaultPii: false,
    });
  });

  it("initializes Sentry only once", async () => {
    process.env.SENTRY_ENABLED = "true";
    process.env.SENTRY_DSN = "https://examplePublicKey@o0.ingest.sentry.io/0";

    const init = vi.fn();

    vi.doMock("@sentry/node", () => ({ init }));

    const { initBackendSentry } = await import("./lib/telemetry/sentry");

    initBackendSentry();
    initBackendSentry();

    expect(init).toHaveBeenCalledOnce();
  });

  it("normalizes blank release values to undefined", async () => {
    process.env.SENTRY_ENABLED = "true";
    process.env.SENTRY_DSN = "https://examplePublicKey@o0.ingest.sentry.io/0";
    process.env.SENTRY_RELEASE = "   ";

    const init = vi.fn();

    vi.doMock("@sentry/node", () => ({ init }));

    const { initBackendSentry } = await import("./lib/telemetry/sentry");

    initBackendSentry();

    expect(init).toHaveBeenCalledOnce();
    expect(init).toHaveBeenCalledWith({
      dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
      environment: "development",
      release: undefined,
      sendDefaultPii: false,
    });
  });
});
