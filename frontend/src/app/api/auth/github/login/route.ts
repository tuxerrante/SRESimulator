import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { GITHUB_OAUTH_STATE_COOKIE } from "@shared/auth/constants";
import { buildGithubAuthorizeUrl } from "@/lib/auth/github";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "GitHub OAuth is not configured" }, { status: 503 });
  }

  const state = randomUUID();
  const authorizeUrl = buildGithubAuthorizeUrl({
    clientId,
    baseUrl: request.nextUrl.origin,
    state,
  });

  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.set({
    name: GITHUB_OAUTH_STATE_COOKIE,
    value: state,
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: "/",
    maxAge: 10 * 60,
  });

  return response;
}
