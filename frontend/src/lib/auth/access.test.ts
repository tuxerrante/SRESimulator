import { describe, expect, it } from "vitest";
import { canAccessDifficulty, getViewerAccessPolicy } from "@shared/auth/access";

describe("viewer access policy", () => {
  it("allows anonymous visitors to access only easy difficulty", () => {
    expect(getViewerAccessPolicy(null).allowedDifficulties).toEqual(["easy"]);
    expect(canAccessDifficulty(null, "easy")).toBe(true);
    expect(canAccessDifficulty(null, "medium")).toBe(false);
    expect(canAccessDifficulty(null, "hard")).toBe(false);
  });

  it("allows GitHub players to access all difficulties", () => {
    const viewer = {
      kind: "github" as const,
      githubUserId: "12345",
      githubLogin: "octocat",
      displayName: "The Octocat",
      avatarUrl: null,
    };

    expect(getViewerAccessPolicy(viewer).allowedDifficulties).toEqual([
      "easy",
      "medium",
      "hard",
    ]);
    expect(canAccessDifficulty(viewer, "medium")).toBe(true);
    expect(canAccessDifficulty(viewer, "hard")).toBe(true);
  });
});
