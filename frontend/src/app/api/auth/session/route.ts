import { NextRequest, NextResponse } from "next/server";
import { getViewerAccessPolicy } from "@shared/auth/access";
import { VIEWER_SESSION_COOKIE } from "@shared/auth/constants";
import { readViewerSessionToken } from "@shared/auth/session";
import { resolveGithubOAuthConfig } from "@/lib/auth/github";
import { getAppOrigin } from "@/lib/auth/request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA";

function readTurnstileConfig(): {
  turnstileConfigured: boolean;
  turnstileSiteKey: string | null;
  turnstileTestMode: boolean;
} {
  const turnstileTestMode =
    process.env.TURNSTILE_TEST_MODE === "true" &&
    process.env.LOCAL_TEST_VERIFICATION_ENABLED === "true";
  const turnstileSiteKey =
    process.env.TURNSTILE_SITE_KEY?.trim() ||
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() ||
    null;

  if (turnstileTestMode) {
    return {
      turnstileConfigured: true,
      turnstileSiteKey: turnstileSiteKey ?? DEFAULT_TURNSTILE_TEST_SITE_KEY,
      turnstileTestMode,
    };
  }

  return {
    turnstileConfigured: Boolean(turnstileSiteKey),
    turnstileSiteKey,
    turnstileTestMode,
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const adminAnalyticsEnabled =
    process.env.NEXT_PUBLIC_ADMIN_ANALYTICS_ENABLED === "true";
  const turnstile = readTurnstileConfig();
  const secret = process.env.AUTH_SESSION_SECRET;
  if (!secret) {
    return NextResponse.json(
      {
        viewer: null,
        accessPolicy: getViewerAccessPolicy(null),
        authConfigured: false,
        adminAnalyticsEnabled,
        ...turnstile,
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
  const oauthConfig = resolveGithubOAuthConfig({
    baseUrl: getAppOrigin(request),
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    authSecret: secret,
    configuredCallbackUrl: process.env.GITHUB_OAUTH_CALLBACK_URL,
    requireCallbackMatch: process.env.GITHUB_OAUTH_REQUIRE_CALLBACK_MATCH === "true",
  });

  return NextResponse.json({
    viewer,
    accessPolicy: getViewerAccessPolicy(viewer),
    authConfigured: oauthConfig.configured,
    authUnavailableReason: oauthConfig.configured ? null : oauthConfig.reason,
    adminAnalyticsEnabled,
    ...turnstile,
  });
}
