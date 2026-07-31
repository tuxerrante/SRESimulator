import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("telemetry browser config route", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SENTRY_ENABLED: "true",
      NEXT_PUBLIC_SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
      NEXT_PUBLIC_SENTRY_ENVIRONMENT: "production",
      NEXT_PUBLIC_SENTRY_RELEASE: "frontend@1.2.3",
      NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE: "0.25",
      NEXT_PUBLIC_SENTRY_REPLAY_ON_ERROR_SAMPLE_RATE: "1",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns no-store JavaScript runtime bootstrap config", async () => {
    const { GET } = await import("./route");
    const response = GET();
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/javascript");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(body).toContain("__SRESIM_SENTRY_BROWSER_CONFIG__");
    expect(body).toContain('"enabled":true');
    expect(body).toContain('"dsn":"https://public@example.ingest.sentry.io/1"');
    expect(body).not.toContain("frontend@1.2.3");
    expect(body).not.toContain('"release"');
  }, 30000);
});
