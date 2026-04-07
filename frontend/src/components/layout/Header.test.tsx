import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { Header } from "./Header";
import { useGameStore } from "@/stores/gameStore";
import type { Scenario } from "@shared/types/game";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const scenarioFixture: Scenario = {
  id: "scenario-1",
  title: "One worker node NotReady causing pod disruptions with long title text",
  difficulty: "easy",
  description: "desc",
  incidentTicket: {
    id: "INC-1",
    severity: "Sev3",
    title: "Ticket title",
    description: "Ticket description",
    customerImpact: "Partial impact",
    reportedTime: "2026-04-07T00:00:00Z",
    clusterName: "aro-prod",
    region: "eastus2",
  },
  clusterContext: {
    name: "aro-prod",
    version: "4.18.12",
    region: "eastus2",
    nodeCount: 9,
    status: "degraded",
    recentEvents: [],
    alerts: [],
    upgradeHistory: [],
  },
};

describe("Header layout", () => {
  beforeEach(() => {
    useGameStore.getState().resetGame();
    useGameStore.setState({
      status: "playing",
      scenario: scenarioFixture,
      nickname: "alexander_operator",
      currentPhase: "reading",
      phaseHistory: ["reading"],
      score: {
        efficiency: 0,
        safety: 0,
        documentation: 0,
        accuracy: 0,
        total: 0,
      },
      commandCount: 0,
      scoringEvents: [],
    });
  });

  afterEach(() => {
    cleanup();
    useGameStore.setState({ nickname: null });
    useGameStore.getState().resetGame();
  });

  it("renders a compact current-phase tracker with a dropdown list", () => {
    render(<Header />);

    expect(screen.queryByTestId("header-nickname")).toBeNull();

    const phaseButton = screen.getByTestId("phase-tracker-button");
    expect(phaseButton).toBeTruthy();
    expect(phaseButton.textContent).toContain("Reading");
    expect(phaseButton.getAttribute("aria-haspopup")).toBe("listbox");
    expect(phaseButton.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(phaseButton);
    const phaseMenu = screen.getByTestId("phase-tracker-menu");
    expect(phaseMenu).toBeTruthy();
    expect(phaseButton.getAttribute("aria-expanded")).toBe("true");
    expect(phaseMenu.getAttribute("role")).toBe("listbox");
    expect(phaseButton.getAttribute("aria-controls")).toBe(phaseMenu.getAttribute("id"));
    expect(screen.getByText("Context Gathering")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("phase-tracker-menu")).toBeNull();
    expect(phaseButton.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows nickname inside the score dropdown panel", () => {
    render(<Header />);

    fireEvent.click(screen.getByTestId("score-toggle"));

    const nicknameRow = screen.getByTestId("score-panel-nickname");
    expect(nicknameRow).toBeTruthy();
    expect(nicknameRow.textContent).toContain("alexander_operator");
  });

  it("applies truncation and width guard classes to avoid cluster collisions", () => {
    render(<Header />);

    const leftCluster = screen.getByTestId("header-left-cluster");
    const rightCluster = screen.getByTestId("header-right-cluster");
    const scenarioTitle = screen.getByTestId("header-scenario-title");
    const phaseTracker = screen.getByTestId("phase-tracker");
    const phaseButton = screen.getByTestId("phase-tracker-button");

    expect(leftCluster.className).toContain("min-w-0");
    expect(leftCluster.className).toContain("flex-1");
    expect(rightCluster.className).toContain("shrink-0");
    expect(scenarioTitle.className).toContain("truncate");
    expect(phaseTracker.className).toContain("shrink-0");
    expect(phaseButton.className).toContain("max-w-32");
    expect(phaseButton.querySelector("span.truncate")).toBeTruthy();
  });
});
