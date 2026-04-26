import { VIEWER_SESSION_COOKIE } from "../../../shared/auth/constants";
import { readViewerSessionToken } from "../../../shared/auth/session";
import type { GithubViewer } from "../../../shared/auth/viewer";

export function readViewerFromCookieHeader(
  cookieHeader: string | undefined,
  secret: string
): GithubViewer | null {
  if (!cookieHeader) {
    return null;
  }

  const cookies = cookieHeader
    .split(";")
    .map((cookie) => cookie.trim())
    .filter(Boolean);

  const sessionCookie = cookies.find((cookie) =>
    cookie.startsWith(`${VIEWER_SESSION_COOKIE}=`)
  );
  if (!sessionCookie) {
    return null;
  }

  const token = sessionCookie.slice(`${VIEWER_SESSION_COOKIE}=`.length);
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
