import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentryMocks = vi.hoisted(() => ({
  withSentryConfig: vi.fn((nextConfig: unknown, options: unknown) => ({
    nextConfig,
    options,
  })),
}));

vi.mock("@sentry/nextjs", () => ({
  withSentryConfig: sentryMocks.withSentryConfig,
}));

describe("frontend next config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.SENTRY_AUTH_TOKEN;
    delete process.env.SENTRY_ORG;
    delete process.env.SENTRY_PROJECT;
    delete process.env.SENTRY_RELEASE;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("wraps Next config and disables source map upload when build credentials are absent", async () => {
    const config = await import("../next.config");

    expect(config.default).toEqual({
      nextConfig: expect.any(Object),
      options: expect.objectContaining({
        authToken: undefined,
        org: undefined,
        project: undefined,
        sourcemaps: {
          disable: true,
        },
      }),
    });
    expect(sentryMocks.withSentryConfig).toHaveBeenCalledTimes(1);
  });

  it("enables source map upload settings when build credentials are present", async () => {
    process.env.SENTRY_AUTH_TOKEN = "token";
    process.env.SENTRY_ORG = "acme-org";
    process.env.SENTRY_PROJECT = "sre-simulator-frontend";
    process.env.SENTRY_RELEASE = "frontend@1.2.3";

    const config = await import("../next.config");

    expect(config.default).toEqual({
      nextConfig: expect.any(Object),
      options: expect.objectContaining({
        authToken: "token",
        org: "acme-org",
        project: "sre-simulator-frontend",
        release: {
          name: "frontend@1.2.3",
        },
        sourcemaps: {
          disable: false,
        },
        widenClientFileUpload: true,
      }),
    });
  });
});
