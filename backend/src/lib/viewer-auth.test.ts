import { describe, expect, it } from "vitest";
import { createViewerSessionToken } from "../../../shared/auth/session";
import { readViewerFromCookieHeader } from "./viewer-auth";

describe("readViewerFromCookieHeader", () => {
  const secret = "test-secret";

  it("returns the GitHub viewer from a valid signed cookie", () => {
    const token = createViewerSessionToken(
      {
        kind: "github",
        githubUserId: "12345",
        githubLogin: "octocat",
        displayName: "The Octocat",
        avatarUrl: null,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
      secret
    );

    expect(
      readViewerFromCookieHeader(`foo=bar; sresim_viewer_session=${token}; hello=world`, secret)
    ).toEqual({
      kind: "github",
      githubUserId: "12345",
      githubLogin: "octocat",
      displayName: "The Octocat",
      avatarUrl: null,
    });
  });

  it("returns null when the cookie is missing or invalid", () => {
    expect(readViewerFromCookieHeader(undefined, secret)).toBeNull();
    expect(readViewerFromCookieHeader("sresim_viewer_session=bad-token", secret)).toBeNull();
  });
});
