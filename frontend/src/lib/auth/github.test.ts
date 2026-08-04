import { describe, expect, it } from "vitest";
import {
  buildGithubAuthorizeUrl,
  buildGithubCallbackUrl,
  resolveGithubOAuthConfig,
  toGithubViewer,
} from "./github";

describe("GitHub auth helpers", () => {
  it("builds a GitHub authorize URL with the expected callback and scope", () => {
    const url = buildGithubAuthorizeUrl({
      clientId: "client-123",
      callbackUrl: buildGithubCallbackUrl("https://play.sresimulator.osadev.cloud"),
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

  it("requires an exact declared callback when callback verification is enabled", () => {
    expect(
      resolveGithubOAuthConfig({
        baseUrl: "https://e2e.example.com",
        clientId: "client-123",
        clientSecret: "client-secret",
        authSecret: "auth-secret",
        configuredCallbackUrl: "https://play.example.com/api/auth/github/callback",
        requireCallbackMatch: true,
      })
    ).toEqual({
      configured: false,
      reason: "callback_not_verified",
    });

    expect(
      resolveGithubOAuthConfig({
        baseUrl: "https://e2e.example.com",
        clientId: "client-123",
        clientSecret: "client-secret",
        authSecret: "auth-secret",
        configuredCallbackUrl: "https://e2e.example.com/api/auth/github/callback",
        requireCallbackMatch: true,
      })
    ).toMatchObject({
      configured: true,
      callbackUrl: "https://e2e.example.com/api/auth/github/callback",
    });
  });

  it("keeps undeclared callback verification backward compatible unless required", () => {
    expect(
      resolveGithubOAuthConfig({
        baseUrl: "https://play.example.com",
        clientId: "client-123",
        clientSecret: "client-secret",
        authSecret: "auth-secret",
      })
    ).toMatchObject({ configured: true });

    expect(
      resolveGithubOAuthConfig({
        baseUrl: "https://play.example.com",
        clientId: "client-123",
        clientSecret: "client-secret",
        authSecret: "auth-secret",
        requireCallbackMatch: true,
      })
    ).toEqual({
      configured: false,
      reason: "callback_not_verified",
    });

    expect(
      resolveGithubOAuthConfig({
        baseUrl: "https://play.example.com",
        requireCallbackMatch: true,
      })
    ).toEqual({
      configured: false,
      reason: "callback_not_verified",
    });
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
