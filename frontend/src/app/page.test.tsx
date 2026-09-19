import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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

describe("HomePage AI budget refresh", () => {
  const fetchMock = vi.fn();

  /** Matches AI_BUDGET_POLL_INTERVAL_MS in page.tsx. */
  const POLL_INTERVAL_MS = 60_000;

  function budgetReads(): number {
    return fetchMock.mock.calls.filter((call) => call[0] === "/api/ai/budget").length;
  }

  async function flushMicrotasks(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    useGameStore.getState().resetGame();
    useGameStore.setState({ nickname: "operator" });
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/ai/budget") {
        return new Response(
          JSON.stringify({
            enabled: true,
            dailyLimit: 1000,
            dailyRemaining: 1000,
            minuteLimit: 20,
            minuteRemaining: 20,
            degraded: false,
            resetAt: null,
            upstream: null,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ viewer: null, authConfigured: false }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    useGameStore.setState({ nickname: null, viewer: null });
    useGameStore.getState().resetGame();
  });

  it("keeps reading the shared budget after mount", async () => {
    render(<HomePage />);
    await flushMicrotasks();

    expect(budgetReads()).toBe(1);

    // The budget is spent by every other player too, so the value read at
    // mount goes stale with nothing on this page happening -- including the
    // "answers are simulated" banner, which must disappear on its own once
    // the window rolls.
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS);
    });
    await flushMicrotasks();

    expect(budgetReads()).toBe(2);
  });

  it("does not re-read on a tab flip inside the refresh floor", async () => {
    render(<HomePage />);
    await flushMicrotasks();
    expect(budgetReads()).toBe(1);

    // The endpoint sits behind the per-identity AI limiter. A tab flipped away
    // and back repeatedly would spend the player's own allowance describing a
    // budget that cannot have moved in the meantime.
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flushMicrotasks();

    expect(budgetReads()).toBe(1);
  });

  it("catches a returning tab up once the floor has passed", async () => {
    render(<HomePage />);
    await flushMicrotasks();

    await act(async () => {
      vi.advanceTimersByTime(20_000);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flushMicrotasks();

    expect(budgetReads()).toBe(2);
  });

  it("stops polling once the page unmounts", async () => {
    const { unmount } = render(<HomePage />);
    await flushMicrotasks();
    expect(budgetReads()).toBe(1);

    unmount();

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 3);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flushMicrotasks();

    expect(budgetReads()).toBe(1);
  });
});
