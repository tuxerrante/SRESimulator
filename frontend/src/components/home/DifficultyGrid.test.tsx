import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DifficultyGrid } from "./DifficultyGrid";

describe("DifficultyGrid", () => {
  afterEach(() => {
    cleanup();
  });

  it("locks medium and hard for anonymous players", () => {
    render(
      <DifficultyGrid
        viewer={null}
        hasCallsign
        loadingDifficulty={null}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: /the junior sre/i }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: /the shift lead/i }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: /the principal engineer/i }).hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByText("GitHub login required")).toHaveLength(2);
  });

  it("unlocks all difficulties for GitHub players", () => {
    render(
      <DifficultyGrid
        viewer={{
          kind: "github",
          githubUserId: "12345",
          githubLogin: "octocat",
          displayName: "The Octocat",
          avatarUrl: null,
        }}
        hasCallsign
        loadingDifficulty={null}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: /the shift lead/i }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: /the principal engineer/i }).hasAttribute("disabled")).toBe(false);
    expect(screen.queryByText("GitHub login required")).toBeNull();
  });

  it("keeps all difficulties disabled until the player adds a callsign", () => {
    render(
      <DifficultyGrid
        viewer={null}
        hasCallsign={false}
        loadingDifficulty={null}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: /the junior sre/i }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: /the shift lead/i }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: /the principal engineer/i }).hasAttribute("disabled")).toBe(true);
  });

  it("passes the selected difficulty back to the page", () => {
    const onSelect = vi.fn();

    render(
      <DifficultyGrid
        viewer={{
          kind: "github",
          githubUserId: "12345",
          githubLogin: "octocat",
          displayName: "The Octocat",
          avatarUrl: null,
        }}
        hasCallsign
        loadingDifficulty={null}
        onSelect={onSelect}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /the principal engineer/i }));

    expect(onSelect).toHaveBeenCalledWith("hard");
  });
});
