import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import LeaderboardPage from "./page";

const captureFrontendErrorMock = vi.fn();

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/telemetry/capture", () => ({
  captureFrontendError: (...args: unknown[]) => captureFrontendErrorMock(...args),
}));

describe("LeaderboardPage", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          entries: [],
          hallOfFame: [
            {
              nickname: "operator",
              compositeScore: 95,
              scores: { easy: 98, medium: 92, hard: 88 },
            },
          ],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    captureFrontendErrorMock.mockReset();
  });

  it("renders hall of fame rows when scores payload is valid", async () => {
    render(<LeaderboardPage />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/scores", undefined);
    });

    expect(await screen.findByText("operator")).toBeTruthy();
    expect(captureFrontendErrorMock).not.toHaveBeenCalled();
  });

  it("falls back safely and captures telemetry when response is not valid JSON", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => "not-json",
    });

    render(<LeaderboardPage />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/scores", undefined);
    });

    expect(
      await screen.findByText("No scores yet. Complete a scenario to appear here."),
    ).toBeTruthy();
    expect(captureFrontendErrorMock).toHaveBeenCalledTimes(1);
  });
});
