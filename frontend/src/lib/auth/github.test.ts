import { describe, expect, it } from "vitest";
import { buildGithubAuthorizeUrl, toGithubViewer } from "./github";

describe("GitHub auth helpers", () => {
  it("builds a GitHub authorize URL with the expected callback and scope", () => {
    const url = buildGithubAuthorizeUrl({
      clientId: "client-123",
      baseUrl: "https://play.sresimulator.osadev.cloud",
      state: "csrf-state",
    });

    expect(url.toString()).toContain("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://play.sresimulator.osadev.cloud/api/auth/github/callback"
    );
    expect(url.searchParams.get("scope")).toBe("read:user user:email");
    expect(url.searchParams.get("state")).toBe("csrf-state");
  });

  it("normalizes a GitHub profile into the app viewer shape", () => {
    expect(
      toGithubViewer({
        id: 42,
        login: "octocat",
        name: "The Octocat",
        avatar_url: "https://avatars.githubusercontent.com/u/42?v=4",
      })
    ).toEqual({
      kind: "github",
      githubUserId: "42",
      githubLogin: "octocat",
      displayName: "The Octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/42?v=4",
    });
  });
});
