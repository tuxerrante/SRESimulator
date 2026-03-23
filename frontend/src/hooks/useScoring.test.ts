import { describe, expect, it, beforeEach } from "vitest";
import { useGameStore } from "@/stores/gameStore";

describe("scoring logic via gameStore", () => {
  beforeEach(() => {
    useGameStore.getState().resetGame();
  });

  describe("dashboard access bonus", () => {
    it("awards safety bonus when dashboard is checked first", () => {
      useGameStore.getState().setCheckedDashboard(true);
      useGameStore.getState().addScoringEvent({
        type: "bonus",
        dimension: "safety",
        points: 5,
        reason: "Checked dashboard before running commands",
        timestamp: Date.now(),
      });
      useGameStore.getState().recalculateScore();

      expect(useGameStore.getState().score.safety).toBe(5);
    });
  });

  describe("phase skip penalty", () => {
    it("penalizes skipping from reading to action", () => {
      const phaseOrder = ["reading", "context", "facts", "theory", "action"] as const;
      const currentIdx = phaseOrder.indexOf("reading");
      const attemptedIdx = phaseOrder.indexOf("action");

      if (attemptedIdx > currentIdx + 1) {
        useGameStore.getState().addScoringEvent({
          type: "penalty",
          dimension: "documentation",
          points: 5,
          reason: "Attempted to skip to action from reading",
          timestamp: Date.now(),
        });
        useGameStore.getState().recalculateScore();
      }

      expect(useGameStore.getState().score.documentation).toBe(0);
    });
  });

  describe("command penalties", () => {
    it("penalizes running commands without dashboard check", () => {
      useGameStore.getState().addScoringEvent({
        type: "penalty",
        dimension: "safety",
        points: 5,
        reason: "Ran commands without checking dashboard first",
        timestamp: Date.now(),
      });
      useGameStore.getState().recalculateScore();

      expect(useGameStore.getState().score.safety).toBe(0);
    });

    it("penalizes running commands during reading phase", () => {
      useGameStore.getState().addScoringEvent({
        type: "penalty",
        dimension: "documentation",
        points: 3,
        reason: "Ran commands during Reading phase",
        timestamp: Date.now(),
      });
      useGameStore.getState().recalculateScore();

      expect(useGameStore.getState().score.documentation).toBe(0);
    });
  });
});
