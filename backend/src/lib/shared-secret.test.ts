import { describe, expect, it } from "vitest";
import { matchesSharedSecret } from "./shared-secret";

describe("matchesSharedSecret", () => {
  it("matches secrets after trimming surrounding whitespace", () => {
    expect(matchesSharedSecret(" shared-secret ", "  shared-secret  ")).toBe(true);
  });

  it("returns false when the normalized secret lengths differ", () => {
    expect(matchesSharedSecret("shared-secret", "shared-secret-extra")).toBe(false);
  });

  it("returns false when either secret is blank after trimming", () => {
    expect(matchesSharedSecret("   ", "shared-secret")).toBe(false);
    expect(matchesSharedSecret("shared-secret", "   ")).toBe(false);
  });
});
