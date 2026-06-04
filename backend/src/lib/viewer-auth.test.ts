import { describe, expect, it } from "vitest";
import {
  createAnonymousProofToken,
  hashAnonymousProofUserAgent,
} from "../../../shared/auth/anonymous-proof";
import { createViewerSessionToken } from "../../../shared/auth/session";
import { readAnonymousProofFromCookieHeader, readViewerFromCookieHeader } from "./viewer-auth";

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

describe("readAnonymousProofFromCookieHeader", () => {
  const secret = "proof-secret";
  const userAgent = "Mozilla/5.0 Scenario Test";

  it("returns the anonymous proof session from a valid signed cookie", () => {
    const issuedAt = Date.now();
    const token = createAnonymousProofToken(
      {
        fingerprintHash: "fingerprint-123",
        userAgentHash: hashAnonymousProofUserAgent(userAgent),
        issuedAt,
        expiresAt: issuedAt + 60_000,
      },
      secret
    );

    expect(
      readAnonymousProofFromCookieHeader(
        `foo=bar; sresim_anonymous_proof=${token}; hello=world`,
        secret,
        userAgent
      )
    ).toEqual({
      fingerprintHash: "fingerprint-123",
      userAgentHash: hashAnonymousProofUserAgent(userAgent),
      issuedAt,
      expiresAt: issuedAt + 60_000,
    });
  });

  it("returns null when the proof cookie is missing or invalid", () => {
    expect(readAnonymousProofFromCookieHeader(undefined, secret, userAgent)).toBeNull();
    expect(
      readAnonymousProofFromCookieHeader("sresim_anonymous_proof=bad-token", secret, userAgent)
    ).toBeNull();
  });
});
