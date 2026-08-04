import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ScoreBreakdown } from "./ScoreBreakdown";
import { useGameStore } from "@/stores/gameStore";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

describe("ScoreBreakdown", () => {
  beforeEach(() => {
    useGameStore.getState().resetGame();
    useGameStore.setState({
      nickname: "custom-callsign",
      sessionToken: "session-token",
      viewer: {
        kind: "github",
        githubUserId: "12345",
        githubLogin: "octocat",
        displayName: "The Octocat",
        avatarUrl: null,
      },
    });
  });

  afterEach(() => {
    cleanup();
    useGameStore.setState({ nickname: null, viewer: null });
    useGameStore.getState().resetGame();
  });

  it("displays the GitHub login instead of an editable callsign", () => {
    render(<ScoreBreakdown />);

    expect(screen.getByText("@octocat")).toBeTruthy();
    expect(screen.queryByPlaceholderText("Your callsign")).toBeNull();
  });
});
