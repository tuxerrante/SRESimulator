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
import { getRateLimitKey, InMemorySlidingWindowStore } from "./rate-limit";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Mirrors the module-private sweep interval in rate-limit.ts. */
const IN_MEMORY_SWEEP_INTERVAL = 256;

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

describe("InMemorySlidingWindowStore", () => {
  it("periodically prunes expired cold buckets while processing new keys", async () => {
    const store = new InMemorySlidingWindowStore();
    const storeBuckets = (store as unknown as { buckets: Map<string, number[]> }).buckets;
    const storeState = store as unknown as { operationsSinceSweep: number };

    await store.consume("session:expired", 0, 100, 2);
    expect(storeBuckets.size).toBe(1);

    storeState.operationsSinceSweep = 255;
    await store.consume("session:active", 101, 100, 2);

    expect(storeBuckets.size).toBe(1);
    expect(storeBuckets.has("session:expired")).toBe(false);
    expect(storeBuckets.has("session:active")).toBe(true);
  });

  // Until the global AI budget arrived, every key in this store was a
  // per-identity window of the same duration, so the sweep could reuse the
  // current call's cutoff for all of them. The budget puts a 24-hour key and a
  // 60-second key in one map, and a borrowed cutoff evicts the long window's
  // history.
  it("prunes each bucket against its own window, not the caller's", async () => {
    const store = new InMemorySlidingWindowStore();
    const storeBuckets = (store as unknown as { buckets: Map<string, unknown> }).buckets;
    const storeState = store as unknown as { operationsSinceSweep: number };

    await store.consume("global:ai:day:2026-09-19", 0, DAY_MS, 1000);
    storeState.operationsSinceSweep = IN_MEMORY_SWEEP_INTERVAL - 1;

    // A minute-window request two minutes later: the day is nowhere near over.
    await store.consume("global:ai:minute", 2 * MINUTE_MS, MINUTE_MS, 20);

    expect(storeBuckets.has("global:ai:day:2026-09-19")).toBe(true);
  });

  // The consequence, asserted through the decision rather than the map: a
  // shared daily cap that resets under ordinary minute traffic is not a cap,
  // and the provider account it protects is spent by the players who arrive
  // after the sweep.
  it("keeps the daily cap enforced across a day of minute-window traffic", async () => {
    const store = new InMemorySlidingWindowStore();
    const dayKey = "global:ai:day:2026-09-19";
    let now = 0;

    for (let request = 0; request < 3; request += 1) {
      now += MINUTE_MS;
      await store.consume("global:ai:minute", now, MINUTE_MS, 20);
      await store.consume(dayKey, now, DAY_MS, 3);
    }

    // Enough minute-window traffic to trip several sweeps, still the same day.
    for (let sweep = 0; sweep < 3 * IN_MEMORY_SWEEP_INTERVAL; sweep += 1) {
      now += 1_000;
      await store.consume("global:ai:minute", now, MINUTE_MS, 20);
    }

    const decision = await store.consume(dayKey, now, DAY_MS, 3);
    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
  });

  // `record` exists because `consume` adds nothing once a window is full, so
  // charging an already-in-flight request through it would leave exactly the
  // requests that overran the cap unrecorded.
  it("adds an entry past capacity and dates the window from its front", async () => {
    const store = new InMemorySlidingWindowStore();
    const key = "global:ai:minute";

    expect((await store.consume(key, 0, MINUTE_MS, 2)).allowed).toBe(true);
    expect((await store.consume(key, 0, MINUTE_MS, 2)).allowed).toBe(true);
    // The positive arm: the window really is full, so what `record` does next
    // is the property under test and not an artefact of an empty bucket.
    expect((await store.consume(key, 0, MINUTE_MS, 2)).allowed).toBe(false);

    // Two retries, because one is not enough to refill a two-slot window once
    // the originals expire -- and it is the refill that proves the recording
    // outlives the requests it overran.
    const recorded = await store.record(key, 30_000, MINUTE_MS, 2);
    await store.record(key, 30_000, MINUTE_MS, 2);

    // Floors at zero rather than going negative: an over-capacity window has
    // to answer the same shape an empty one does.
    expect(recorded.remaining).toBe(0);
    // Dated from the oldest surviving entry, not from `now`. Over capacity the
    // window drains from its front, so `now + windowMs` would promise a slot
    // 30s later than the one that actually frees up.
    expect(recorded.resetAtMs).toBe(MINUTE_MS);

    // The harm the recording exists to prevent: once the two original entries
    // expire a consume would find an empty window and wave the caller through,
    // past a cap the recorded request already overran.
    expect((await store.consume(key, 61_000, MINUTE_MS, 2)).allowed).toBe(false);
  });
});
