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
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    delete process.env.GITHUB_OAUTH_CALLBACK_URL;
    delete process.env.GITHUB_OAUTH_REQUIRE_CALLBACK_MATCH;
    delete process.env.PUBLIC_APP_ORIGIN;
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

  it("reports an unverified callback without exposing OAuth as configured", async () => {
    process.env.AUTH_SESSION_SECRET = "auth-secret";
    process.env.PUBLIC_APP_ORIGIN = "https://e2e.example.com";
    process.env.GITHUB_OAUTH_REQUIRE_CALLBACK_MATCH = "true";

    const response = await GET(
      new NextRequest("http://internal:3000/api/auth/session")
    );

    await expect(response.json()).resolves.toMatchObject({
      authConfigured: false,
      authUnavailableReason: "callback_not_verified",
    });
  });

  it("reports OAuth as configured for an exact callback declaration", async () => {
    process.env.GITHUB_CLIENT_ID = "client-id";
    process.env.GITHUB_CLIENT_SECRET = "client-secret";
    process.env.AUTH_SESSION_SECRET = "auth-secret";
    process.env.PUBLIC_APP_ORIGIN = "https://e2e.example.com";
    process.env.GITHUB_OAUTH_CALLBACK_URL =
      "https://e2e.example.com/api/auth/github/callback";
    process.env.GITHUB_OAUTH_REQUIRE_CALLBACK_MATCH = "true";

    const response = await GET(
      new NextRequest("http://internal:3000/api/auth/session")
    );

    await expect(response.json()).resolves.toMatchObject({
      authConfigured: true,
      authUnavailableReason: null,
    });
  });
});
