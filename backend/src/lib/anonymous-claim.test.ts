import { describe, expect, it } from "vitest";
import { buildAnonymousClaimKey } from "./anonymous-claim";

describe("buildAnonymousClaimKey", () => {
  const secret = "anti-abuse-secret";

  it("creates a stable claim key for the same browser and network signals", () => {
    const first = buildAnonymousClaimKey(
      {
        fingerprintHash: "fingerprint-123",
        ip: "203.0.113.25",
        userAgent: "Mozilla/5.0",
      },
      secret
    );

    const second = buildAnonymousClaimKey(
      {
        fingerprintHash: "fingerprint-123",
        ip: "203.0.113.25",
        userAgent: "Mozilla/5.0",
      },
      secret
    );

    expect(first).toBe(second);
    expect(first).not.toContain("fingerprint-123");
    expect(first).not.toContain("203.0.113.25");
  });

  it("changes when the fingerprint changes", () => {
    const first = buildAnonymousClaimKey(
      {
        fingerprintHash: "fingerprint-123",
        ip: "203.0.113.25",
        userAgent: "Mozilla/5.0",
      },
      secret
    );

    const second = buildAnonymousClaimKey(
      {
        fingerprintHash: "fingerprint-456",
        ip: "203.0.113.25",
        userAgent: "Mozilla/5.0",
      },
      secret
    );

    expect(first).not.toBe(second);
  });
});
