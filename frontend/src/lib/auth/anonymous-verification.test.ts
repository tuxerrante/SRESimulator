import { describe, expect, it } from "vitest";
import { getAnonymousVerificationMessage } from "./anonymous-verification";

describe("getAnonymousVerificationMessage", () => {
  it("stays silent before captcha verification completes", () => {
    expect(
      getAnonymousVerificationMessage({
        turnstileConfigured: true,
        turnstileVerified: false,
      })
    ).toBeNull();
  });

  it("keeps the ready state generic after captcha verification", () => {
    expect(
      getAnonymousVerificationMessage({
        turnstileConfigured: true,
        turnstileVerified: true,
      })
    ).toBe("Verification complete. You can start your anonymous Easy run.");
  });

  it("preserves the unavailable message when Turnstile is not configured", () => {
    expect(
      getAnonymousVerificationMessage({
        turnstileConfigured: false,
        turnstileVerified: false,
      })
    ).toBe("Anonymous guest mode is unavailable until Turnstile is configured.");
  });
});
