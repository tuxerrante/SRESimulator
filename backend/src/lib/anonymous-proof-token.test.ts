import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createAnonymousProofToken,
  hashAnonymousProofUserAgent,
  readAnonymousProofToken,
} from "../../../shared/auth/anonymous-proof";

describe("anonymous proof token helpers", () => {
  const secret = "test-proof-secret";
  const userAgent = "Mozilla/5.0 Test Browser";

  it("round-trips a signed proof token for the same user agent", () => {
    const now = Date.now();
    const token = createAnonymousProofToken(
      {
        fingerprintHash: "fingerprint-123",
        userAgentHash: hashAnonymousProofUserAgent(userAgent),
        issuedAt: now,
        expiresAt: now + 60_000,
      },
      secret
    );

    expect(readAnonymousProofToken(token, secret, { userAgent, now })).toEqual({
      fingerprintHash: "fingerprint-123",
      userAgentHash: hashAnonymousProofUserAgent(userAgent),
      issuedAt: now,
      expiresAt: now + 60_000,
    });
  });

  it("rejects a token when the user agent hash no longer matches", () => {
    const now = Date.now();
    const token = createAnonymousProofToken(
      {
        fingerprintHash: "fingerprint-123",
        userAgentHash: hashAnonymousProofUserAgent(userAgent),
        issuedAt: now,
        expiresAt: now + 60_000,
      },
      secret
    );

    expect(
      readAnonymousProofToken(token, secret, {
        userAgent: "Different Browser",
        now,
      })
    ).toBeNull();
  });

  it("rejects tokens with extra dot-separated segments", () => {
    const now = Date.now();
    const token = createAnonymousProofToken(
      {
        fingerprintHash: "fingerprint-123",
        userAgentHash: hashAnonymousProofUserAgent(userAgent),
        issuedAt: now,
        expiresAt: now + 60_000,
      },
      secret
    );

    expect(readAnonymousProofToken(`${token}.extra`, secret, { userAgent, now })).toBeNull();
  });

  it("rejects tokens with an invalid decoded payload shape", () => {
    const now = Date.now();
    const badPayload = Buffer.from(
      JSON.stringify({
        fingerprintHash: "fingerprint-123",
        userAgentHash: hashAnonymousProofUserAgent(userAgent),
        issuedAt: now,
        expiresAt: "not-a-number",
      }),
      "utf8"
    ).toString("base64url");
    const signature = createHmac("sha256", secret).update(badPayload).digest("base64url");

    expect(readAnonymousProofToken(`${badPayload}.${signature}`, secret, { userAgent, now })).toBeNull();
  });
});
