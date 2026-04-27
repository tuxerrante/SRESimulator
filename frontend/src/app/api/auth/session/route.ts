import { NextRequest, NextResponse } from "next/server";
import { getViewerAccessPolicy } from "@shared/auth/access";
import { VIEWER_SESSION_COOKIE } from "@shared/auth/constants";
import { readViewerSessionToken } from "@shared/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.AUTH_SESSION_SECRET;
  if (!secret) {
    return NextResponse.json(
      {
        viewer: null,
        accessPolicy: getViewerAccessPolicy(null),
        authConfigured: false,
      },
      { status: 200 }
    );
  }

  const token = request.cookies.get(VIEWER_SESSION_COOKIE)?.value;
  const session = token ? readViewerSessionToken(token, secret) : null;
  const viewer = session
    ? {
        kind: session.kind,
        githubUserId: session.githubUserId,
        githubLogin: session.githubLogin,
        displayName: session.displayName,
        avatarUrl: session.avatarUrl,
      }
    : null;

  return NextResponse.json({
    viewer,
    accessPolicy: getViewerAccessPolicy(viewer),
    authConfigured: Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
  });
}
