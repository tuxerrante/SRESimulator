import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentryMocks = vi.hoisted(() => ({
  init: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  init: sentryMocks.init,
}));

describe("frontend server and edge sentry config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SENTRY_ENABLED: "true",
      NEXT_PUBLIC_SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
      NEXT_PUBLIC_SENTRY_ENVIRONMENT: "production",
      NEXT_PUBLIC_SENTRY_RELEASE: "frontend@1.2.3",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("omits a runtime release override in server init", async () => {
    await import("../sentry.server.config");

    expect(sentryMocks.init).toHaveBeenCalledWith({
      dsn: "https://public@example.ingest.sentry.io/1",
      environment: "production",
      sendDefaultPii: false,
    });
  });

  it("omits a runtime release override in edge init", async () => {
    await import("../sentry.edge.config");

    expect(sentryMocks.init).toHaveBeenCalledWith({
      dsn: "https://public@example.ingest.sentry.io/1",
      environment: "production",
      sendDefaultPii: false,
    });
  });
});
