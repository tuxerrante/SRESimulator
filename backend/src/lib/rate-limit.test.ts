import { describe, expect, it } from "vitest";
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

  it("prefers the socket remote address over req.ip when signed headers are invalid", () => {
    const key = getRateLimitKey(
      createRequest({
        ip: "198.51.100.200",
        socketIp: "10.0.0.15",
        signedIp: "203.0.113.10",
        signature: "bad-signature",
      }),
      "test-hmac",
    );

    const socketKey = getRateLimitKey(createRequest({ ip: "127.0.0.1", socketIp: "10.0.0.15" }), "test-hmac");
    expect(key).toBe(socketKey);
  });
});
