import { afterEach, describe, expect, it } from "vitest";
import {
  ANONYMOUS_PROOF_COOKIE,
  VIEWER_SESSION_COOKIE,
} from "../../../shared/auth/constants";
import { createAnonymousProofToken, hashAnonymousProofUserAgent } from "../../../shared/auth/anonymous-proof";
import { createSignedClientIp } from "../../../shared/auth/client-ip";
import { createViewerSessionToken } from "../../../shared/auth/session";
import { getRateLimitKey, InMemorySlidingWindowStore } from "./rate-limit";

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
      "content-type": "application/json",
      ...buildSignedIpHeaders("203.0.113.10", "anti-abuse-secret"),
    },
    originalUrl: "/api/chat",
    body: {},
    ...overrides,
  };
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

  it("separates chat requests by session token even behind a shared IP", () => {
    const requestA = createRequest({
      originalUrl: "/api/chat",
      body: { sessionToken: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
    });
    const requestB = createRequest({
      originalUrl: "/api/chat",
      body: { sessionToken: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" },
    });

    expect(getRateLimitKey(requestA, "anti-abuse-secret")).not.toBe(
      getRateLimitKey(requestB, "anti-abuse-secret"),
    );
  });

  it("uses the viewer session cookie for scenario requests", () => {
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

    expect(getRateLimitKey(requestA, "anti-abuse-secret")).not.toBe(
      getRateLimitKey(requestB, "anti-abuse-secret"),
    );
  });

  it("uses the anonymous proof cookie for anonymous scenario requests", () => {
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

    expect(getRateLimitKey(requestA, "anti-abuse-secret")).not.toBe(
      getRateLimitKey(requestB, "anti-abuse-secret"),
    );
  });

  it("uses the verified signed client IP when available", () => {
    const secret = "test-hmac";
    const signedIp = "2001:db8::10";
    const signature = createSignedClientIp(signedIp, secret);

    const key = getRateLimitKey(
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

  it("falls back to req.ip when the signed client IP is missing or invalid", () => {
    const key = getRateLimitKey(
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
      getRateLimitKey(
        createRequest({
          ip: "198.51.100.10",
          headers: {},
        }),
        "test-hmac",
      ),
    );
  });

  it("prefers req.ip over socket remote address when signed headers are invalid", () => {
    delete process.env.TRUST_PROXY_HEADERS;
    const key = getRateLimitKey(
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

    const reqIpKey = getRateLimitKey(
      createRequest({ ip: "198.51.100.200", headers: {} }),
      "test-hmac",
    );
    expect(key).toBe(reqIpKey);
  });

  it("prefers socket remote address over req.ip when trust proxy headers are enabled", () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    const key = getRateLimitKey(
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

    const socketKey = getRateLimitKey(
      createRequest({
        ip: "127.0.0.1",
        socket: { remoteAddress: "10.0.0.15" },
        headers: {},
      }),
      "test-hmac",
    );
    expect(key).toBe(socketKey);
  });

  it("uses socket remote address when trust proxy headers are enabled and signed headers are missing", () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    const key = getRateLimitKey(
      createRequest({
        ip: "198.51.100.200",
        socket: { remoteAddress: "10.0.0.15" },
        headers: {},
      }),
      "test-hmac",
    );

    const socketKey = getRateLimitKey(
      createRequest({
        ip: undefined,
        socket: { remoteAddress: "10.0.0.15" },
        headers: {},
      }),
      "test-hmac",
    );
    expect(key).toBe(socketKey);
  });

  it("does not trust req.ip fallback when trust proxy headers are enabled and socket is unavailable", () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    const key = getRateLimitKey(
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

  it("falls back to socket remote address when req.ip is unavailable", () => {
    delete process.env.TRUST_PROXY_HEADERS;
    const key = getRateLimitKey(
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

    const socketKey = getRateLimitKey(
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

describe("InMemorySlidingWindowStore", () => {
  it("prunes expired cold buckets while processing new keys", async () => {
    const store = new InMemorySlidingWindowStore();
    const storeBuckets = (store as unknown as { buckets: Map<string, number[]> }).buckets;

    await store.consume("session:expired", 0, 100, 2);
    expect(storeBuckets.size).toBe(1);

    await store.consume("session:active", 101, 100, 2);

    expect(storeBuckets.size).toBe(1);
    expect(storeBuckets.has("session:expired")).toBe(false);
    expect(storeBuckets.has("session:active")).toBe(true);
  });
});
