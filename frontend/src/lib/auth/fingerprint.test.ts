import { describe, expect, it } from "vitest";
import { hashFingerprintSeed } from "./fingerprint";

describe("hashFingerprintSeed", () => {
  it("produces a stable digest for the same browser seed", async () => {
    const first = await hashFingerprintSeed("ua|lang|timezone|screen");
    const second = await hashFingerprintSeed("ua|lang|timezone|screen");

    expect(first).toBe(second);
    expect(first).not.toBe("ua|lang|timezone|screen");
    expect(first.length).toBeGreaterThan(10);
  });
});
