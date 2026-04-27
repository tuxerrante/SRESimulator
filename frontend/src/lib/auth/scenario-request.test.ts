import { describe, expect, it } from "vitest";
import { buildScenarioRequestBody } from "./scenario-request";

describe("buildScenarioRequestBody", () => {
  it("includes Turnstile and fingerprint signals for anonymous easy mode", () => {
    expect(
      buildScenarioRequestBody({
        difficulty: "easy",
        viewer: null,
        fingerprintHash: "fp_hash",
        turnstileToken: "ts_token",
      })
    ).toEqual({
      difficulty: "easy",
      fingerprintHash: "fp_hash",
      turnstileToken: "ts_token",
    });
  });

  it("omits anonymous verification fields for GitHub viewers", () => {
    expect(
      buildScenarioRequestBody({
        difficulty: "hard",
        viewer: {
          kind: "github",
          githubUserId: "12345",
          githubLogin: "octocat",
          displayName: "The Octocat",
          avatarUrl: null,
        },
        fingerprintHash: "fp_hash",
        turnstileToken: "ts_token",
      })
    ).toEqual({
      difficulty: "hard",
    });
  });
});
