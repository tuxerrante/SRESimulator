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
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        viewer: null,
        authConfigured: false,
      }),
    });
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
});
