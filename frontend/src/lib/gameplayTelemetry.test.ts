import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildGameplayTelemetryPayload,
  hasCompletionTelemetryBeenSent,
  markCompletionTelemetrySent,
  scoreToGrade,
  sendGameplayTelemetryEvent,
  sendCompletionTelemetryIfNeeded,
  shouldSendAbandonmentEvent,
} from "./gameplayTelemetry";
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

describe("sendGameplayTelemetryEvent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "fetch");
    Reflect.deleteProperty(globalThis, "navigator");
    globalThis.sessionStorage?.clear();
  });

  it("falls back to fetch when sendBeacon returns false", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(globalThis, "fetch", {
      value: fetchMock,
      configurable: true,
    });
    Object.defineProperty(globalThis, "navigator", {
      value: {
        sendBeacon: vi.fn().mockReturnValue(false),
      },
      configurable: true,
    });

    sendGameplayTelemetryEvent({
      sessionToken: "session-123",
      lifecycleState: "abandoned",
    });

    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledWith("/api/gameplay", expect.objectContaining({
      method: "POST",
      keepalive: true,
    }));
  });

  it("uses sendBeacon when the browser queues the event", async () => {
    const fetchMock = vi.fn();
    const sendBeacon = vi.fn().mockReturnValue(true);
    Object.defineProperty(globalThis, "fetch", {
      value: fetchMock,
      configurable: true,
    });
    Object.defineProperty(globalThis, "navigator", {
      value: { sendBeacon },
      configurable: true,
    });

    await expect(sendGameplayTelemetryEvent({
      sessionToken: "session-123",
      lifecycleState: "completed",
    })).resolves.toBe(true);

    await Promise.resolve();
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns false when fallback fetch fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    Object.defineProperty(globalThis, "fetch", {
      value: fetchMock,
      configurable: true,
    });
    Object.defineProperty(globalThis, "navigator", {
      value: {
        sendBeacon: vi.fn().mockReturnValue(false),
      },
      configurable: true,
    });

    await expect(sendGameplayTelemetryEvent({
      sessionToken: "session-123",
      lifecycleState: "completed",
    })).resolves.toBe(false);
  });

  it("tracks completion telemetry per session token", () => {
    expect(hasCompletionTelemetryBeenSent("session-123")).toBe(false);
    markCompletionTelemetrySent("session-123");
    expect(hasCompletionTelemetryBeenSent("session-123")).toBe(true);
    expect(hasCompletionTelemetryBeenSent("session-456")).toBe(false);
  });

  it("marks completion telemetry only after delivery succeeds", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    Object.defineProperty(globalThis, "fetch", {
      value: fetchMock,
      configurable: true,
    });
    Object.defineProperty(globalThis, "navigator", {
      value: {
        sendBeacon: vi.fn().mockReturnValue(false),
      },
      configurable: true,
    });

    await expect(sendCompletionTelemetryIfNeeded(makeState())).resolves.toBe(false);
    expect(hasCompletionTelemetryBeenSent("session-123")).toBe(false);

    fetchMock.mockResolvedValue({ ok: true });

    await expect(sendCompletionTelemetryIfNeeded(makeState())).resolves.toBe(true);
    expect(hasCompletionTelemetryBeenSent("session-123")).toBe(true);
  });
});
