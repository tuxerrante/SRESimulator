import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { GITHUB_OAUTH_STATE_COOKIE } from "@shared/auth/constants";
import { buildGithubAuthorizeUrl, resolveGithubOAuthConfig } from "@/lib/auth/github";
import { getAppOrigin, isSecureRequest } from "@/lib/auth/request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const oauthConfig = resolveGithubOAuthConfig({
    baseUrl: getAppOrigin(request),
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    authSecret: process.env.AUTH_SESSION_SECRET,
    configuredCallbackUrl: process.env.GITHUB_OAUTH_CALLBACK_URL,
    requireCallbackMatch: process.env.GITHUB_OAUTH_REQUIRE_CALLBACK_MATCH === "true",
  });
  if (!oauthConfig.configured) {
    return NextResponse.json(
      {
        error: "GitHub OAuth is not available for this origin",
        code: oauthConfig.reason,
      },
      { status: 503 }
    );
  }

  const state = randomUUID();
  const authorizeUrl = buildGithubAuthorizeUrl({
    clientId: oauthConfig.clientId,
    callbackUrl: oauthConfig.callbackUrl,
    state,
  });

  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.set({
    name: GITHUB_OAUTH_STATE_COOKIE,
    value: state,
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(request),
    path: "/",
    maxAge: 10 * 60,
  });

  return response;
}
