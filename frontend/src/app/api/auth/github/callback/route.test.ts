import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

describe("GitHub callback route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    delete process.env.AUTH_SESSION_SECRET;
  });

  it("exchanges the OAuth code with a form-encoded request", async () => {
    process.env.GITHUB_CLIENT_ID = "client-id";
    process.env.GITHUB_CLIENT_SECRET = "client-secret";
    process.env.AUTH_SESSION_SECRET = "auth-secret";

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "token-123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 123,
            login: "octocat",
            name: "The Octocat",
            avatar_url: null,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const request = new NextRequest(
      "https://example.com/api/auth/github/callback?code=test-code&state=test-state",
      {
        headers: {
          cookie: "sresim_github_oauth_state=test-state",
        },
      }
    );
    Object.defineProperty(request, "cookies", {
      value: {
        get(name: string) {
          if (name === "sresim_github_oauth_state") {
            return { value: "test-state" };
          }
          return undefined;
        },
      },
    });

    const response = await GET(request);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, tokenRequest] = fetchMock.mock.calls[0] as [string, RequestInit];
    const tokenHeaders = tokenRequest.headers as Record<string, string>;
    expect(tokenHeaders["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(tokenHeaders.Accept).toBe("application/json");
    expect(tokenRequest.body).toContain("client_id=client-id");
    expect(tokenRequest.body).toContain("client_secret=client-secret");
    expect(tokenRequest.body).toContain("code=test-code");
    expect(response.status).toBe(307);
  });
});
