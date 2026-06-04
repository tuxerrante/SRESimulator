import { describe, expect, it } from "vitest";
import { getAppOrigin, isSecureRequest } from "./request-context";

function makeRequestLike(
  url: string,
  headers: Record<string, string> = {}
): {
  nextUrl: URL;
  headers: { get(name: string): string | null };
} {
  return {
    nextUrl: new URL(url),
    headers: {
      get(name: string) {
        return headers[name.toLowerCase()] ?? null;
      },
    },
  };
}

describe("request auth context helpers", () => {
  it("prefers PUBLIC_APP_ORIGIN when configured", () => {
    process.env.PUBLIC_APP_ORIGIN = "https://play.example.com";

    expect(
      getAppOrigin(
        makeRequestLike("http://internal:3000/api/auth/github/login", {
          "x-forwarded-proto": "http",
          "x-forwarded-host": "internal:3000",
        })
      )
    ).toBe("https://play.example.com");
    expect(
      isSecureRequest(
        makeRequestLike("http://internal:3000/api/auth/github/login", {
          "x-forwarded-proto": "http",
          "x-forwarded-host": "internal:3000",
        })
      )
    ).toBe(true);

    delete process.env.PUBLIC_APP_ORIGIN;
  });

  it("falls back to forwarded proto and host when public origin is unset", () => {
    delete process.env.PUBLIC_APP_ORIGIN;
    delete process.env.TRUST_PROXY_HEADERS;

    expect(
      getAppOrigin(
        makeRequestLike("http://internal:3000/api/auth/github/login", {
          "x-forwarded-proto": "https",
          "x-forwarded-host": "play.sresimulator.osadev.cloud",
        })
      )
    ).toBe("http://internal:3000");
  });

  it("uses forwarded proto and host only when proxy header trust is enabled", () => {
    delete process.env.PUBLIC_APP_ORIGIN;
    process.env.TRUST_PROXY_HEADERS = "true";

    expect(
      getAppOrigin(
        makeRequestLike("http://internal:3000/api/auth/github/login", {
          "x-forwarded-proto": "https",
          "x-forwarded-host": "play.sresimulator.osadev.cloud",
        })
      )
    ).toBe("https://play.sresimulator.osadev.cloud");

    delete process.env.TRUST_PROXY_HEADERS;
  });
});
