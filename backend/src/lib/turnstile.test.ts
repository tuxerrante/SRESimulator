import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyTurnstileToken } from "./turnstile";

describe("verifyTurnstileToken", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TURNSTILE_SECRET_KEY;
    delete process.env.TURNSTILE_EXPECTED_HOSTNAME;
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
});
