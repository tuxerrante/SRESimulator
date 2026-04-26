import { NextRequest, NextResponse } from "next/server";
import {
  ANONYMOUS_PROOF_COOKIE,
  ANONYMOUS_PROOF_TTL_MS,
  VIEWER_SESSION_COOKIE,
} from "@shared/auth/constants";
import {
  createAnonymousProofToken,
  hashAnonymousProofUserAgent,
  readAnonymousProofToken,
} from "@shared/auth/anonymous-proof";
import { createSignedClientIp } from "@shared/auth/client-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getBackendBaseUrl(): string {
  const base = process.env.BACKEND_INTERNAL_BASE_URL || "http://127.0.0.1:8080";
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

function getTrustedClientIp(request: NextRequest): string | null {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() || null;
  }

  return request.headers.get("x-real-ip")?.trim() || null;
}

function upsertCookieHeader(
  cookieHeader: string | null,
  cookieName: string,
  cookieValue: string
): string {
  const cookies = (cookieHeader ?? "")
    .split(";")
    .map((cookie) => cookie.trim())
    .filter(Boolean)
    .filter((cookie) => !cookie.startsWith(`${cookieName}=`));

  cookies.push(`${cookieName}=${cookieValue}`);
  return cookies.join("; ");
}

function isScenarioProxyRequest(request: NextRequest): boolean {
  return request.method === "POST" && request.nextUrl.pathname === "/api/scenario";
}

async function proxyRequest(request: NextRequest): Promise<NextResponse> {
  const backendPath = request.nextUrl.pathname || "/";
  const targetUrl = `${getBackendBaseUrl()}${backendPath}${request.nextUrl.search}`;

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.delete("connection");
  headers.delete("x-forwarded-for");
  headers.delete("x-real-ip");
  headers.delete("forwarded");

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const antiAbuseSecret = process.env.ANTI_ABUSE_HMAC_SECRET;
  const clientIp = getTrustedClientIp(request);
  if (clientIp && antiAbuseSecret) {
    headers.set("x-sresim-client-ip", clientIp);
    headers.set("x-sresim-client-ip-signature", createSignedClientIp(clientIp, antiAbuseSecret));
  }

  let body: BodyInit | undefined;
  let anonymousProofToSet: string | null = null;
  if (hasBody) {
    if (
      isScenarioProxyRequest(request) &&
      request.headers.get("content-type")?.includes("application/json")
    ) {
      const parsed = (await request.json()) as Record<string, unknown>;
      const fingerprintHash =
        typeof parsed.fingerprintHash === "string" ? parsed.fingerprintHash : null;
      const userAgent = request.headers.get("user-agent") ?? "";
      const existingProofToken = request.cookies.get(ANONYMOUS_PROOF_COOKIE)?.value ?? null;
      const existingProof =
        existingProofToken && antiAbuseSecret
          ? readAnonymousProofToken(existingProofToken, antiAbuseSecret, { userAgent })
          : null;

      if (
        !request.cookies.get(VIEWER_SESSION_COOKIE)?.value &&
        !existingProof &&
        fingerprintHash &&
        antiAbuseSecret
      ) {
        const issuedAt = Date.now();
        anonymousProofToSet = createAnonymousProofToken(
          {
            fingerprintHash,
            userAgentHash: hashAnonymousProofUserAgent(userAgent),
            issuedAt,
            expiresAt: issuedAt + ANONYMOUS_PROOF_TTL_MS,
          },
          antiAbuseSecret
        );
      }

      if (existingProofToken || anonymousProofToSet) {
        headers.set(
          "cookie",
          upsertCookieHeader(
            request.headers.get("cookie"),
            ANONYMOUS_PROOF_COOKIE,
            anonymousProofToSet ?? existingProofToken!
          )
        );
      }

      delete parsed.fingerprintHash;
      body = JSON.stringify(parsed);
    } else {
      body = await request.arrayBuffer();
    }
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      cache: "no-store",
    });

    const response = new NextResponse(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
    if (anonymousProofToSet) {
      response.cookies.set({
        name: ANONYMOUS_PROOF_COOKIE,
        value: anonymousProofToSet,
        httpOnly: true,
        sameSite: "lax",
        secure: request.nextUrl.protocol === "https:",
        path: "/",
        maxAge: Math.floor(ANONYMOUS_PROOF_TTL_MS / 1000),
      });
    }
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown proxy error";
    return NextResponse.json({ error: `Backend proxy failed: ${message}` }, { status: 502 });
  }
}

export const GET = proxyRequest;
export const POST = proxyRequest;
export const PUT = proxyRequest;
export const PATCH = proxyRequest;
export const DELETE = proxyRequest;
export const OPTIONS = proxyRequest;
export const HEAD = proxyRequest;
