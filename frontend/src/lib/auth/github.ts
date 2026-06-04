import type { GithubViewer } from "@shared/auth/viewer";

interface BuildGithubAuthorizeUrlOptions {
  clientId: string;
  baseUrl: string;
  state: string;
}

interface GithubProfileResponse {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

export function buildGithubAuthorizeUrl({
  clientId,
  baseUrl,
  state,
}: BuildGithubAuthorizeUrlOptions): URL {
  const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set(
    "redirect_uri",
    `${baseUrl.replace(/\/$/, "")}/api/auth/github/callback`
  );
  authorizeUrl.searchParams.set("scope", "read:user user:email");
  authorizeUrl.searchParams.set("state", state);
  return authorizeUrl;
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
