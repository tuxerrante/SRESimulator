import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANONYMOUS_PROOF_COOKIE,
  VIEWER_SESSION_COOKIE,
} from "../../../shared/auth/constants";
import {
  createAnonymousProofToken,
  hashAnonymousProofUserAgent,
} from "../../../shared/auth/anonymous-proof";
import { createSignedClientIp } from "../../../shared/auth/client-ip";
import { createViewerSessionToken } from "../../../shared/auth/session";
import { getRateLimitKey } from "./rate-limit";

interface TestRequest {
  ip?: string;
  socket?: {
    remoteAddress?: string;
  };
  headers: Record<string, string | string[] | undefined>;
  originalUrl?: string;
  body?: unknown;
}

function buildSignedIpHeaders(ip: string, secret: string): Record<string, string> {
  return {
    "x-sresim-client-ip": ip,
    "x-sresim-client-ip-signature": createSignedClientIp(ip, secret),
  };
}

function createRequest(overrides: Partial<TestRequest> = {}): TestRequest {
  return {
    ip: "10.0.0.10",
    socket: { remoteAddress: "10.0.0.20" },
    headers: {
      ...buildSignedIpHeaders("203.0.113.10", "anti-abuse-secret"),
    },
    originalUrl: "/api/chat",
    body: {},
    ...overrides,
  };
}

async function createStoredSessionToken(label: string): Promise<string> {
  const storageModule = await import("./storage");
  await storageModule.initStorage();
  return storageModule.getSessionStore().create("easy", label);
}

async function resolveKey(
  request: TestRequest,
  antiAbuseSecret = "anti-abuse-secret",
  authSessionSecret?: string,
): Promise<string> {
  return getRateLimitKey(request, antiAbuseSecret, authSessionSecret);
}

