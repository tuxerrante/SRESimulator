import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

describe("logout route", () => {
  it("clears viewer, OAuth state, and anonymous proof cookies", async () => {
    const request = new NextRequest("https://play.example.com/api/auth/logout", {
      method: "POST",
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(response.cookies.get("sresim_viewer_session")?.maxAge).toBe(0);
    expect(response.cookies.get("sresim_github_oauth_state")?.maxAge).toBe(0);
    expect(response.cookies.get("sresim_anonymous_proof")?.maxAge).toBe(0);
  });
});
