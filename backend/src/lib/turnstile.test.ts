import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyTurnstileToken } from "./turnstile";

describe("verifyTurnstileToken", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TURNSTILE_SECRET_KEY;
    delete process.env.TURNSTILE_EXPECTED_HOSTNAME;
    delete process.env.TURNSTILE_TEST_MODE;
    delete process.env.LOCAL_TEST_VERIFICATION_ENABLED;
    delete process.env.NODE_ENV;
  });

  it("rejects a successful Turnstile response when the hostname does not match", async () => {
    process.env.TURNSTILE_SECRET_KEY = "real-secret";
    process.env.TURNSTILE_EXPECTED_HOSTNAME = "play.sresimulator.osadev.cloud";

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            hostname: "attacker.example.com",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        )
      )
    );

    await expect(verifyTurnstileToken("token-123", undefined)).resolves.toBe(false);
  });

  it("keeps the existing test-secret bypass in test mode", async () => {
    process.env.NODE_ENV = "test";
    process.env.TURNSTILE_SECRET_KEY = "test-secret";

    await expect(verifyTurnstileToken("pass", undefined)).resolves.toBe(true);
  });

  it("does not enable the local token bypass from generic Turnstile test mode alone", async () => {
    process.env.TURNSTILE_SECRET_KEY = "local-test-secret";
    process.env.TURNSTILE_TEST_MODE = "true";

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
    );

    await expect(verifyTurnstileToken("local-token", undefined)).resolves.toBe(false);
  });

  it("accepts non-empty tokens only when local verification is explicitly enabled", async () => {
    process.env.TURNSTILE_SECRET_KEY = "local-test-secret";
    process.env.TURNSTILE_TEST_MODE = "true";
    process.env.LOCAL_TEST_VERIFICATION_ENABLED = "true";

    await expect(verifyTurnstileToken("local-token", undefined)).resolves.toBe(true);
    await expect(verifyTurnstileToken("", undefined)).resolves.toBe(false);
  });
});
