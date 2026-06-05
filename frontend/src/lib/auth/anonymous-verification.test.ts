import { describe, expect, it } from "vitest";
import { getAnonymousVerificationMessage } from "./anonymous-verification";

describe("getAnonymousVerificationMessage", () => {
  it("stays silent before captcha verification completes", () => {
    expect(
      getAnonymousVerificationMessage({
        turnstileConfigured: true,
        turnstileVerified: false,
        turnstileTestMode: false,
      })
    ).toBeNull();
  });

  it("keeps the ready state generic after captcha verification", () => {
    expect(
      getAnonymousVerificationMessage({
        turnstileConfigured: true,
        turnstileVerified: true,
        turnstileTestMode: false,
      })
    ).toBe("Verification complete. You can start your anonymous Easy run.");
  });

  it("preserves the unavailable message when Turnstile is not configured", () => {
    expect(
      getAnonymousVerificationMessage({
        turnstileConfigured: false,
        turnstileVerified: false,
        turnstileTestMode: false,
      })
    ).toBe("Anonymous guest mode is unavailable until Turnstile is configured.");
  });

  it("provides local test mode guidance before verification", () => {
    expect(
      getAnonymousVerificationMessage({
        turnstileConfigured: true,
        turnstileVerified: false,
        turnstileTestMode: true,
      })
    ).toBe("Local test mode is enabled. Use local verification to unlock anonymous Easy mode.");
  });

  it("shows local test mode completion after verification", () => {
    expect(
      getAnonymousVerificationMessage({
        turnstileConfigured: true,
        turnstileVerified: true,
        turnstileTestMode: true,
      })
    ).toBe("Local test verification complete. You can start your anonymous Easy run.");
  });
});
