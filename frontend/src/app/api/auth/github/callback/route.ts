import { NextRequest, NextResponse } from "next/server";
import {
  GITHUB_OAUTH_STATE_COOKIE,
  VIEWER_SESSION_COOKIE,
  VIEWER_SESSION_TTL_MS,
} from "@shared/auth/constants";
import { createViewerSessionToken } from "@shared/auth/session";
import { buildGithubAuthorizeUrl, toGithubViewer } from "@/lib/auth/github";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface GithubTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GithubProfileResponse {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const authSecret = process.env.AUTH_SESSION_SECRET;

  if (!clientId || !clientSecret || !authSecret) {
    return NextResponse.json({ error: "GitHub OAuth is not configured" }, { status: 503 });
  }

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const expectedState = request.cookies.get(GITHUB_OAUTH_STATE_COOKIE)?.value;

  if (!code || !state || !expectedState || state !== expectedState) {
    return NextResponse.redirect(new URL("/?error=github_auth_state", request.url));
  }

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: buildGithubAuthorizeUrl({
        clientId,
        baseUrl: request.nextUrl.origin,
        state,
      }).searchParams.get("redirect_uri"),
      state,
    }),
    cache: "no-store",
  });

  const tokenJson = (await tokenResponse.json()) as GithubTokenResponse;
  if (!tokenResponse.ok || !tokenJson.access_token) {
    return NextResponse.redirect(new URL("/?error=github_auth_exchange", request.url));
  }

  const profileResponse = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${tokenJson.access_token}`,
      "User-Agent": "sre-simulator",
    },
    cache: "no-store",
  });

  if (!profileResponse.ok) {
    return NextResponse.redirect(new URL("/?error=github_auth_profile", request.url));
  }

  const profile = (await profileResponse.json()) as GithubProfileResponse;
  const viewer = toGithubViewer(profile);
  const issuedAt = Date.now();
  const sessionToken = createViewerSessionToken(
    {
      ...viewer,
      issuedAt,
      expiresAt: issuedAt + VIEWER_SESSION_TTL_MS,
    },
    authSecret
  );

  const response = NextResponse.redirect(new URL("/", request.url));
  response.cookies.delete(GITHUB_OAUTH_STATE_COOKIE);
  response.cookies.set({
    name: VIEWER_SESSION_COOKIE,
    value: sessionToken,
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: "/",
    maxAge: Math.floor(VIEWER_SESSION_TTL_MS / 1000),
  });
  return response;
}
