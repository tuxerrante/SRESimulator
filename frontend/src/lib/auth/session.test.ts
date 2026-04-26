import { describe, expect, it } from "vitest";
import {
  createViewerSessionToken,
  readViewerSessionToken,
  type GithubViewerSession,
} from "@shared/auth/session";

describe("viewer session token", () => {
  const secret = "test-secret";
  const now = Date.now();
  const githubViewer: GithubViewerSession = {
    kind: "github",
    githubUserId: "12345",
    githubLogin: "octocat",
    displayName: "The Octocat",
    avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
    issuedAt: now,
    expiresAt: now + 86_400_000,
  };

  it("round-trips a signed GitHub viewer session", () => {
    const token = createViewerSessionToken(githubViewer, secret);

    expect(readViewerSessionToken(token, secret)).toEqual(githubViewer);
  });

  it("rejects a token with a tampered payload", () => {
    const token = createViewerSessionToken(githubViewer, secret);
    const [, signature] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...githubViewer, githubLogin: "mallory" }),
      "utf8"
    ).toString("base64url");

    expect(readViewerSessionToken(`${tamperedPayload}.${signature}`, secret)).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = createViewerSessionToken(
      {
        ...githubViewer,
        issuedAt: 100,
        expiresAt: 200,
      },
      secret
    );

    expect(readViewerSessionToken(token, secret, { now: 201 })).toBeNull();
  });
});
