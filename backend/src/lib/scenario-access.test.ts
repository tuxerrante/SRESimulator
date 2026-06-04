import { describe, expect, it } from "vitest";
import { evaluateScenarioAccess } from "./scenario-access";

describe("evaluateScenarioAccess", () => {
  it("allows GitHub players to access hard scenarios", () => {
    expect(
      evaluateScenarioAccess({
        difficulty: "hard",
        viewer: {
          kind: "github",
          githubUserId: "12345",
          githubLogin: "octocat",
          displayName: "The Octocat",
          avatarUrl: null,
        },
        hasValidTurnstileToken: false,
        hasAnonymousProof: false,
        hasActiveAnonymousClaim: false,
      })
    ).toEqual({
      allowed: true,
      sessionIdentityKind: "github",
    });
  });

  it("blocks anonymous medium and hard scenarios", () => {
    expect(
      evaluateScenarioAccess({
        difficulty: "medium",
        viewer: null,
        hasValidTurnstileToken: true,
        hasAnonymousProof: true,
        hasActiveAnonymousClaim: false,
      })
    ).toEqual({
      allowed: false,
      code: "github_required",
      message: "GitHub login is required for medium and hard scenarios.",
    });
  });

  it("requires both Turnstile and anonymous verification proof for anonymous easy mode", () => {
    expect(
      evaluateScenarioAccess({
        difficulty: "easy",
        viewer: null,
        hasValidTurnstileToken: false,
        hasAnonymousProof: false,
        hasActiveAnonymousClaim: false,
      })
    ).toEqual({
      allowed: false,
      code: "anonymous_verification_required",
      message: "Anonymous Easy mode requires captcha-backed verification.",
    });
  });

  it("blocks anonymous easy replays within the daily window", () => {
    expect(
      evaluateScenarioAccess({
        difficulty: "easy",
        viewer: null,
        hasValidTurnstileToken: true,
        hasAnonymousProof: true,
        hasActiveAnonymousClaim: true,
      })
    ).toEqual({
      allowed: false,
      code: "anonymous_daily_limit_reached",
      message: "Anonymous Easy mode is limited to one run per day.",
    });
  });

  it("allows a verified anonymous easy run", () => {
    expect(
      evaluateScenarioAccess({
        difficulty: "easy",
        viewer: null,
        hasValidTurnstileToken: true,
        hasAnonymousProof: true,
        hasActiveAnonymousClaim: false,
      })
    ).toEqual({
      allowed: true,
      sessionIdentityKind: "anonymous",
    });
  });
});
