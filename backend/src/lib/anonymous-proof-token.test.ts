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
});
