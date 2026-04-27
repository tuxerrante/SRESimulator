import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

describe("frontend backend proxy route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ANTI_ABUSE_HMAC_SECRET;
    delete process.env.BACKEND_INTERNAL_BASE_URL;
    delete process.env.TRUST_PROXY_HEADERS;
    delete process.env.PUBLIC_APP_ORIGIN;
  });

  it("mints an anonymous proof cookie and strips the raw fingerprint from scenario requests", async () => {
    process.env.ANTI_ABUSE_HMAC_SECRET = "test-hmac";
    process.env.BACKEND_INTERNAL_BASE_URL = "http://backend.internal";

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = new NextRequest("http://localhost/api/scenario", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Proxy Test Browser",
        "x-forwarded-for": "203.0.113.5, 10.0.0.1",
      },
      body: JSON.stringify({
        difficulty: "easy",
        turnstileToken: "token-123",
        fingerprintHash: "fingerprint-123",
      }),
    });

    const response = await POST(request);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(targetUrl).toBe("http://backend.internal/api/scenario");
    const headers = options.headers as Headers;
    expect(headers.get("x-forwarded-for")).toBeNull();
    expect(headers.get("x-sresim-client-ip")).toBeNull();
    expect(headers.get("x-sresim-client-ip-signature")).toBeNull();
    expect(headers.get("cookie")).toContain("sresim_anonymous_proof=");
    expect(options.body).toBe(JSON.stringify({ difficulty: "easy", turnstileToken: "token-123" }));
    expect(response.cookies.get("sresim_anonymous_proof")?.value).toBeTruthy();
  });

  it("only forwards a signed client IP when proxy header trust is explicitly enabled", async () => {
    process.env.ANTI_ABUSE_HMAC_SECRET = "test-hmac";
    process.env.BACKEND_INTERNAL_BASE_URL = "http://backend.internal";
    process.env.TRUST_PROXY_HEADERS = "true";

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = new NextRequest("https://play.example.com/api/scenario", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Proxy Test Browser",
        "x-forwarded-for": "203.0.113.5, 10.0.0.1",
      },
      body: JSON.stringify({
        difficulty: "easy",
        turnstileToken: "token-123",
        fingerprintHash: "fingerprint-123",
      }),
    });

    await POST(request);

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Headers;
    expect(headers.get("x-sresim-client-ip")).toBe("203.0.113.5");
    expect(headers.get("x-sresim-client-ip-signature")).toBeTruthy();
  });
});
