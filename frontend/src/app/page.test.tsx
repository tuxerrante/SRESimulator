import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import HomePage from "./page";
import { APP_VERSION } from "@/lib/release";
import { useGameStore } from "@/stores/gameStore";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/auth/fingerprint", () => ({
  collectBrowserFingerprintHash: vi.fn().mockResolvedValue("mock-fingerprint"),
}));

describe("HomePage footer release link", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    useGameStore.getState().resetGame();
    useGameStore.setState({ nickname: "operator" });
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          viewer: null,
          authConfigured: false,
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    pushMock.mockReset();
    useGameStore.setState({ nickname: null, viewer: null });
    useGameStore.getState().resetGame();
  });

  it("links the visible version to GitHub releases without local release notes", async () => {
    render(<HomePage />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/auth/session", { cache: "no-store" });
    });

    const releaseLink = screen.getByRole("link", {
      name: `View GitHub release ${APP_VERSION}`,
    });
    expect(releaseLink.textContent).toBe(APP_VERSION);
    expect(releaseLink.getAttribute("href")).toBe(
      `https://github.com/tuxerrante/SRESimulator/releases/tag/${APP_VERSION}`
    );
    expect(releaseLink.getAttribute("target")).toBe("_blank");
    expect(releaseLink.getAttribute("rel")).toContain("noopener");
    expect(releaseLink.getAttribute("rel")).toContain("noreferrer");
    expect(screen.queryByText("Main feature updates")).toBeNull();
  });

  it("centers the landing page stack without stretching content away from the footer", async () => {
    const { container } = render(<HomePage />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/auth/session", { cache: "no-store" });
    });

    const page = container.firstElementChild;
    const content = page?.firstElementChild;

    expect(page?.classList.contains("justify-center")).toBe(true);
    expect(content?.classList.contains("flex")).toBe(true);
    expect(content?.classList.contains("flex-1")).toBe(false);
  });

  it("uses a document navigation for the GitHub OAuth redirect endpoint", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ viewer: null, authConfigured: true }), { status: 200 })
    );

    render(<HomePage />);

    const loginButton = await screen.findByRole("button", { name: "Sign in with GitHub" });
    const loginForm = loginButton.closest("form");
    expect(loginForm?.getAttribute("action")).toBe("/api/auth/github/login");
    expect(loginForm?.getAttribute("method")).toBe("get");
  });

  it("uses the GitHub login as the callsign without rendering an editable field", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          viewer: {
            kind: "github",
            githubUserId: "12345",
            githubLogin: "octocat",
            displayName: "The Octocat",
            avatarUrl: null,
          },
          authConfigured: true,
        }),
        { status: 200 },
      ),
    );

    render(<HomePage />);

    await screen.findByText("Signed in with GitHub as The Octocat");

    expect(screen.queryByRole("textbox", { name: "Callsign" })).toBeNull();
    expect(useGameStore.getState().nickname).toBe("octocat");
  });

  it("does not render a callsign field while authentication is loading", () => {
    fetchMock.mockReturnValue(new Promise(() => {}));

    render(<HomePage />);

    expect(screen.queryByRole("textbox", { name: "Callsign" })).toBeNull();
  });

  it("explains when the environment callback has not been verified", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          viewer: null,
          authConfigured: false,
          authUnavailableReason: "callback_not_verified",
        }),
        { status: 200 }
      )
    );

    render(<HomePage />);

    expect(
      await screen.findByText("GitHub sign-in is unavailable for this environment.")
    ).toBeTruthy();
  });
});
