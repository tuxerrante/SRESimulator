import { NextRequest, NextResponse } from "next/server";
import {
  GITHUB_OAUTH_STATE_COOKIE,
  VIEWER_SESSION_COOKIE,
} from "@shared/auth/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const response = NextResponse.json({ ok: true });
  const secure = request.nextUrl.protocol === "https:";

  response.cookies.set({
    name: VIEWER_SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 0,
  });
  response.cookies.set({
    name: GITHUB_OAUTH_STATE_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 0,
  });

  return response;
}
