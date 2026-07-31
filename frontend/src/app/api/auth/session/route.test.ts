import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

describe("GET /api/auth/session", () => {
  afterEach(() => {
    delete process.env.AUTH_SESSION_SECRET;
    delete process.env.TURNSTILE_TEST_MODE;
    delete process.env.LOCAL_TEST_VERIFICATION_ENABLED;
    delete process.env.TURNSTILE_SITE_KEY;
    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  });

  it("does not expose local test verification from generic test mode alone", async () => {
    process.env.TURNSTILE_TEST_MODE = "true";
    process.env.TURNSTILE_SITE_KEY = "site-key";

    const response = await GET(
      new NextRequest("http://localhost/api/auth/session")
    );
    const payload = (await response.json()) as {
      turnstileConfigured: boolean;
      turnstileSiteKey: string | null;
      turnstileTestMode: boolean;
    };

    expect(payload.turnstileConfigured).toBe(true);
    expect(payload.turnstileSiteKey).toBe("site-key");
    expect(payload.turnstileTestMode).toBe(false);
  });

  it("exposes local test verification only with the explicit local enable flag", async () => {
    process.env.TURNSTILE_TEST_MODE = "true";
    process.env.LOCAL_TEST_VERIFICATION_ENABLED = "true";

    const response = await GET(
      new NextRequest("http://localhost/api/auth/session")
    );
    const payload = (await response.json()) as {
      turnstileConfigured: boolean;
      turnstileSiteKey: string | null;
      turnstileTestMode: boolean;
    };

    expect(payload.turnstileConfigured).toBe(true);
    expect(payload.turnstileSiteKey).toBe("1x00000000000000000000AA");
    expect(payload.turnstileTestMode).toBe(true);
  });
});
