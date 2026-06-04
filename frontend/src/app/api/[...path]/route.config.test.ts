import { afterEach, describe, expect, it, vi } from "vitest";

describe("frontend backend proxy route configuration", () => {
  afterEach(() => {
    delete process.env.TRUST_PROXY_HEADERS;
    delete process.env.ANTI_ABUSE_HMAC_SECRET;
    vi.resetModules();
  });

  it("fails fast when trusted proxy mode is enabled without anti-abuse secret", async () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    delete process.env.ANTI_ABUSE_HMAC_SECRET;
    vi.resetModules();

    await expect(import("./route")).rejects.toThrow(
      "TRUST_PROXY_HEADERS=true requires ANTI_ABUSE_HMAC_SECRET for signed client IP verification",
    );
  });
});
