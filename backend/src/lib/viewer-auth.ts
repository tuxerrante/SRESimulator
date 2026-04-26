import {
  ANONYMOUS_PROOF_COOKIE,
  VIEWER_SESSION_COOKIE,
} from "../../../shared/auth/constants";
import {
  readAnonymousProofToken,
  type AnonymousProofSession,
} from "../../../shared/auth/anonymous-proof";
import { readViewerSessionToken } from "../../../shared/auth/session";
import type { GithubViewer } from "../../../shared/auth/viewer";

function parseCookieHeader(cookieHeader: string | undefined): string[] {
  if (!cookieHeader) {
    return [];
  }

  return cookieHeader
    .split(";")
    .map((cookie) => cookie.trim())
    .filter(Boolean);
}

function readCookieValue(cookieHeader: string | undefined, name: string): string | null {
  const cookie = parseCookieHeader(cookieHeader).find((value) =>
    value.startsWith(`${name}=`)
  );
  return cookie ? cookie.slice(`${name}=`.length) : null;
}

export function readViewerFromCookieHeader(
  cookieHeader: string | undefined,
  secret: string
): GithubViewer | null {
  const token = readCookieValue(cookieHeader, VIEWER_SESSION_COOKIE);
  if (!token) {
    return null;
  }

  const session = readViewerSessionToken(token, secret);
  if (!session) {
    return null;
  }

  return {
    kind: session.kind,
    githubUserId: session.githubUserId,
    githubLogin: session.githubLogin,
    displayName: session.displayName,
    avatarUrl: session.avatarUrl,
  };
}

export function readAnonymousProofFromCookieHeader(
  cookieHeader: string | undefined,
  secret: string,
  userAgent: string
): AnonymousProofSession | null {
  const token = readCookieValue(cookieHeader, ANONYMOUS_PROOF_COOKIE);
  if (!token) {
    return null;
  }

  return readAnonymousProofToken(token, secret, { userAgent });
}