describe("getRateLimitKey", () => {
  const originalTrustProxyHeaders = process.env.TRUST_PROXY_HEADERS;
  const originalAuthSessionSecret = process.env.AUTH_SESSION_SECRET;

  afterEach(() => {
    if (originalTrustProxyHeaders === undefined) {
      delete process.env.TRUST_PROXY_HEADERS;
    } else {
      process.env.TRUST_PROXY_HEADERS = originalTrustProxyHeaders;
    }

    if (originalAuthSessionSecret === undefined) {
      delete process.env.AUTH_SESSION_SECRET;
    } else {
      process.env.AUTH_SESSION_SECRET = originalAuthSessionSecret;
    }
  });

  it("separates chat requests by stored session token even behind a shared IP", async () => {
    const sessionTokenA = await createStoredSessionToken("Session A");
    const sessionTokenB = await createStoredSessionToken("Session B");
    const requestA = createRequest({
      originalUrl: "/api/chat",
      body: { sessionToken: sessionTokenA },
    });
    const requestB = createRequest({
      originalUrl: "/api/chat",
      body: { sessionToken: sessionTokenB },
    });

    const keyA = await resolveKey(requestA);
    const keyB = await resolveKey(requestB);
    expect(keyA).not.toBe(keyB);
  });

  it("uses stored sessionToken identity for AI routes beyond hardcoded prefixes", async () => {
    const sessionTokenA = await createStoredSessionToken("New Route Session A");
    const sessionTokenB = await createStoredSessionToken("New Route Session B");
    const requestA = createRequest({
      originalUrl: "/api/ai/new-route",
      body: { sessionToken: sessionTokenA },
    });
    const requestB = createRequest({
      originalUrl: "/api/ai/new-route",
      body: { sessionToken: sessionTokenB },
    });

    const keyA = await resolveKey(requestA);
    const keyB = await resolveKey(requestB);
    expect(keyA).not.toBe(keyB);
  });

  it("falls back to the IP bucket when chat sessionToken is not a UUID", async () => {
    const fallbackRequest = createRequest({
      originalUrl: "/api/chat",
      body: { sessionToken: "not-a-uuid" },
    });
    const ipRequest = createRequest({
      originalUrl: "/api/chat",
      body: {},
    });

    expect(await resolveKey(fallbackRequest)).toBe(await resolveKey(ipRequest));
  });

  it("falls back to the IP bucket when chat sessionToken is not a stored session", async () => {
    await createStoredSessionToken("Existing Session");
    const fallbackRequest = createRequest({
      originalUrl: "/api/chat",
      body: { sessionToken: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
    });
    const ipRequest = createRequest({
      originalUrl: "/api/chat",
      body: {},
    });

    const fallbackKey = await resolveKey(fallbackRequest);
    const ipKey = await resolveKey(ipRequest);
    expect(fallbackKey).toBe(ipKey);
  });

  it("ignores stored session tokens for scenario requests", async () => {
    const sessionToken = await createStoredSessionToken("Scenario Request Session");
    const scenarioRequest = createRequest({
      originalUrl: "/api/scenario",
      body: { sessionToken },
    });
    const ipRequest = createRequest({
      originalUrl: "/api/scenario",
      body: {},
    });

    expect(await resolveKey(scenarioRequest)).toBe(await resolveKey(ipRequest));
  });

  it("uses the viewer session cookie for scenario requests", async () => {
    process.env.AUTH_SESSION_SECRET = "auth-session-secret";
    const now = Date.now();
    const viewerCookieA = createViewerSessionToken({
      kind: "github",
      githubUserId: "viewer-a",
      githubLogin: "viewer-a",
      displayName: "Viewer A",
      avatarUrl: null,
      issuedAt: now,
      expiresAt: now + 60_000,
    }, "auth-session-secret");
    const viewerCookieB = createViewerSessionToken({
      kind: "github",
      githubUserId: "viewer-b",
      githubLogin: "viewer-b",
      displayName: "Viewer B",
      avatarUrl: null,
      issuedAt: now,
      expiresAt: now + 60_000,
    }, "auth-session-secret");

    const requestA = createRequest({
      originalUrl: "/api/scenario",
      headers: {
        ...createRequest().headers,
        cookie: `${VIEWER_SESSION_COOKIE}=${viewerCookieA}`,
      },
    });
    const requestB = createRequest({
      originalUrl: "/api/scenario",
      headers: {
        ...createRequest().headers,
        cookie: `${VIEWER_SESSION_COOKIE}=${viewerCookieB}`,
      },
    });

    expect(await resolveKey(requestA)).not.toBe(await resolveKey(requestB));
  });

  it("warns once when viewer cookie exists but AUTH_SESSION_SECRET is missing", async () => {
    const now = Date.now();
    const viewerCookie = createViewerSessionToken({
      kind: "github",
      githubUserId: "viewer-a",
      githubLogin: "viewer-a",
      displayName: "Viewer A",
      avatarUrl: null,
      issuedAt: now,
      expiresAt: now + 60_000,
    }, "auth-session-secret");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const request = createRequest({
      originalUrl: "/api/scenario",
      headers: {
        ...createRequest().headers,
        cookie: `${VIEWER_SESSION_COOKIE}=${viewerCookie}`,
      },
    });

    await resolveKey(request, "anti-abuse-secret", undefined);
    await resolveKey(request, "anti-abuse-secret", undefined);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("uses the anonymous proof cookie for anonymous scenario requests", async () => {
    const userAgent = "vitest-agent";
    const now = Date.now();
    const anonymousProofA = createAnonymousProofToken({
      fingerprintHash: "fingerprint-a",
      userAgentHash: hashAnonymousProofUserAgent(userAgent),
      issuedAt: now,
      expiresAt: now + 60_000,
    }, "anti-abuse-secret");
    const anonymousProofB = createAnonymousProofToken({
      fingerprintHash: "fingerprint-b",
      userAgentHash: hashAnonymousProofUserAgent(userAgent),
      issuedAt: now,
      expiresAt: now + 60_000,
    }, "anti-abuse-secret");

    const requestA = createRequest({
      originalUrl: "/api/scenario",
      headers: {
        ...createRequest().headers,
        "user-agent": userAgent,
        cookie: `${ANONYMOUS_PROOF_COOKIE}=${anonymousProofA}`,
      },
    });
    const requestB = createRequest({
      originalUrl: "/api/scenario",
      headers: {
        ...createRequest().headers,
        "user-agent": userAgent,
        cookie: `${ANONYMOUS_PROOF_COOKIE}=${anonymousProofB}`,
      },
    });

    expect(await resolveKey(requestA)).not.toBe(await resolveKey(requestB));
  });

  it("uses the verified signed client IP when available", async () => {
    const secret = "test-hmac";
    const signedIp = "2001:db8::10";
    const signature = createSignedClientIp(signedIp, secret);

    const key = await resolveKey(
      createRequest({
        ip: "10.0.0.5",
        headers: {
          ...createRequest().headers,
          "x-sresim-client-ip": signedIp,
          "x-sresim-client-ip-signature": signature,
        },
      }),
      secret,
    );

    expect(key).not.toContain("10.0.0.5");
    expect(key).toBeTruthy();
  });

  it("falls back to req.ip when the signed client IP is missing or invalid", async () => {
    const key = await resolveKey(
      createRequest({
        ip: "203.0.113.44",
        headers: {
          ...createRequest().headers,
          "x-sresim-client-ip": "198.51.100.10",
          "x-sresim-client-ip-signature": "bad-signature",
        },
      }),
      "test-hmac",
    );

    expect(key).toBeTruthy();
    expect(key).not.toBe(
      await resolveKey(
        createRequest({
          ip: "198.51.100.10",
          headers: {},
        }),
        "test-hmac",
      ),
    );
  });

  it("prefers req.ip over socket remote address when signed headers are invalid", async () => {
    delete process.env.TRUST_PROXY_HEADERS;
    const key = await resolveKey(
      createRequest({
        ip: "198.51.100.200",
        socket: { remoteAddress: "10.0.0.15" },
        headers: {
          "x-sresim-client-ip": "203.0.113.10",
          "x-sresim-client-ip-signature": "bad-signature",
        },
      }),
      "test-hmac",
    );

    const reqIpKey = await resolveKey(
      createRequest({ ip: "198.51.100.200", headers: {} }),
      "test-hmac",
    );
    expect(key).toBe(reqIpKey);
  });

  it("prefers socket remote address over req.ip when trust proxy headers are enabled", async () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    const key = await resolveKey(
      createRequest({
        ip: "198.51.100.200",
        socket: { remoteAddress: "10.0.0.15" },
        headers: {
          "x-sresim-client-ip": "203.0.113.10",
          "x-sresim-client-ip-signature": "bad-signature",
        },
      }),
      "test-hmac",
    );

    const socketKey = await resolveKey(
      createRequest({
        ip: "127.0.0.1",
        socket: { remoteAddress: "10.0.0.15" },
        headers: {},
      }),
      "test-hmac",
    );
    expect(key).toBe(socketKey);
  });

  it("uses socket remote address when trust proxy headers are enabled and signed headers are missing", async () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    const key = await resolveKey(
      createRequest({
        ip: "198.51.100.200",
        socket: { remoteAddress: "10.0.0.15" },
        headers: {},
      }),
      "test-hmac",
    );

    const socketKey = await resolveKey(
      createRequest({
        ip: undefined,
        socket: { remoteAddress: "10.0.0.15" },
        headers: {},
      }),
      "test-hmac",
    );
    expect(key).toBe(socketKey);
  });

  it("does not trust req.ip fallback when trust proxy headers are enabled and socket is unavailable", async () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    const key = await resolveKey(
      createRequest({
        ip: "198.51.100.200",
        socket: undefined,
        headers: {
          "x-sresim-client-ip": "203.0.113.10",
          "x-sresim-client-ip-signature": "bad-signature",
        },
      }),
      "test-hmac",
    );

    expect(key).toBe("unknown");
  });

  it("falls back to socket remote address when req.ip is unavailable", async () => {
    delete process.env.TRUST_PROXY_HEADERS;
    const key = await resolveKey(
      createRequest({
        ip: undefined,
        socket: { remoteAddress: "10.0.0.15" },
        headers: {
          "x-sresim-client-ip": "203.0.113.10",
          "x-sresim-client-ip-signature": "bad-signature",
        },
      }),
      "test-hmac",
    );

    const socketKey = await resolveKey(
      createRequest({
        ip: undefined,
        socket: { remoteAddress: "10.0.0.15" },
        headers: {},
      }),
      "test-hmac",
    );
    expect(key).toBe(socketKey);
  });
});
