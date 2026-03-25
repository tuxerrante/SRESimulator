import { describe, expect, it, beforeEach, vi } from "vitest";
import { useGameStore } from "./gameStore";
import type { Scenario } from "@shared/types/game";
import type { ChatMessage } from "@shared/types/chat";
import type { ScoringEvent } from "@shared/types/scoring";

const mockScenario: Scenario = {
  id: "scenario_test",
  title: "Test Scenario",
  difficulty: "easy",
  description: "A test scenario",
  incidentTicket: {
    id: "IcM-TEST",
    severity: "Sev4",
    title: "Test Incident",
    description: "Test description",
    customerImpact: "None",
    reportedTime: new Date().toISOString(),
    clusterName: "test-cluster",
    region: "eastus",
  },
  clusterContext: {
    name: "test-cluster",
    version: "4.19.9",
    region: "eastus",
    nodeCount: 6,
    status: "Degraded",
    recentEvents: ["Event 1"],
    alerts: [
      {
        name: "TestAlert",
        severity: "warning",
        message: "Test alert",
        firingTime: new Date().toISOString(),
      },
    ],
    upgradeHistory: [],
  },
};

describe("gameStore", () => {
  beforeEach(() => {
    useGameStore.getState().resetGame();
  });

  describe("initial state", () => {
    it("starts with idle status", () => {
      const state = useGameStore.getState();
      expect(state.status).toBe("idle");
      expect(state.scenario).toBeNull();
      expect(state.sessionToken).toBeNull();
      expect(state.messages).toEqual([]);
      expect(state.currentPhase).toBe("reading");
      expect(state.commandCount).toBe(0);
    });
  });

  describe("startGame", () => {
    it("sets playing status and initializes game state", () => {
      useGameStore.getState().startGame(mockScenario, "token-123");
      const state = useGameStore.getState();

      expect(state.status).toBe("playing");
      expect(state.scenario).toEqual(mockScenario);
      expect(state.sessionToken).toBe("token-123");
      expect(state.startTime).not.toBeNull();
      expect(state.currentPhase).toBe("reading");
      expect(state.phaseHistory).toEqual(["reading"]);
      expect(state.messages).toEqual([]);
      expect(state.commandCount).toBe(0);
    });
  });

  describe("endGame", () => {
    it("sets completed status and records end time", () => {
      useGameStore.getState().startGame(mockScenario, "token-123");
      useGameStore.getState().endGame();
      const state = useGameStore.getState();

      expect(state.status).toBe("completed");
      expect(state.endTime).not.toBeNull();
    });
  });

  describe("resetGame", () => {
    it("returns to idle state", () => {
      useGameStore.getState().startGame(mockScenario, "token-123");
      useGameStore.getState().resetGame();
      const state = useGameStore.getState();

      expect(state.status).toBe("idle");
      expect(state.scenario).toBeNull();
      expect(state.messages).toEqual([]);
    });
  });

  describe("messages", () => {
    it("adds messages", () => {
      const msg: ChatMessage = {
        id: "1",
        role: "user",
        content: "Hello",
        timestamp: Date.now(),
      };
      useGameStore.getState().addMessage(msg);

      expect(useGameStore.getState().messages).toHaveLength(1);
      expect(useGameStore.getState().messages[0].content).toBe("Hello");
    });

    it("updates last assistant message", () => {
      const userMsg: ChatMessage = {
        id: "1",
        role: "user",
        content: "Hello",
        timestamp: Date.now(),
      };
      const assistantMsg: ChatMessage = {
        id: "2",
        role: "assistant",
        content: "",
        timestamp: Date.now(),
      };

      useGameStore.getState().addMessage(userMsg);
      useGameStore.getState().addMessage(assistantMsg);
      useGameStore.getState().updateLastAssistantMessage("Streamed content");

      const messages = useGameStore.getState().messages;
      expect(messages[1].content).toBe("Streamed content");
    });

    it("does not update if last message is from user", () => {
      const userMsg: ChatMessage = {
        id: "1",
        role: "user",
        content: "Hello",
        timestamp: Date.now(),
      };
      useGameStore.getState().addMessage(userMsg);
      useGameStore.getState().updateLastAssistantMessage("Should not apply");

      expect(useGameStore.getState().messages[0].content).toBe("Hello");
    });
  });

  describe("phases", () => {
    it("sets phase and adds to history", () => {
      useGameStore.getState().setPhase("context");
      const state = useGameStore.getState();

      expect(state.currentPhase).toBe("context");
      expect(state.phaseHistory).toContain("context");
    });

    it("does not duplicate phase in history", () => {
      useGameStore.getState().setPhase("context");
      useGameStore.getState().setPhase("context");

      expect(
        useGameStore.getState().phaseHistory.filter((p) => p === "context")
      ).toHaveLength(1);
    });
  });

  describe("terminal entries", () => {
    it("adds terminal entries and increments command count", () => {
      useGameStore.getState().addTerminalEntry({
        id: "1",
        command: "oc get nodes",
        output: "...",
        timestamp: Date.now(),
        exitCode: 0,
        type: "oc",
      });

      expect(useGameStore.getState().terminalEntries).toHaveLength(1);
      expect(useGameStore.getState().commandCount).toBe(1);
    });
  });

  describe("scoring", () => {
    it("recalculates score from events", () => {
      const bonus: ScoringEvent = {
        type: "bonus",
        dimension: "safety",
        points: 10,
        reason: "Good",
        timestamp: Date.now(),
      };
      const penalty: ScoringEvent = {
        type: "penalty",
        dimension: "safety",
        points: 3,
        reason: "Bad",
        timestamp: Date.now(),
      };

      useGameStore.getState().addScoringEvent(bonus);
      useGameStore.getState().addScoringEvent(penalty);
      useGameStore.getState().recalculateScore();

      const score = useGameStore.getState().score;
      expect(score.safety).toBe(7);
      expect(score.total).toBe(7);
    });

    it("clamps scores to 0-25 range", () => {
      useGameStore.getState().addScoringEvent({
        type: "bonus",
        dimension: "efficiency",
        points: 30,
        reason: "Over max",
        timestamp: Date.now(),
      });
      useGameStore.getState().recalculateScore();

      expect(useGameStore.getState().score.efficiency).toBe(25);

      useGameStore.getState().addScoringEvent({
        type: "penalty",
        dimension: "accuracy",
        points: 50,
        reason: "Under min",
        timestamp: Date.now(),
      });
      useGameStore.getState().recalculateScore();

      expect(useGameStore.getState().score.accuracy).toBe(0);
    });

    it("computes total as sum of all dimensions", () => {
      useGameStore.getState().addScoringEvent({
        type: "bonus",
        dimension: "efficiency",
        points: 10,
        reason: "a",
        timestamp: Date.now(),
      });
      useGameStore.getState().addScoringEvent({
        type: "bonus",
        dimension: "safety",
        points: 15,
        reason: "b",
        timestamp: Date.now(),
      });
      useGameStore.getState().addScoringEvent({
        type: "bonus",
        dimension: "documentation",
        points: 5,
        reason: "c",
        timestamp: Date.now(),
      });
      useGameStore.getState().addScoringEvent({
        type: "bonus",
        dimension: "accuracy",
        points: 20,
        reason: "d",
        timestamp: Date.now(),
      });
      useGameStore.getState().recalculateScore();

      const score = useGameStore.getState().score;
      expect(score.total).toBe(50);
    });
  });

  describe("nickname", () => {
    it("setNickname updates the store", () => {
      useGameStore.getState().setNickname("onCallHero");

      expect(useGameStore.getState().nickname).toBe("onCallHero");
    });

    it("truncates nicknames longer than 20 characters", () => {
      const longName = "abcdefghij".repeat(5);
      useGameStore.getState().setNickname(longName);

      expect(useGameStore.getState().nickname).toHaveLength(20);
    });

    it("resetGame preserves the nickname", () => {
      useGameStore.getState().setNickname("keeper");
      useGameStore.getState().startGame(mockScenario, "tok-1");
      useGameStore.getState().resetGame();

      expect(useGameStore.getState().nickname).toBe("keeper");
      expect(useGameStore.getState().status).toBe("idle");
    });

    it("startGame preserves the nickname", () => {
      useGameStore.getState().setNickname("player1");
      useGameStore.getState().startGame(mockScenario, "tok-2");

      expect(useGameStore.getState().nickname).toBe("player1");
      expect(useGameStore.getState().status).toBe("playing");
    });
  });
});
