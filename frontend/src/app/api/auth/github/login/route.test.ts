import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

describe("GitHub login route", () => {
  afterEach(() => {
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    delete process.env.AUTH_SESSION_SECRET;
    delete process.env.PUBLIC_APP_ORIGIN;
  });

  it("uses the public app origin and secure cookies when configured", async () => {
    process.env.GITHUB_CLIENT_ID = "client-id";
    process.env.GITHUB_CLIENT_SECRET = "client-secret";
    process.env.AUTH_SESSION_SECRET = "auth-secret";
    process.env.PUBLIC_APP_ORIGIN = "https://play.example.com";

    const request = new NextRequest("http://internal:3000/api/auth/github/login");
    const response = await GET(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("https://github.com/login/oauth/authorize");
    expect(response.headers.get("location")).toContain(
      encodeURIComponent("https://play.example.com/api/auth/github/callback")
    );
    expect(response.cookies.get("sresim_github_oauth_state")?.secure).toBe(true);
  });

  it("rejects login when the full OAuth/session config is missing", async () => {
    process.env.GITHUB_CLIENT_ID = "client-id";

    const request = new NextRequest("http://internal:3000/api/auth/github/login");
    const response = await GET(request);

    expect(response.status).toBe(503);
  });
});
