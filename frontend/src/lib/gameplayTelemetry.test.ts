import { describe, expect, it } from "vitest";
import { buildGameplayTelemetryPayload, scoreToGrade, shouldSendAbandonmentEvent } from "./gameplayTelemetry";
import type { GameStatus, Scenario } from "@shared/types/game";
import type { Score, ScoringEvent } from "@shared/types/scoring";
import type { TerminalEntry } from "@shared/types/terminal";
import type { InvestigationPhase } from "@shared/types/chat";

interface GameplayTelemetryStateFixture {
  status: GameStatus;
  nickname: string | null;
  sessionToken: string | null;
  scenario: Scenario | null;
  startTime: number | null;
  currentPhase: InvestigationPhase;
  phaseHistory: InvestigationPhase[];
  checkedDashboard: boolean;
  terminalEntries: TerminalEntry[];
  commandCount: number;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  score: Score;
  scoringEvents: ScoringEvent[];
}

const mockScenario: Scenario = {
  id: "scenario_test",
  title: "The Sleeping Cluster",
  difficulty: "easy",
  description: "A test incident",
  incidentTicket: {
    id: "IcM-123",
    severity: "Sev2",
    title: "Control plane unavailable",
    description: "API checks are failing",
    customerImpact: "Cluster access degraded",
    reportedTime: new Date("2026-04-18T12:00:00Z").toISOString(),
    clusterName: "test-cluster",
    region: "eastus",
  },
  clusterContext: {
    name: "test-cluster",
    version: "4.19.9",
    region: "eastus",
    nodeCount: 6,
    status: "Degraded",
    recentEvents: [],
    alerts: [],
    upgradeHistory: [],
  },
};

function makeState(overrides: Partial<GameplayTelemetryStateFixture> = {}): GameplayTelemetryStateFixture {
  return {
    status: "playing",
    nickname: "player1",
    sessionToken: "session-123",
    scenario: mockScenario,
    startTime: 1_000,
    currentPhase: "facts",
    phaseHistory: ["reading", "context", "facts"],
    checkedDashboard: true,
    terminalEntries: [
      {
        id: "cmd-1",
        command: "oc get nodes",
        output: "node-1 Ready",
        timestamp: 1_500,
        exitCode: 0,
        type: "oc",
      },
    ],
    commandCount: 1,
    messages: [
      { role: "user", content: "show me the nodes" },
      { role: "assistant", content: "Use `oc get nodes`." },
      { role: "user", content: "done" },
    ],
    score: {
      efficiency: 20,
      safety: 18,
      documentation: 22,
      accuracy: 24,
      total: 84,
    },
    scoringEvents: [
      {
        type: "bonus",
        dimension: "efficiency",
        points: 5,
        reason: "Quick isolation",
        timestamp: 1_700,
      },
    ],
    ...overrides,
  };
}

describe("scoreToGrade", () => {
  it.each([
    [95, "A"],
    [82, "B"],
    [71, "C"],
    [60, "D"],
    [45, "F"],
  ])("maps %d to %s", (score, expected) => {
    expect(scoreToGrade(score)).toBe(expected);
  });
});

describe("buildGameplayTelemetryPayload", () => {
  it("builds a completed payload from the current game state", () => {
    const state = makeState();

    const payload = buildGameplayTelemetryPayload(state, "completed", 11_000);

    expect(payload).toMatchObject({
      sessionToken: "session-123",
      lifecycleState: "completed",
      nickname: "player1",
      commandCount: 1,
      chatMessageCount: 2,
      durationMs: 10_000,
      scoreTotal: 84,
      grade: "B",
      commandsExecuted: ["oc get nodes"],
      scoringEvents: state.scoringEvents,
    });
    expect(payload.metadata).toMatchObject({
      currentPhase: "facts",
      phaseHistory: ["reading", "context", "facts"],
      checkedDashboard: true,
      scenarioId: "scenario_test",
      scenarioTitle: "The Sleeping Cluster",
    });
  });

  it("omits grade and score for a started event", () => {
    const state = makeState();

    const payload = buildGameplayTelemetryPayload(state, "started", 2_500);

    expect(payload.lifecycleState).toBe("started");
    expect(payload.scoreTotal).toBeUndefined();
    expect(payload.grade).toBeUndefined();
    expect(payload.durationMs).toBe(1_500);
  });
});

describe("shouldSendAbandonmentEvent", () => {
  it("returns true only for in-flight gameplay sessions", () => {
    expect(shouldSendAbandonmentEvent(makeState())).toBe(true);
    expect(shouldSendAbandonmentEvent(makeState({ status: "completed" }))).toBe(false);
    expect(shouldSendAbandonmentEvent(makeState({ status: "idle" }))).toBe(false);
    expect(shouldSendAbandonmentEvent(makeState({ sessionToken: null }))).toBe(false);
    expect(shouldSendAbandonmentEvent(makeState({ scenario: null }))).toBe(false);
  });
});
