import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCommand } from "./useCommand";
import { useGameStore } from "@/stores/gameStore";
import type { Scenario } from "@shared/types/game";

const captureFrontendErrorMock = vi.fn();

vi.mock("@/lib/telemetry/request-context", () => ({
  buildTelemetryHeaders: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/telemetry/capture", () => ({
  captureFrontendError: (...args: unknown[]) => captureFrontendErrorMock(...args),
}));

function createScenario(): Scenario {
  return {
    id: "scenario-504",
    title: "Gateway timeout scenario",
    difficulty: "easy",
    description: "Testing command timeout handling",
    incidentTicket: {
      id: "INC-504",
      severity: "Sev2",
      title: "Gateway timeout in command simulation",
      description: "Command execution proxy timed out",
      customerImpact: "High latency for investigators",
      reportedTime: "2026-06-04T17:30:00Z",
      clusterName: "aro-test",
      region: "westeurope",
    },
    clusterContext: {
      name: "aro-test",
      version: "4.16.0",
      region: "westeurope",
      nodeCount: 3,
      status: "degraded",
      recentEvents: [],
      alerts: [],
      upgradeHistory: [],
    },
  };
}

function Harness() {
  const { executeCommand } = useCommand();

  return (
    <button
      type="button"
      onClick={() => {
        void executeCommand("oc get pods -A", "oc");
      }}
    >
      Run command
    </button>
  );
}

describe("useCommand 504 handling", () => {
  beforeEach(() => {
    useGameStore.getState().resetGame();
    useGameStore.getState().startGame(createScenario(), "session-token");
    captureFrontendErrorMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useGameStore.getState().resetGame();
  });

  it("shows a friendly retry message for non-JSON 504 responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 504,
        text: async () => "<html>gateway timeout</html>",
      } as Response),
    );

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Run command" }));

    await waitFor(() => {
      expect(useGameStore.getState().terminalEntries.length).toBe(1);
    });

    const [entry] = useGameStore.getState().terminalEntries;
    expect(entry.exitCode).toBe(1);
    expect(entry.output).toBe(
      "Error: Command request timed out (504). Please try running the command again.",
    );
  });
});
