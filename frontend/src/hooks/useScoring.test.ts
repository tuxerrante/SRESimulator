import { describe, expect, it, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useGameStore } from "@/stores/gameStore";
import { useScoring } from "./useScoring";

describe("useScoring hook", () => {
  beforeEach(() => {
    useGameStore.getState().resetGame();
  });

  describe("checkDashboardAccess", () => {
    it("awards safety bonus on first dashboard check", () => {
      const { result } = renderHook(() => useScoring());

      act(() => {
        result.current.checkDashboardAccess();
      });

      const state = useGameStore.getState();
      expect(state.checkedDashboard).toBe(true);
      expect(state.scoringEvents).toHaveLength(1);
      expect(state.scoringEvents[0].type).toBe("bonus");
      expect(state.scoringEvents[0].dimension).toBe("safety");
      expect(state.scoringEvents[0].points).toBe(5);
      expect(state.score.safety).toBe(5);
    });

    it("does not award duplicate bonus on repeated dashboard check", () => {
      const { result } = renderHook(() => useScoring());

      act(() => {
        result.current.checkDashboardAccess();
      });
      act(() => {
        result.current.checkDashboardAccess();
      });

      expect(useGameStore.getState().scoringEvents).toHaveLength(1);
    });
  });

  describe("penalizePhaseSkip", () => {
    it("penalizes skipping from reading to action", () => {
      const { result } = renderHook(() => useScoring());

      act(() => {
        result.current.penalizePhaseSkip("action");
      });

      const state = useGameStore.getState();
      expect(state.scoringEvents).toHaveLength(1);
      expect(state.scoringEvents[0].type).toBe("penalty");
      expect(state.scoringEvents[0].dimension).toBe("documentation");
      expect(state.scoringEvents[0].points).toBe(5);
      expect(state.score.documentation).toBe(0);
    });

    it("does not penalize advancing to the next adjacent phase", () => {
      const { result } = renderHook(() => useScoring());

      act(() => {
        result.current.penalizePhaseSkip("context");
      });

      expect(useGameStore.getState().scoringEvents).toHaveLength(0);
    });

    it("does not penalize moving to same phase", () => {
      const { result } = renderHook(() => useScoring());

      act(() => {
        result.current.penalizePhaseSkip("reading");
      });

      expect(useGameStore.getState().scoringEvents).toHaveLength(0);
    });
  });

  describe("penalizeUnsafeAction", () => {
    it("deducts safety points with a reason", () => {
      useGameStore.getState().addScoringEvent({
        type: "bonus",
        dimension: "safety",
        points: 10,
        reason: "setup",
        timestamp: Date.now(),
      });
      useGameStore.getState().recalculateScore();

      const { result } = renderHook(() => useScoring());

      act(() => {
        result.current.penalizeUnsafeAction("Ran destructive command");
      });

      const state = useGameStore.getState();
      expect(state.scoringEvents).toHaveLength(2);
      expect(state.scoringEvents[1].dimension).toBe("safety");
      expect(state.score.safety).toBe(5);
    });
  });

  describe("awardAccuracy", () => {
    it("awards accuracy bonus with custom points", () => {
      const { result } = renderHook(() => useScoring());

      act(() => {
        result.current.awardAccuracy(8, "Correct root cause");
      });

      const state = useGameStore.getState();
      expect(state.scoringEvents).toHaveLength(1);
      expect(state.scoringEvents[0].type).toBe("bonus");
      expect(state.scoringEvents[0].dimension).toBe("accuracy");
      expect(state.scoringEvents[0].points).toBe(8);
      expect(state.score.accuracy).toBe(8);
    });
  });

  describe("commandCount", () => {
    it("reflects terminal entries from the store", () => {
      const { result } = renderHook(() => useScoring());
      expect(result.current.commandCount).toBe(0);

      act(() => {
        useGameStore.getState().addTerminalEntry({
          id: "t1",
          command: "oc get nodes",
          output: "...",
          timestamp: Date.now(),
          exitCode: 0,
          type: "oc",
        });
      });

      expect(result.current.commandCount).toBe(1);
    });
  });
});
