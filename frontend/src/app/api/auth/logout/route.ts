import { NextRequest, NextResponse } from "next/server";
import {
  ANONYMOUS_PROOF_COOKIE,
  GITHUB_OAUTH_STATE_COOKIE,
  VIEWER_SESSION_COOKIE,
} from "@shared/auth/constants";
import { isSecureRequest } from "@/lib/auth/request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const response = NextResponse.json({ ok: true });
  const secure = isSecureRequest(request);

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
  response.cookies.set({
    name: ANONYMOUS_PROOF_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 0,
  });

  return response;
}
