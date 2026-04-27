import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { GITHUB_OAUTH_STATE_COOKIE } from "@shared/auth/constants";
import { buildGithubAuthorizeUrl } from "@/lib/auth/github";
import { getAppOrigin, isSecureRequest } from "@/lib/auth/request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const authSecret = process.env.AUTH_SESSION_SECRET;
  if (!clientId || !clientSecret || !authSecret) {
    return NextResponse.json({ error: "GitHub OAuth is not configured" }, { status: 503 });
  }

  const state = randomUUID();
  const authorizeUrl = buildGithubAuthorizeUrl({
    clientId,
    baseUrl: getAppOrigin(request),
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
