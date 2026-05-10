import { afterEach, describe, expect, it } from "vitest";
import { createSignedClientIp } from "../../../shared/auth/client-ip";
import { getRateLimitKey } from "./rate-limit";

function createRequest(options?: {
  ip?: string;
  socketIp?: string;
  signedIp?: string;
  signature?: string;
}) {
  return {
    ip: options?.ip,
    socket: options?.socketIp ? { remoteAddress: options.socketIp } : undefined,
    headers: {
      "x-sresim-client-ip": options?.signedIp,
      "x-sresim-client-ip-signature": options?.signature,
    },
  };
}

describe("getRateLimitKey", () => {
  const originalTrustProxyHeaders = process.env.TRUST_PROXY_HEADERS;

  afterEach(() => {
    if (originalTrustProxyHeaders === undefined) {
      delete process.env.TRUST_PROXY_HEADERS;
    } else {
      process.env.TRUST_PROXY_HEADERS = originalTrustProxyHeaders;
    }
  });

  it("uses the verified signed client IP when available", () => {
    const secret = "test-hmac";
    const signedIp = "2001:db8::10";
    const signature = createSignedClientIp(signedIp, secret);

    const key = getRateLimitKey(
      createRequest({ ip: "10.0.0.5", signedIp, signature }),
      secret,
    );

    expect(key).not.toContain("10.0.0.5");
    expect(key).toBeTruthy();
  });

  it("falls back to req.ip when the signed client IP is missing or invalid", () => {
    const key = getRateLimitKey(
      createRequest({
        ip: "203.0.113.44",
        signedIp: "198.51.100.10",
        signature: "bad-signature",
      }),
      "test-hmac",
    );

    expect(key).toBeTruthy();
    expect(key).not.toBe(getRateLimitKey(createRequest({ ip: "198.51.100.10" }), "test-hmac"));
  });

  it("prefers req.ip over socket remote address when signed headers are invalid", () => {
    delete process.env.TRUST_PROXY_HEADERS;
    const key = getRateLimitKey(
      createRequest({
        ip: "198.51.100.200",
        socketIp: "10.0.0.15",
        signedIp: "203.0.113.10",
        signature: "bad-signature",
      }),
      "test-hmac",
    );

    const reqIpKey = getRateLimitKey(createRequest({ ip: "198.51.100.200" }), "test-hmac");
    expect(key).toBe(reqIpKey);
  });

  it("prefers socket remote address over req.ip when trust proxy headers are enabled", () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    const key = getRateLimitKey(
      createRequest({
        ip: "198.51.100.200",
        socketIp: "10.0.0.15",
        signedIp: "203.0.113.10",
        signature: "bad-signature",
      }),
      "test-hmac",
    );

    const socketKey = getRateLimitKey(
      createRequest({ ip: "127.0.0.1", socketIp: "10.0.0.15" }),
      "test-hmac",
    );
    expect(key).toBe(socketKey);
  });

  it("uses socket remote address when trust proxy headers are enabled and signed headers are missing", () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    const key = getRateLimitKey(
      createRequest({
        ip: "198.51.100.200",
        socketIp: "10.0.0.15",
      }),
      "test-hmac",
    );

    const socketKey = getRateLimitKey(
      createRequest({ socketIp: "10.0.0.15" }),
      "test-hmac",
    );
    expect(key).toBe(socketKey);
  });

  it("does not trust req.ip fallback when trust proxy headers are enabled and socket is unavailable", () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    const key = getRateLimitKey(
      createRequest({
        ip: "198.51.100.200",
        signedIp: "203.0.113.10",
        signature: "bad-signature",
      }),
      "test-hmac",
    );

    expect(key).toBe("unknown");
  });

  it("falls back to socket remote address when req.ip is unavailable", () => {
    delete process.env.TRUST_PROXY_HEADERS;
    const key = getRateLimitKey(
      createRequest({
        socketIp: "10.0.0.15",
        signedIp: "203.0.113.10",
        signature: "bad-signature",
      }),
      "test-hmac",
    );

    const socketKey = getRateLimitKey(createRequest({ socketIp: "10.0.0.15" }), "test-hmac");
    expect(key).toBe(socketKey);
  });
});
