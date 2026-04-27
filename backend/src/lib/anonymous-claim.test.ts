import { describe, expect, it } from "vitest";
import { buildAnonymousClaimKeys } from "./anonymous-claim";

describe("buildAnonymousClaimKeys", () => {
  const secret = "anti-abuse-secret";

  it("creates stable claim keys for the same browser and network signals", () => {
    const first = buildAnonymousClaimKeys(
      {
        fingerprintHash: "fingerprint-123",
        ip: "203.0.113.25",
        userAgent: "Mozilla/5.0",
      },
      secret
    );

    const second = buildAnonymousClaimKeys(
      {
        fingerprintHash: "fingerprint-123",
        ip: "203.0.113.25",
        userAgent: "Mozilla/5.0",
      },
      secret
    );

    expect(first).toStrictEqual(second);
    expect(first).toHaveLength(2);
    expect(first[0]).not.toContain("fingerprint-123");
    expect(first[0]).not.toContain("203.0.113.25");
  });

  it("keeps the fallback key stable when only the fingerprint changes", () => {
    const first = buildAnonymousClaimKeys(
      {
        fingerprintHash: "fingerprint-123",
        ip: "203.0.113.25",
        userAgent: "Mozilla/5.0",
      },
      secret
    );

    const second = buildAnonymousClaimKeys(
      {
        fingerprintHash: "fingerprint-456",
        ip: "203.0.113.25",
        userAgent: "Mozilla/5.0",
      },
      secret
    );

    expect(first[0]).not.toBe(second[0]);
    expect(first[1]).toBe(second[1]);
  });
});
