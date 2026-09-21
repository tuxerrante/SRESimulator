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

  if (shouldTrustProxyHeaders()) {
    const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
    if (forwardedProto && forwardedHost) {
      return `${forwardedProto}://${forwardedHost}`;
    }
  }

  return normalizeOrigin(request.nextUrl.origin);
}

export function isSecureRequest(request: RequestLike): boolean {
  return new URL(getAppOrigin(request)).protocol === "https:";
}

export function shouldTrustProxyHeaders(): boolean {
  return process.env.TRUST_PROXY_HEADERS === "true";
}

export const DEFAULT_TRUSTED_CLIENT_IP_HEADER = "x-envoy-external-address";

// RFC 9110 field-name token characters. The value reaches `Headers.get()`,
// which throws a TypeError on an invalid name -- and this module is imported
// by the catch-all proxy, so an unvalidated typo would turn every single
// proxied request into a 500 with a stack trace that never names the env var.
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export function isValidHeaderName(value: string): boolean {
  return HEADER_NAME_PATTERN.test(value);
}

/**
 * Which forwarded header carries the edge-derived client address.
 *
 * Defaults to Envoy's, so the AKS path behaves exactly as before. It is
 * configurable because the header is a property of whatever proxy terminates
 * the connection, not of this app: Envoy Gateway republishes the connection
 * source as `x-envoy-external-address`, Traefik sets `X-Real-Ip`, and behind
 * Cloudflare the only non-forgeable one is `cf-connecting-ip`. On k3s the
 * Envoy header simply never exists, so the default returns null there and --
 * with `requireAnonymousClientIp` on -- every anonymous request would 400.
 */
export function getTrustedClientIpHeader(): string {
  const configured = process.env.TRUSTED_CLIENT_IP_HEADER?.trim().toLowerCase();
  return configured || DEFAULT_TRUSTED_CLIENT_IP_HEADER;
}
