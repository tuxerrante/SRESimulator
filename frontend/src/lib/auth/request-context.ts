interface RequestLike {
  nextUrl: URL;
  headers: {
    get(name: string): string | null;
  };
}

function normalizeOrigin(value: string): string {
  return value.replace(/\/$/, "");
}

export function getAppOrigin(request: RequestLike): string {
  const configuredOrigin = process.env.PUBLIC_APP_ORIGIN?.trim();
  if (configuredOrigin) {
    return normalizeOrigin(configuredOrigin);
  }

  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  return normalizeOrigin(request.nextUrl.origin);
}

export function isSecureRequest(request: RequestLike): boolean {
  return new URL(getAppOrigin(request)).protocol === "https:";
}

export function shouldTrustProxyHeaders(): boolean {
  return process.env.TRUST_PROXY_HEADERS === "true";
}
