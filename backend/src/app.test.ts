import { afterEach, describe, expect, it, vi } from "vitest";

describe("createApp", () => {
  const originalTrustProxyHeaders = process.env.TRUST_PROXY_HEADERS;

  afterEach(() => {
    vi.resetModules();

    if (originalTrustProxyHeaders === undefined) {
      delete process.env.TRUST_PROXY_HEADERS;
    } else {
      process.env.TRUST_PROXY_HEADERS = originalTrustProxyHeaders;
    }
  });

  it("does not trust proxy headers by default", async () => {
    delete process.env.TRUST_PROXY_HEADERS;

    const { createApp } = await import("./app");
    const app = createApp();

    expect(app.get("trust proxy")).toBe(false);
  });

  it("trusts proxy headers only when explicitly enabled", async () => {
    process.env.TRUST_PROXY_HEADERS = "true";

    const { createApp } = await import("./app");
    const app = createApp();

    expect(app.get("trust proxy")).toBe(true);
  });
});
