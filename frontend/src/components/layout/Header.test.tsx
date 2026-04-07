import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
      nickname: "alexander_operator_name",
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
    useGameStore.getState().resetGame();
  });

  it("renders nickname and Reading phase together in playing state", () => {
    render(<Header />);

    expect(screen.getByTestId("header-nickname")).toBeTruthy();
    expect(screen.getByText("Reading")).toBeTruthy();
  });

  it("applies truncation and width guard classes to avoid cluster collisions", () => {
    render(<Header />);

    const leftCluster = screen.getByTestId("header-left-cluster");
    const rightCluster = screen.getByTestId("header-right-cluster");
    const scenarioTitle = screen.getByTestId("header-scenario-title");
    const nickname = screen.getByTestId("header-nickname");

    expect(leftCluster.className).toContain("min-w-0");
    expect(leftCluster.className).toContain("flex-1");
    expect(rightCluster.className).toContain("shrink-0");
    expect(scenarioTitle.className).toContain("truncate");
    expect(nickname.className).toContain("max-w-40");
    expect(nickname.querySelector("span.truncate")).toBeTruthy();
  });
});
