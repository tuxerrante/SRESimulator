import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTOR_REF_HEADER,
  GAME_SESSION_REF_HEADER,
  REQUEST_ID_HEADER,
} from "@shared/telemetry/constants";
import { GET, POST } from "./route";

describe("frontend backend proxy route", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ANTI_ABUSE_HMAC_SECRET;
    delete process.env.BACKEND_INTERNAL_BASE_URL;
    delete process.env.TRUST_PROXY_HEADERS;
    delete process.env.PUBLIC_APP_ORIGIN;
  });

  it("preserves incoming correlation headers when proxying to the backend", async () => {
    process.env.BACKEND_INTERNAL_BASE_URL = "http://backend.test";

    const fetchMock = vi.fn().mockResolvedValue(
      new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = new NextRequest("http://localhost:3000/api/chat?stream=1", {
      method: "GET",
      headers: {
        [REQUEST_ID_HEADER]: "3a8f6d6e-32ef-4a97-8891-0bc5987888f1",
        [ACTOR_REF_HEADER]: "2c9374a5-94f3-4c58-aab5-413f28643f03",
        [GAME_SESSION_REF_HEADER]: "4d2c91fa8e7b6a10",
      },
    });

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Headers;

    expect(url).toBe("http://backend.test/api/chat?stream=1");
    expect(headers.get(REQUEST_ID_HEADER)).toBe("3a8f6d6e-32ef-4a97-8891-0bc5987888f1");
    expect(headers.get(ACTOR_REF_HEADER)).toBe("2c9374a5-94f3-4c58-aab5-413f28643f03");
    expect(headers.get(GAME_SESSION_REF_HEADER)).toBe("4d2c91fa8e7b6a10");
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
