import type { GithubViewer } from "@shared/auth/viewer";

interface BuildGithubAuthorizeUrlOptions {
  clientId: string;
  callbackUrl: string;
  state: string;
}

interface ResolveGithubOAuthConfigOptions {
  baseUrl: string;
  clientId?: string;
  clientSecret?: string;
  authSecret?: string;
  configuredCallbackUrl?: string;
  requireCallbackMatch?: boolean;
}

interface GithubProfileResponse {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

export type GithubAuthUnavailableReason = "not_configured" | "callback_not_verified";

export type GithubOAuthConfigResult =
  | {
      configured: true;
      clientId: string;
      clientSecret: string;
      authSecret: string;
      callbackUrl: string;
    }
  | {
      configured: false;
      reason: GithubAuthUnavailableReason;
    };

export function buildGithubCallbackUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/api/auth/github/callback`;
}

export function buildGithubAuthorizeUrl({
  clientId,
  callbackUrl,
  state,
}: BuildGithubAuthorizeUrlOptions): URL {
  const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", callbackUrl);
  authorizeUrl.searchParams.set("scope", "read:user user:email");
  authorizeUrl.searchParams.set("state", state);
  return authorizeUrl;
}

export function resolveGithubOAuthConfig({
  baseUrl,
  clientId,
  clientSecret,
  authSecret,
  configuredCallbackUrl,
  requireCallbackMatch = false,
}: ResolveGithubOAuthConfigOptions): GithubOAuthConfigResult {
  const callbackUrl = buildGithubCallbackUrl(baseUrl);
  const declaredCallbackUrl = configuredCallbackUrl?.trim();
  if (
    (declaredCallbackUrl && declaredCallbackUrl !== callbackUrl) ||
    (requireCallbackMatch && !declaredCallbackUrl)
  ) {
    return { configured: false, reason: "callback_not_verified" };
  }

  if (!clientId || !clientSecret || !authSecret) {
    return { configured: false, reason: "not_configured" };
  }

  return {
    configured: true,
    clientId,
    clientSecret,
    authSecret,
    callbackUrl,
  };
}

export function toGithubViewer(profile: GithubProfileResponse): GithubViewer {
  return {
    kind: "github",
    githubUserId: String(profile.id),
    githubLogin: profile.login,
    displayName: profile.name?.trim() || profile.login,
    avatarUrl: profile.avatar_url,
  };
}
